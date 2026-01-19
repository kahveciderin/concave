import { ClientConfig, ResourceClient, OfflineConfig, ConcaveClient } from "./types";
import { createTransport, Transport, FetchTransport, TransportError } from "./transport";
import { createRepository, Repository } from "./repository";
import { createOfflineManager, OfflineManager, InMemoryOfflineStorage, LocalStorageOfflineStorage } from "./offline";
import { createSubscription, SubscriptionManager } from "./subscription-manager";
import { getClient, setGlobalClient, getAuthErrorHandler, setAuthErrorHandler } from "./globals";
import {
  AuthManager,
  createAuthManager,
  OIDCClientConfig,
} from "./auth";

export { getClient, setGlobalClient, getAuthErrorHandler } from "./globals";
export type { ConcaveClient } from "./types";

export interface SimplifiedClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  offline?: boolean | OfflineConfig;
  onError?: (error: Error) => void;
  onSyncComplete?: () => void;
  authCheckUrl?: string;
  auth?: OIDCClientConfig;
}

export const createClient = (config: SimplifiedClientConfig): ConcaveClient => {
  const transport = createTransport({
    baseUrl: config.baseUrl,
    headers: config.headers,
    credentials: config.credentials,
    timeout: config.timeout,
  });

  const auth = createAuthManager();

  if (config.auth) {
    auth.configure(config.auth);
    auth.subscribe((state) => {
      if (state.accessToken) {
        transport.setHeader("Authorization", `Bearer ${state.accessToken}`);
      } else {
        transport.removeHeader("Authorization");
      }
    });
  }

  let offline: OfflineManager | undefined;

  const offlineConfig: OfflineConfig | undefined =
    config.offline === true
      ? { enabled: true, storage: new LocalStorageOfflineStorage("concave-mutations") }
      : config.offline === false
        ? undefined
        : config.offline;

  if (offlineConfig?.enabled) {
    offline = createOfflineManager({
      config: offlineConfig,
      onMutationSync: async (mutation) => {
        let response: { data: Record<string, unknown> };
        switch (mutation.type) {
          case "create":
            response = await transport.request({
              method: "POST",
              path: mutation.resource,
              body: mutation.data,
              headers: mutation.optimisticId ? {
                "X-Concave-Optimistic-Id": mutation.optimisticId,
                "X-Idempotency-Key": mutation.idempotencyKey,
              } : undefined,
            });
            return {
              success: true,
              serverId: (response.data as { id?: string }).id,
            };
          case "update": {
            const resolvedId = offline!.resolveId(mutation.objectId!);
            response = await transport.request({
              method: "PATCH",
              path: `${mutation.resource}/${resolvedId}`,
              body: mutation.data,
            });
            return { success: true };
          }
          case "delete": {
            const resolvedId = offline!.resolveId(mutation.objectId!);
            await transport.request({
              method: "DELETE",
              path: `${mutation.resource}/${resolvedId}`,
            });
            return { success: true };
          }
          default:
            return { success: true };
        }
      },
      onMutationFailed: (mutation, error) => {
        console.error("Mutation failed:", mutation, error);
        config.onError?.(error);
      },
      onSyncComplete: config.onSyncComplete,
      onIdRemapped: offlineConfig.onIdRemapped,
    });
  }

  const client: ConcaveClient = {
    transport,
    offline,
    auth,

    resource<T extends { id: string }>(path: string): ResourceClient<T> {
      return createRepository<T>({
        transport,
        resourcePath: path,
        offline,
      });
    },

    setAuthToken(token: string): void {
      transport.setHeader("Authorization", `Bearer ${token}`);
    },

    clearAuthToken(): void {
      transport.removeHeader("Authorization");
    },

    setAuthErrorHandler(handler: () => void): void {
      setAuthErrorHandler(handler);
    },

    async getPendingCount(): Promise<number> {
      if (!offline) return 0;
      const mutations = await offline.getPendingMutations();
      return mutations?.length ?? 0;
    },

    async checkAuth(url?: string): Promise<{ user: unknown | null; expiresAt?: Date }> {
      if (auth.isAuthenticated()) {
        const user = auth.getUser();
        return { user };
      }

      const authUrl = url ?? config.authCheckUrl ?? "/api/auth/me";
      try {
        const response = await fetch(`${config.baseUrl}${authUrl}`, {
          credentials: config.credentials ?? "include",
        });
        const data = await response.json();
        return {
          user: data.user ?? null,
          expiresAt: data.expiresAt ? new Date(data.expiresAt) : undefined,
        };
      } catch {
        return { user: null };
      }
    },
  };

  // Set as global client (HMR-safe)
  setGlobalClient(client);

  return client;
};

// HMR-safe client getter
export const getOrCreateClient = (config: SimplifiedClientConfig): ConcaveClient => {
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__concaveClient) {
    return (globalThis as Record<string, unknown>).__concaveClient as ConcaveClient;
  }
  return createClient(config);
};

// Legacy config support
export const createClientLegacy = (config: ClientConfig): ConcaveClient => {
  return createClient({
    baseUrl: config.baseUrl,
    headers: config.headers,
    credentials: config.credentials,
    timeout: config.timeout,
    offline: config.offline,
    onError: config.onError,
    onSyncComplete: config.onSyncComplete,
  });
};

export * from "./types";

export type { Transport } from "./transport";
export {
  FetchTransport,
  TransportError,
  createTransport,
} from "./transport";

export {
  Repository,
  createRepository,
} from "./repository";

export {
  OfflineManager,
  InMemoryOfflineStorage,
  LocalStorageOfflineStorage,
  createOfflineManager,
} from "./offline";

export {
  SubscriptionManager,
  createSubscription,
} from "./subscription-manager";

export {
  fetchSchema,
  generateTypes,
  createTypegenCLI,
} from "./typegen";
export type { TypegenOptions, TypegenResult } from "./typegen";

export {
  createLiveQuery,
  statusLabel,
} from "./live-store";
export type {
  LiveQuery,
  LiveQueryStatus,
  LiveQueryState,
  LiveQueryOptions,
  LiveQueryMutations,
} from "./live-store";

export {
  AuthManager,
  createAuthManager,
  OIDCClient,
  createOIDCClient,
  TokenManager,
  MemoryStorage,
  LocalStorageAdapter,
  SessionStorageAdapter,
  createTokenManager,
  AuthTransport,
  createAuthTransport,
} from "./auth";
export type {
  OIDCClientConfig,
  TokenSet,
  OIDCUserInfo,
  AuthState,
  AuthStatus,
  TokenStorage,
  OIDCDiscoveryResponse,
  TokenResponse as OIDCTokenResponse,
  PKCEChallenge,
  AuthCallbackParams,
  AuthManagerEvents,
} from "./auth";

export {
  q,
  createQueryBuilder,
  where,
  createTypedQueryBuilder,
  createFieldBuilder,
  include,
  withSelect,
  withLimit,
  withOptions,
  createIncludeBuilder,
  IncludeBuilder,
  QueryBuilderChain,
} from "./query-builder";
export type {
  QueryBuilder,
  Primitive,
  FieldBuilder,
  TypedQueryBuilder,
  IncludeOptions,
  IncludeConfig,
} from "./query-builder";

export {
  createEnvClient,
  fetchPublicEnv,
  fetchEnvSchema,
  generateEnvTypeScript,
} from "./env";
export type {
  EnvClient,
  EnvClientConfig,
  EnvSchemaField,
  PublicEnvSchema,
} from "./env";

export {
  createFileClient,
} from "./file-upload";
export type {
  FileClient,
  FileUploadOptions,
  UploadProgress,
  UploadedFile,
  PresignedUploadResponse,
  FileListOptions,
  FileListResponse,
  FileClientConfig,
} from "./file-upload";
