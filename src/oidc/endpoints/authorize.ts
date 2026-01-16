import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  AuthorizationCode,
  AuthorizationRequest,
  AuthBackend,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
} from "../types";
import { SessionStore, SessionData } from "@/auth/types";

const parseAuthorizationRequest = (
  query: Record<string, unknown>
): AuthorizationRequest | { error: string; error_description: string } => {
  const responseType = query.response_type as string;
  const clientId = query.client_id as string;
  const redirectUri = query.redirect_uri as string;
  const scope = query.scope as string;
  const state = query.state as string;

  if (!responseType) {
    return { error: "invalid_request", error_description: "response_type is required" };
  }
  if (!clientId) {
    return { error: "invalid_request", error_description: "client_id is required" };
  }
  if (!redirectUri) {
    return { error: "invalid_request", error_description: "redirect_uri is required" };
  }
  if (!scope) {
    return { error: "invalid_request", error_description: "scope is required" };
  }
  if (!state) {
    return { error: "invalid_request", error_description: "state is required" };
  }

  return {
    responseType: responseType as AuthorizationRequest["responseType"],
    clientId,
    redirectUri,
    scope,
    state,
    nonce: query.nonce as string | undefined,
    codeChallenge: query.code_challenge as string | undefined,
    codeChallengeMethod: query.code_challenge_method as "S256" | "plain" | undefined,
    prompt: query.prompt as AuthorizationRequest["prompt"],
    maxAge: query.max_age ? parseInt(query.max_age as string, 10) : undefined,
    loginHint: query.login_hint as string | undefined,
    acrValues: query.acr_values as string | undefined,
    returnTo: query.return_to as string | undefined,
  };
};

const redirectWithError = (
  res: Response,
  redirectUri: string,
  state: string,
  error: string,
  errorDescription: string
): void => {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", errorDescription);
  url.searchParams.set("state", state);
  res.redirect(url.toString());
};

const renderError = (res: Response, error: string, description: string): void => {
  res.status(400).json({ error, error_description: description });
};

interface AuthorizeEndpointConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  sessionStore?: SessionStore;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createAuthorizeEndpoint = ({
  config,
  stores,
  sessionStore,
  findUserById,
}: AuthorizeEndpointConfig): Router => {
  const router = Router();

  const extractSession = async (req: Request): Promise<{ userId: string; authTime: number } | null> => {
    const sessionId = req.cookies?.oidc_session;
    if (!sessionId || !sessionStore) return null;

    const session = await sessionStore.get(sessionId);
    if (!session) return null;

    return {
      userId: session.userId,
      authTime: Math.floor(session.createdAt.getTime() / 1000),
    };
  };

  router.get("/", async (req: Request, res: Response) => {
    const authRequest = parseAuthorizationRequest(req.query as Record<string, unknown>);

    if ("error" in authRequest) {
      return renderError(res, authRequest.error, authRequest.error_description);
    }

    const client = await stores.clients.get(authRequest.clientId);
    if (!client) {
      return renderError(res, "invalid_client", "Unknown client");
    }

    if (!client.redirectUris.includes(authRequest.redirectUri)) {
      return renderError(res, "invalid_redirect_uri", "Redirect URI not registered");
    }

    if (authRequest.responseType !== "code") {
      return redirectWithError(
        res,
        authRequest.redirectUri,
        authRequest.state,
        "unsupported_response_type",
        "Only code response type is supported"
      );
    }

    if (client.tokenEndpointAuthMethod === "none" && !authRequest.codeChallenge) {
      return redirectWithError(
        res,
        authRequest.redirectUri,
        authRequest.state,
        "invalid_request",
        "PKCE is required for public clients"
      );
    }

    if (authRequest.codeChallengeMethod && authRequest.codeChallengeMethod !== "S256") {
      return redirectWithError(
        res,
        authRequest.redirectUri,
        authRequest.state,
        "invalid_request",
        "Only S256 code challenge method is supported"
      );
    }

    const session = await extractSession(req);

    if (authRequest.prompt === "none" && !session) {
      return redirectWithError(
        res,
        authRequest.redirectUri,
        authRequest.state,
        "login_required",
        "User is not authenticated"
      );
    }

    if (authRequest.prompt === "login" || !session) {
      const interactionId = crypto.randomUUID();
      await stores.interactions.set(interactionId, {
        authRequest,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const loginUrl = new URL(config.ui?.loginPath ?? "/login", config.baseUrl ?? config.issuer);
      loginUrl.searchParams.set("interaction", interactionId);
      return res.redirect(loginUrl.toString());
    }

    const requestedScopes = authRequest.scope.split(" ");
    const existingConsent = await stores.consent.get(session.userId, authRequest.clientId);
    const needsConsent =
      !existingConsent || !requestedScopes.every((s) => existingConsent.scopes.includes(s));

    if (needsConsent && authRequest.prompt !== "consent") {
      if (authRequest.prompt === "none") {
        return redirectWithError(
          res,
          authRequest.redirectUri,
          authRequest.state,
          "consent_required",
          "User consent is required"
        );
      }

      const interactionId = crypto.randomUUID();
      await stores.interactions.set(interactionId, {
        authRequest,
        userId: session.userId,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const consentUrl = new URL(config.ui?.consentPath ?? "/consent", config.baseUrl ?? config.issuer);
      consentUrl.searchParams.set("interaction", interactionId);
      return res.redirect(consentUrl.toString());
    }

    const code = crypto.randomBytes(32).toString("hex");
    const authCode: AuthorizationCode = {
      code,
      clientId: authRequest.clientId,
      userId: session.userId,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      nonce: authRequest.nonce,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      authTime: session.authTime,
      expiresAt: Date.now() + (config.tokens?.authorizationCode?.ttlSeconds ?? 600) * 1000,
    };

    await stores.authorizationCodes.set(authCode);

    const redirectUrl = new URL(authRequest.redirectUri);
    redirectUrl.searchParams.set("code", code);
    redirectUrl.searchParams.set("state", authRequest.state);

    res.redirect(redirectUrl.toString());
  });

  return router;
};
