import { ClientConfig, ResourceClient, OfflineConfig } from "./types";
import { createTransport, Transport, FetchTransport, TransportError } from "./transport";
import { createRepository, Repository } from "./repository";
import { createOfflineManager, OfflineManager, InMemoryOfflineStorage, LocalStorageOfflineStorage } from "./offline";
import { createSubscription, SubscriptionManager } from "./subscription-manager";

export interface ConcaveClient {
  transport: Transport;
  offline?: OfflineManager;
  resource<T extends { id: string }>(path: string): ResourceClient<T>;
  setAuthToken(token: string): void;
  clearAuthToken(): void;
}

export const createClient = (config: ClientConfig): ConcaveClient => {
  const transport = createTransport({
    baseUrl: config.baseUrl,
    headers: config.headers,
    credentials: config.credentials,
    timeout: config.timeout,
  });

  let offline: OfflineManager | undefined;

  if (config.offline?.enabled) {
    offline = createOfflineManager({
      config: config.offline,
      onMutationSync: async (mutation) => {
        // Actually perform the sync by sending to server
        switch (mutation.type) {
          case "create":
            await transport.request({
              method: "POST",
              path: mutation.resource,
              body: mutation.data,
            });
            break;
          case "update":
            await transport.request({
              method: "PATCH",
              path: `${mutation.resource}/${mutation.objectId}`,
              body: mutation.data,
            });
            break;
          case "delete":
            await transport.request({
              method: "DELETE",
              path: `${mutation.resource}/${mutation.objectId}`,
            });
            break;
        }
      },
      onMutationFailed: (mutation, error) => {
        console.error("Mutation failed:", mutation, error);
        config.onError?.(error);
      },
      onSyncComplete: config.onSyncComplete,
    });
  }

  return {
    transport,
    offline,

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
  };
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
