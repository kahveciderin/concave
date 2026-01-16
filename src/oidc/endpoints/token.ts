import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  OIDCClient,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
  TokenService,
} from "../types";

const base64UrlEncode = (buffer: Buffer): string => {
  return buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
};

interface ClientAuth {
  success: boolean;
  client?: OIDCClient;
  error?: string;
}

const authenticateClient = async (
  req: Request,
  clientStore: OIDCProviderStores["clients"]
): Promise<ClientAuth> => {
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Basic ")) {
    const decoded = Buffer.from(authHeader.slice(6), "base64").toString("utf-8");
    const [id, secret] = decoded.split(":");
    clientId = decodeURIComponent(id);
    clientSecret = decodeURIComponent(secret);
  } else {
    clientId = req.body.client_id;
    clientSecret = req.body.client_secret;
  }

  if (!clientId) {
    return { success: false, error: "client_id is required" };
  }

  const client = await clientStore.get(clientId);
  if (!client) {
    return { success: false, error: "Unknown client" };
  }

  if (client.tokenEndpointAuthMethod === "none") {
    return { success: true, client };
  }

  if (client.secret && client.secret !== clientSecret) {
    return { success: false, error: "Invalid client credentials" };
  }

  return { success: true, client };
};

interface TokenEndpointConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  tokenService: TokenService;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createTokenEndpoint = ({
  config,
  stores,
  tokenService,
  findUserById,
}: TokenEndpointConfig): Router => {
  const router = Router();

  router.post("/", async (req: Request, res: Response) => {
    const clientAuth = await authenticateClient(req, stores.clients);
    if (!clientAuth.success || !clientAuth.client) {
      return res.status(401).json({
        error: "invalid_client",
        error_description: clientAuth.error ?? "Client authentication failed",
      });
    }

    const client = clientAuth.client;
    const grantType = req.body.grant_type;

    if (grantType === "authorization_code") {
      const { code, redirect_uri, code_verifier } = req.body;

      if (!code) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "code is required",
        });
      }

      const authCode = await stores.authorizationCodes.get(code);
      if (!authCode) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Authorization code not found or expired",
        });
      }

      await stores.authorizationCodes.delete(code);

      if (authCode.clientId !== client.id) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Authorization code was not issued to this client",
        });
      }

      if (authCode.redirectUri !== redirect_uri) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "redirect_uri does not match",
        });
      }

      if (Date.now() > authCode.expiresAt) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Authorization code has expired",
        });
      }

      if (authCode.codeChallenge) {
        if (!code_verifier) {
          return res.status(400).json({
            error: "invalid_grant",
            error_description: "code_verifier is required",
          });
        }

        const method = authCode.codeChallengeMethod ?? "S256";
        let computedChallenge: string;

        if (method === "S256") {
          const hash = crypto.createHash("sha256").update(code_verifier).digest();
          computedChallenge = base64UrlEncode(hash);
        } else {
          computedChallenge = code_verifier;
        }

        if (computedChallenge !== authCode.codeChallenge) {
          return res.status(400).json({
            error: "invalid_grant",
            error_description: "Invalid code_verifier",
          });
        }
      }

      const user = await findUserById(authCode.userId);
      if (!user) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "User not found",
        });
      }

      const tokens = await tokenService.generateTokenSet({
        user,
        client,
        scope: authCode.scope,
        nonce: authCode.nonce,
        authTime: authCode.authTime,
        includeIdToken: authCode.scope.split(" ").includes("openid"),
        includeRefreshToken: authCode.scope.split(" ").includes("offline_access"),
      });

      return res.json(tokens);
    }

    if (grantType === "refresh_token") {
      const { refresh_token, scope: requestedScope } = req.body;

      if (!refresh_token) {
        return res.status(400).json({
          error: "invalid_request",
          error_description: "refresh_token is required",
        });
      }

      const refreshData = await stores.refreshTokens.get(refresh_token);
      if (!refreshData) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token not found or expired",
        });
      }

      if (refreshData.clientId !== client.id) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token was not issued to this client",
        });
      }

      if (Date.now() > refreshData.expiresAt) {
        await stores.refreshTokens.delete(refresh_token);
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "Refresh token has expired",
        });
      }

      const user = await findUserById(refreshData.userId);
      if (!user) {
        return res.status(400).json({
          error: "invalid_grant",
          error_description: "User not found",
        });
      }

      let effectiveScope = refreshData.scope;
      if (requestedScope) {
        const requestedScopes = requestedScope.split(" ");
        const originalScopes = refreshData.scope.split(" ");
        const narrowed = requestedScopes.filter((s: string) => originalScopes.includes(s));
        if (narrowed.length !== requestedScopes.length) {
          return res.status(400).json({
            error: "invalid_scope",
            error_description: "Requested scope exceeds original grant",
          });
        }
        effectiveScope = narrowed.join(" ");
      }

      if (config.tokens?.refreshToken?.rotateOnUse !== false) {
        await stores.refreshTokens.delete(refresh_token);
      }

      const tokens = await tokenService.generateTokenSet({
        user,
        client,
        scope: effectiveScope,
        includeIdToken: false,
        includeRefreshToken: true,
      });

      return res.json(tokens);
    }

    return res.status(400).json({
      error: "unsupported_grant_type",
      error_description: `Grant type '${grantType}' is not supported`,
    });
  });

  return router;
};
