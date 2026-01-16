import { Router, Request, Response } from "express";
import * as crypto from "crypto";
import {
  AuthBackend,
  AuthorizationCode,
  OIDCProviderConfig,
  OIDCProviderStores,
} from "../types";
import { SessionStore } from "@/auth/types";

const defaultLoginTemplate = (
  error?: string,
  loginHint?: string,
  providers?: Array<{ name: string; authUrl: string }>
): string => `
<!DOCTYPE html>
<html>
<head>
  <title>Sign In</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; margin: 0; background: #f5f5f5; }
    .container { width: 100%; max-width: 400px; padding: 2rem; background: white; border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.1); }
    h1 { margin: 0 0 1.5rem; text-align: center; color: #333; }
    .error { background: #fee; border: 1px solid #fcc; color: #c00; padding: 0.75rem; border-radius: 4px; margin-bottom: 1rem; }
    form { display: flex; flex-direction: column; gap: 1rem; }
    label { font-weight: 500; color: #333; }
    input { width: 100%; padding: 0.75rem; border: 1px solid #ddd; border-radius: 4px; font-size: 1rem; }
    input:focus { outline: none; border-color: #007bff; }
    button { padding: 0.75rem; background: #007bff; color: white; border: none; border-radius: 4px; font-size: 1rem; cursor: pointer; }
    button:hover { background: #0056b3; }
    .divider { display: flex; align-items: center; margin: 1.5rem 0; color: #666; }
    .divider::before, .divider::after { content: ''; flex: 1; border-bottom: 1px solid #ddd; }
    .divider span { padding: 0 1rem; }
    .providers { display: flex; flex-direction: column; gap: 0.5rem; }
    .provider { display: block; padding: 0.75rem; text-align: center; border: 1px solid #ddd; border-radius: 4px; text-decoration: none; color: #333; }
    .provider:hover { background: #f5f5f5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>Sign In</h1>
    ${error ? `<div class="error">${error}</div>` : ""}
    <form method="POST">
      <div>
        <label for="email">Email</label>
        <input type="email" id="email" name="email" value="${loginHint ?? ""}" required autofocus />
      </div>
      <div>
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required />
      </div>
      <button type="submit">Sign In</button>
    </form>
    ${
      providers && providers.length > 0
        ? `
    <div class="divider"><span>or continue with</span></div>
    <div class="providers">
      ${providers.map((p) => `<a href="${p.authUrl}" class="provider">${p.name}</a>`).join("")}
    </div>
    `
        : ""
    }
  </div>
</body>
</html>
`;

interface LoginHandlerConfig {
  config: OIDCProviderConfig;
  stores: OIDCProviderStores;
  backends: AuthBackend[];
  sessionStore: SessionStore;
}

export const createLoginHandler = ({
  config,
  stores,
  backends,
  sessionStore,
}: LoginHandlerConfig): Router => {
  const router = Router();

  const emailPasswordBackend = backends.find((b) => b.name === "email-password");
  const externalProviders = backends.flatMap((b) => b.getExternalProviders?.() ?? []);

  router.get("/", async (req: Request, res: Response) => {
    const interactionId = req.query.interaction as string;

    if (!interactionId) {
      return res.status(400).send("Missing interaction parameter");
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction) {
      return res.status(400).send("Invalid or expired interaction");
    }

    if (config.ui?.customLoginHandler) {
      return config.ui.customLoginHandler(req, res, interaction);
    }

    const template =
      config.ui?.templates?.login ??
      defaultLoginTemplate(
        undefined,
        interaction.authRequest.loginHint,
        externalProviders.map((p) => ({
          ...p,
          authUrl: `${p.authUrl}?interaction=${interactionId}`,
        }))
      );

    res.send(template);
  });

  router.post("/", async (req: Request, res: Response) => {
    const interactionId = req.query.interaction as string;

    if (!interactionId) {
      return res.status(400).send("Missing interaction parameter");
    }

    const interaction = await stores.interactions.get(interactionId);
    if (!interaction) {
      return res.status(400).send("Invalid or expired interaction");
    }

    if (!emailPasswordBackend) {
      return res.status(400).send("Email/password authentication not configured");
    }

    const result = await emailPasswordBackend.authenticate(req, res);

    if (!result.success || !result.user) {
      const template =
        config.ui?.templates?.login ??
        defaultLoginTemplate(
          result.error ?? "Invalid credentials",
          req.body.email,
          externalProviders.map((p) => ({
            ...p,
            authUrl: `${p.authUrl}?interaction=${interactionId}`,
          }))
        );
      return res.status(401).send(template);
    }

    const sessionId = crypto.randomUUID();
    await sessionStore.set(
      sessionId,
      {
        id: sessionId,
        userId: result.user.id,
        createdAt: new Date(),
        expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        data: { amr: result.amr },
      },
      24 * 60 * 60 * 1000
    );

    res.cookie("oidc_session", sessionId, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
      maxAge: 24 * 60 * 60 * 1000,
      path: "/",
    });

    if (config.hooks?.onUserAuthenticated) {
      await config.hooks.onUserAuthenticated(result.user, "email-password");
    }

    await stores.interactions.delete(interactionId);

    const authRequest = interaction.authRequest;
    const requestedScopes = authRequest.scope.split(" ");
    const existingConsent = await stores.consent.get(result.user.id, authRequest.clientId);
    const needsConsent =
      !existingConsent || !requestedScopes.every((s) => existingConsent.scopes.includes(s));

    if (needsConsent) {
      const newInteractionId = crypto.randomUUID();
      await stores.interactions.set(newInteractionId, {
        authRequest,
        userId: result.user.id,
        expiresAt: Date.now() + 10 * 60 * 1000,
      });

      const consentUrl = new URL(
        config.ui?.consentPath ?? "/consent",
        config.baseUrl ?? config.issuer
      );
      consentUrl.searchParams.set("interaction", newInteractionId);
      return res.redirect(consentUrl.toString());
    }

    const code = crypto.randomBytes(32).toString("hex");
    const authCode: AuthorizationCode = {
      code,
      clientId: authRequest.clientId,
      userId: result.user.id,
      redirectUri: authRequest.redirectUri,
      scope: authRequest.scope,
      nonce: authRequest.nonce,
      codeChallenge: authRequest.codeChallenge,
      codeChallengeMethod: authRequest.codeChallengeMethod,
      authTime: result.authTime ?? Math.floor(Date.now() / 1000),
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
