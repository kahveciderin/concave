import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  AuthBackend,
  AuthBackendResult,
  FederatedProvider,
  OIDCDiscoveryDocument,
  OIDCUser,
  StateStore,
} from "../types";

const base64UrlEncode = (buffer: Buffer): string => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

const discoveryCache = new Map<string, { doc: OIDCDiscoveryDocument; expiresAt: number }>();

const fetchDiscovery = async (issuer: string): Promise<OIDCDiscoveryDocument> => {
  const cached = discoveryCache.get(issuer);
  if (cached && Date.now() < cached.expiresAt) {
    return cached.doc;
  }

  const url = issuer.endsWith("/")
    ? `${issuer}.well-known/openid-configuration`
    : `${issuer}/.well-known/openid-configuration`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch OIDC discovery document from ${url}`);
  }

  const doc = (await response.json()) as OIDCDiscoveryDocument;
  discoveryCache.set(issuer, { doc, expiresAt: Date.now() + 3600000 });

  return doc;
};

interface FederatedBackendConfig {
  providers: FederatedProvider[];
  baseUrl: string;
  stateStore: StateStore;
  findUserByAccount: (provider: string, providerAccountId: string) => Promise<OIDCUser | null>;
  createUser: (userInfo: Record<string, unknown>, provider: string) => Promise<OIDCUser>;
  linkAccount?: (userId: string, provider: string, providerAccountId: string) => Promise<void>;
}

export const createFederatedBackend = (config: FederatedBackendConfig): AuthBackend => {
  const providerMap = new Map<string, FederatedProvider>();
  for (const provider of config.providers) {
    providerMap.set(provider.name, provider);
  }

  return {
    name: "federated",

    async authenticate(_req: unknown, _res: unknown): Promise<AuthBackendResult> {
      return { success: false, error: "Use handleExternalCallback for federated auth" };
    },

    getExternalProviders() {
      return config.providers.map((p) => ({
        name: p.name,
        authUrl: `/auth/federated/${p.name}`,
      }));
    },

    async initiateExternalAuth(providerName: string, req: unknown, res: unknown): Promise<void> {
      const request = req as Request;
      const response = res as Response;

      const provider = providerMap.get(providerName);
      if (!provider) {
        response.status(400).json({ error: `Unknown provider: ${providerName}` });
        return;
      }

      const discovery = await fetchDiscovery(provider.issuer);

      const state = crypto.randomUUID();
      const nonce = crypto.randomUUID();
      const codeVerifier = base64UrlEncode(crypto.randomBytes(32));
      const codeChallenge = base64UrlEncode(
        crypto.createHash("sha256").update(codeVerifier).digest()
      );

      const interactionId = request.query.interaction as string | undefined;

      await config.stateStore.set(state, {
        provider: providerName,
        nonce,
        codeVerifier,
        returnTo: interactionId ? `/login?interaction=${interactionId}` : undefined,
      });

      const authUrl = new URL(discovery.authorization_endpoint);
      authUrl.searchParams.set("client_id", provider.clientId);
      authUrl.searchParams.set("redirect_uri", `${config.baseUrl}/auth/federated/callback`);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set(
        "scope",
        (provider.scopes ?? ["openid", "email", "profile"]).join(" ")
      );
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("nonce", nonce);
      authUrl.searchParams.set("code_challenge", codeChallenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      response.redirect(authUrl.toString());
    },

    async handleExternalCallback(req: unknown): Promise<AuthBackendResult> {
      const request = req as Request;
      const { code, state, error, error_description } = request.query as Record<
        string,
        string | undefined
      >;

      if (error) {
        return { success: false, error: error_description ?? error };
      }

      if (!code || !state) {
        return { success: false, error: "Missing code or state parameter" };
      }

      const stateData = await config.stateStore.get(state);
      if (!stateData) {
        return { success: false, error: "Invalid or expired state" };
      }

      await config.stateStore.delete(state);

      const provider = providerMap.get(stateData.provider);
      if (!provider) {
        return { success: false, error: `Unknown provider: ${stateData.provider}` };
      }

      const discovery = await fetchDiscovery(provider.issuer);

      const tokenParams = new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: `${config.baseUrl}/auth/federated/callback`,
        client_id: provider.clientId,
        client_secret: provider.clientSecret,
        code_verifier: stateData.codeVerifier,
      });

      const tokenResponse = await fetch(discovery.token_endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: tokenParams.toString(),
      });

      if (!tokenResponse.ok) {
        const errorText = await tokenResponse.text();
        return { success: false, error: `Token exchange failed: ${errorText}` };
      }

      const tokens = (await tokenResponse.json()) as {
        access_token: string;
        id_token?: string;
      };

      const userinfoResponse = await fetch(discovery.userinfo_endpoint!, {
        headers: { Authorization: `Bearer ${tokens.access_token}` },
      });

      if (!userinfoResponse.ok) {
        return { success: false, error: "Failed to fetch user info" };
      }

      const userInfo = (await userinfoResponse.json()) as Record<string, unknown>;
      const providerAccountId = userInfo.sub as string;

      let user = await config.findUserByAccount(stateData.provider, providerAccountId);

      if (!user) {
        user = provider.mapUser
          ? await provider.mapUser(userInfo)
          : await config.createUser(userInfo, stateData.provider);

        if (config.linkAccount) {
          await config.linkAccount(user.id, stateData.provider, providerAccountId);
        }
      }

      return {
        success: true,
        user,
        authTime: Math.floor(Date.now() / 1000),
        amr: ["fed"],
        provider: stateData.provider,
      };
    },

    getRoutes() {
      const router = Router();

      router.get("/:provider", async (req: Request, res: Response) => {
        const provider = req.params.provider as string;
        await this.initiateExternalAuth!(provider, req, res);
      });

      router.get("/callback", async (req: Request, res: Response) => {
        const result = await this.handleExternalCallback!(req);

        if (!result.success) {
          return res.status(400).json({ error: result.error });
        }

        res.json({ success: true, user: result.user });
      });

      return router;
    },
  };
};
