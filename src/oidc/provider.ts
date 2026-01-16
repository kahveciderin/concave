import { Router, Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import {
  AuthBackend,
  OIDCClient,
  OIDCProviderConfig,
  OIDCProviderStores,
  OIDCUser,
  TokenService,
} from "./types";
import { createKeyManager } from "./keys";
import { createTokenService } from "./tokens";
import { generateDiscoveryDocument } from "./discovery";
import { createStores, InMemoryClientStore } from "./stores";
import {
  createAuthorizeEndpoint,
  createTokenEndpoint,
  createUserInfoEndpoint,
  createJWKSEndpoint,
  createLogoutEndpoint,
} from "./endpoints";
import { createLoginHandler, createConsentHandler } from "./ui";
import { createEmailPasswordBackend, createFederatedBackend } from "./backends";
import { InMemorySessionStore, SessionStore } from "@/auth/types";
import { UserContext } from "@/resource/types";

export interface OIDCProviderResult {
  router: Router;
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
  stores: OIDCProviderStores;
  tokenService: TokenService;
}

export const createOIDCProvider = (config: OIDCProviderConfig): OIDCProviderResult => {
  const keyManager = createKeyManager(config.keys);

  const clients: OIDCClient[] = Array.isArray(config.clients)
    ? config.clients
    : [];

  const stores = createStores(config.stores ?? { type: "memory" }, clients);

  if (Array.isArray(config.clients)) {
    for (const client of config.clients) {
      stores.clients.set(client);
    }
  }

  const tokenService = createTokenService(config, keyManager, stores.refreshTokens);

  const sessionStore: SessionStore =
    (config.stores?.sessionStore as SessionStore) ?? new InMemorySessionStore();

  const backends: AuthBackend[] = [];

  const findUserById = async (id: string): Promise<OIDCUser | null> => {
    if (config.backends.emailPassword?.findUserById) {
      return config.backends.emailPassword.findUserById(id);
    }
    return null;
  };

  if (config.backends.emailPassword?.enabled) {
    backends.push(createEmailPasswordBackend(config.backends.emailPassword));
  }

  if (config.backends.federated && config.backends.federated.length > 0) {
    backends.push(
      createFederatedBackend({
        providers: config.backends.federated,
        baseUrl: config.baseUrl ?? config.issuer,
        stateStore: stores.state,
        findUserByAccount: async (_provider: string, _providerAccountId: string) => null,
        createUser: async (userInfo: Record<string, unknown>, _provider: string) => ({
          id: userInfo.sub as string,
          email: userInfo.email as string | undefined,
          emailVerified: userInfo.email_verified as boolean | undefined,
          name: userInfo.name as string | undefined,
          givenName: userInfo.given_name as string | undefined,
          familyName: userInfo.family_name as string | undefined,
          picture: userInfo.picture as string | undefined,
        }),
      })
    );
  }

  const router = Router();

  router.use(cookieParser());
  router.use((req, res, next) => {
    if (req.is("application/x-www-form-urlencoded") || req.is("application/json")) {
      return next();
    }
    next();
  });

  router.get("/.well-known/openid-configuration", (_req: Request, res: Response) => {
    res.json(generateDiscoveryDocument(config));
  });

  router.use("/jwks", createJWKSEndpoint(keyManager));

  router.use(
    "/authorize",
    createAuthorizeEndpoint({
      config,
      stores,
      sessionStore,
      findUserById,
    })
  );

  router.use(
    "/token",
    createTokenEndpoint({
      config,
      stores,
      tokenService,
      findUserById,
    })
  );

  router.use(
    "/userinfo",
    createUserInfoEndpoint({
      config,
      tokenService,
      findUserById,
    })
  );

  router.use(
    "/logout",
    createLogoutEndpoint({
      config,
      stores,
      tokenService,
      sessionStore,
    })
  );

  router.use(
    config.ui?.loginPath ?? "/login",
    createLoginHandler({
      config,
      stores,
      backends,
      sessionStore,
    })
  );

  router.use(
    config.ui?.consentPath ?? "/consent",
    createConsentHandler({
      config,
      stores,
      findUserById,
    })
  );

  for (const backend of backends) {
    if (backend.getRoutes) {
      router.use(`/auth/${backend.name}`, backend.getRoutes() as Router);
    }
  }

  const middleware = async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return next();
    }

    const token = authHeader.slice(7);
    const validation = await tokenService.validateAccessToken(token);

    if (!validation.valid || !validation.claims) {
      res.status(401).json({
        error: "invalid_token",
        error_description: "Invalid or expired access token",
      });
      return;
    }

    const user = await findUserById(validation.claims.sub);

    (req as Request & { user?: UserContext }).user = {
      id: validation.claims.sub,
      email: user?.email ?? null,
      name: user?.name ?? null,
      image: user?.picture ?? null,
      emailVerified: user?.emailVerified ? new Date() : null,
      sessionId: validation.claims.jti,
      sessionExpiresAt: new Date(validation.claims.exp * 1000),
      metadata: user?.metadata,
    };

    next();
  };

  return {
    router,
    middleware,
    stores,
    tokenService,
  };
};
