import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  AuthorizationCode,
  OIDCClient,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
} from "../types";

const defaultConsentTemplate = (
  client: OIDCClient,
  user: OIDCUser,
  scopes: string[]
): string => {
  const scopeDescriptions: Record<string, string> = {
    openid: "Access your user ID",
    profile: "Access your profile information (name, picture)",
    email: "Access your email address",
    offline_access: "Stay signed in (refresh tokens)",
  };

  return `
<!DOCTYPE html>
<html>
<head>
  <title>Authorize Application</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { width: 100%; max-width: 450px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { margin: 0 0 0.5rem; color: #333; }
    .subtitle { color: #666; margin-bottom: 1.5rem; }
    .client { font-weight: 600; color: #007bff; }
    .scopes { margin: 1.5rem 0; }
    .scope { display: flex; align-items: start; padding: 0.75rem; background: #f8f9fa; border-radius: 4px; margin-bottom: 0.5rem; }
    .scope-check { margin-right: 0.75rem; color: #28a745; font-size: 1.2rem; }
    .scope-text { flex: 1; }
    .scope-name { font-weight: 500; color: #333; }
    .scope-desc { font-size: 0.875rem; color: #666; }
    .buttons { display: flex; gap: 1rem; margin-top: 1.5rem; }
    button { flex: 1; padding: 0.75rem; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    .allow { background: #007bff; color: white; }
    .allow:hover { background: #0056b3; }
    .deny { background: #f5f5f5; color: #333; border: 1px solid #ddd; }
    .deny:hover { background: #e9ecef; }
    .user-info { padding: 0.75rem; background: #f8f9fa; border-radius: 4px; margin-bottom: 1rem; }
    .user-email { font-weight: 500; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Authorize Application</h1>
    <p class="subtitle"><span class="client">${client.name}</span> wants to access your account</p>

    <div class="user-info">
      Signed in as <span class="user-email">${user.email ?? user.name ?? user.id}</span>
    </div>

    <div class="scopes">
      <p><strong>This application will be able to:</strong></p>
      ${scopes
        .map(
          (scope) => `
        <div class="scope">
          <span class="scope-check">✓</span>
          <div class="scope-text">
            <div class="scope-name">${scope}</div>
            <div class="scope-desc">${scopeDescriptions[scope] ?? `Access ${scope} data`}</div>
          </div>
        </div>
      `
        )
        .join("")}
    </div>

    <form method="POST">
      <div class="buttons">
        <button type="submit" name="action" value="deny" class="deny">Deny</button>
        <button type="submit" name="action" value="allow" class="allow">Allow</button>
      </div>
    </form>
  </div>
</body>
</html>
`;
};

interface ConsentHandlerConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  findUserById: (id: string) => Promise<OIDCUser | null>;
}

export const createConsentHandler = ({
  config,
  stores,
  findUserById,
}: ConsentHandlerConfig): Router => {
  const router = Router();

  router.get("/", async (req: Request, res: Response) => {
    const interactionId = req.query.interaction as string;

    if (!interactionId) {
      return res.status(400).send("Missing interaction parameter");
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction || !interaction.userId) {
      return res.status(400).send("Invalid or expired interaction");
    }

    const client = await stores.clients.get(interaction.authRequest.clientId);
    if (!client) {
      return res.status(400).send("Unknown client");
    }

    const user = await findUserById(interaction.userId);
    if (!user) {
      return res.status(400).send("User not found");
    }

    if (config.ui?.customConsentHandler) {
      return config.ui.customConsentHandler(req, res, interaction, client, user);
    }

    const scopes = interaction.authRequest.scope.split(" ");
    const template =
      config.ui?.templates?.consent ?? defaultConsentTemplate(client, user, scopes);

    res.send(template);
  });

  router.post("/", async (req: Request, res: Response) => {
    const interactionId = req.query.interaction as string;

    if (!interactionId) {
      return res.status(400).send("Missing interaction parameter");
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction || !interaction.userId) {
      return res.status(400).send("Invalid or expired interaction");
    }

    await stores.interactions.delete(interactionId);

    const action = req.body.action;
    const authRequest = interaction.authRequest;

    if (action === "deny") {
      const redirectUrl = new URL(authRequest.redirectUri);
      redirectUrl.searchParams.set("error", "access_denied");
      redirectUrl.searchParams.set("error_description", "User denied the request");
      redirectUrl.searchParams.set("state", authRequest.state);
      return res.redirect(redirectUrl.toString());
    }

    const scopes = authRequest.scope.split(" ");
    await stores.consent.set({
      userId: interaction.userId,
      clientId: authRequest.clientId,
      scopes,
      grantedAt: Date.now(),
    });

    if (config.hooks?.onConsentGranted) {
      await config.hooks.onConsentGranted(interaction.userId, authRequest.clientId, scopes);
    }

    const code = crypto.randomBytes(32).toString("hex");
    const authCode: AuthorizationCode = {
      code,
      clientId: authRequest.clientId,
      userId: interaction.userId,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      nonce: authRequest.nonce,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      authTime: Math.floor(Date.now() / 1000),
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
