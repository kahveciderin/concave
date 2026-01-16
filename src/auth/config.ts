import { AuthAdapter, SessionStore, InMemorySessionStore } from "./types";
import { PassportAdapter } from "./adapters/passport";
import { JWTAdapter, JWTConfig } from "./adapters/jwt";
import { RedisSessionStore, RedisSessionStoreOptions } from "./stores/redis";
import {
  DrizzleSessionStore,
  DrizzleSessionStoreOptions,
} from "./stores/drizzle";
import { KVAdapter } from "@/kv/types";

export type AuthMode = "session" | "jwt";

export interface SessionStoreConfig {
  type: "memory" | "redis" | "drizzle";
  redis?: Omit<RedisSessionStoreOptions, "kv"> & { kv: KVAdapter };
  drizzle?: DrizzleSessionStoreOptions;
}

export interface AuthConfigUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
  emailVerified?: Date | null;
  metadata?: Record<string, unknown>;
}

export interface AuthConfig {
  mode: AuthMode;
  jwt?: JWTConfig;
  sessionStore?: SessionStoreConfig;
  sessionTtlMs?: number;
  getUserById: (id: string) => Promise<AuthConfigUser | null>;
  validatePassword?: (
    email: string,
    password: string
  ) => Promise<AuthConfigUser | null>;
  validateApiKey?: (
    apiKey: string
  ) => Promise<{ userId: string; scopes?: string[] } | null>;
}

export const createSessionStore = (config?: SessionStoreConfig): SessionStore => {
  if (!config) {
    return new InMemorySessionStore();
  }

  switch (config.type) {
    case "redis":
      if (!config.redis?.kv) {
        throw new Error("Redis KV adapter required for redis session store");
      }
      return new RedisSessionStore(config.redis);

    case "drizzle":
      if (!config.drizzle) {
        throw new Error("Drizzle config required for drizzle session store");
      }
      return new DrizzleSessionStore(config.drizzle);

    case "memory":
    default:
      return new InMemorySessionStore();
  }
};

export const createAuthAdapter = (config: AuthConfig): AuthAdapter => {
  const sessionStore = createSessionStore(config.sessionStore);

  switch (config.mode) {
    case "jwt":
      if (!config.jwt) {
        throw new Error("JWT config required for jwt mode");
      }
      return new JWTAdapter({
        jwt: config.jwt,
        getUserById: config.getUserById,
        validatePassword: config.validatePassword,
        refreshTokenStore: sessionStore,
      });

    case "session":
    default:
      return new PassportAdapter({
        getUserById: config.getUserById,
        validatePassword: config.validatePassword,
        validateApiKey: config.validateApiKey,
        sessionStore,
        sessionTtlMs: config.sessionTtlMs,
      });
  }
};
