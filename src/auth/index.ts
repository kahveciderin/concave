export * from "./types";
export * from "./adapter";
export * from "./rsql";
export * from "./scope";
export * from "./middleware";
export * from "./routes";
export {
  createAuthAdapter,
  createSessionStore,
  type AuthMode,
  type AuthConfig,
  type AuthConfigUser,
  type SessionStoreConfig,
} from "./config";

export { AuthJsAdapter, createAuthJsAdapter } from "./adapters/authjs";
export { PassportAdapter, createPassportAdapter, fromPassportUser } from "./adapters/passport";
export { JWTAdapter, createJWTAdapter } from "./adapters/jwt";
export type { JWTConfig, JWTAdapterOptions, JWTPayload, JWTUser } from "./adapters/jwt";
export { OIDCAdapter, createOIDCAdapter, oidcProviders } from "./adapters/oidc";
export type {
  OIDCProviderConfig,
  OIDCAdapterOptions,
  OIDCUserInfo,
  OIDCAccount,
  OIDCUser,
} from "./adapters/oidc";

export {
  RedisSessionStore,
  createRedisSessionStore,
  DrizzleSessionStore,
  createDrizzleSessionStore,
} from "./stores";
export type {
  RedisSessionStoreOptions,
  DrizzleSessionStoreOptions,
  SessionsTableColumns,
} from "./stores";
