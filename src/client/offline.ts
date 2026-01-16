import {
  OfflineMutation,
  OfflineConfig,
  OfflineStorage,
  ConflictError,
  ResolvedMutation,
} from "./types";
import { v4 as uuidv4 } from "uuid";

export const generateIdempotencyKey = (
  type: string,
  resource: string,
  objectId?: string
): string => {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  const parts = [type, resource];
  if (objectId) {
    parts.push(objectId);
  }
  parts.push(timestamp, random);
  return parts.join("-");
};

export class InMemoryOfflineStorage implements OfflineStorage {
  private mutations: OfflineMutation[] = [];

  async getMutations(): Promise<OfflineMutation[]> {
    return [...this.mutations];
  }

  async addMutation(mutation: OfflineMutation): Promise<void> {
    this.mutations.push(mutation);
  }

  async updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void> {
    const index = this.mutations.findIndex((m) => m.id === id);
    if (index !== -1) {
      this.mutations[index] = { ...this.mutations[index]!, ...update };
    }
  }

  async removeMutation(id: string): Promise<void> {
    this.mutations = this.mutations.filter((m) => m.id !== id);
  }

  async clear(): Promise<void> {
    this.mutations = [];
  }
}

export class LocalStorageOfflineStorage implements OfflineStorage {
  private storageKey: string;

  constructor(storageKey = "concave_offline_mutations") {
    this.storageKey = storageKey;
  }

  async getMutations(): Promise<OfflineMutation[]> {
    try {
      const data = localStorage.getItem(this.storageKey);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  async addMutation(mutation: OfflineMutation): Promise<void> {
    const mutations = await this.getMutations();
    mutations.push(mutation);
    localStorage.setItem(this.storageKey, JSON.stringify(mutations));
  }

  async updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void> {
    const mutations = await this.getMutations();
    const index = mutations.findIndex((m) => m.id === id);
    if (index !== -1) {
      mutations[index] = { ...mutations[index], ...update };
      localStorage.setItem(this.storageKey, JSON.stringify(mutations));
    }
  }

  async removeMutation(id: string): Promise<void> {
    const mutations = await this.getMutations();
    const filtered = mutations.filter((m) => m.id !== id);
    localStorage.setItem(this.storageKey, JSON.stringify(filtered));
  }

  async clear(): Promise<void> {
    localStorage.removeItem(this.storageKey);
  }
}

export interface SyncResult {
  success: boolean;
  serverId?: string;
  error?: Error;
}

export interface OfflineManagerConfig {
  config: OfflineConfig;
  onMutationSync?: (mutation: OfflineMutation) => Promise<SyncResult>;
  onMutationFailed?: (mutation: OfflineMutation, error: Error) => void;
  onSyncComplete?: () => void;
  onIdRemapped?: (optimisticId: string, serverId: string) => void;
}

const isDuplicateMutation = (
  mutation: OfflineMutation,
  pending: OfflineMutation[],
  dedupeWindowMs: number = 5000
): boolean => {
  return pending.some(
    (p) =>
      p.id !== mutation.id &&
      (p.idempotencyKey === mutation.idempotencyKey ||
        (p.type === mutation.type &&
          p.resource === mutation.resource &&
          p.objectId === mutation.objectId &&
          p.timestamp > Date.now() - dedupeWindowMs))
  );
};

const isConflictError = (error: unknown): error is ConflictError => {
  if (typeof error !== "object" || error === null) return false;
  return (error as ConflictError).code === "CONFLICT";
};

export class OfflineManager {
  private storage: OfflineStorage;
  private config: OfflineConfig;
  private syncInProgress = false;
  private isOnline = true;
  private onMutationSync?: (mutation: OfflineMutation) => Promise<SyncResult>;
  private onMutationFailed?: (mutation: OfflineMutation, error: Error) => void;
  private onSyncComplete?: () => void;
  private onIdRemapped?: (optimisticId: string, serverId: string) => void;
  private idMappings: Map<string, string> = new Map();

  constructor(managerConfig: OfflineManagerConfig) {
    this.config = managerConfig.config;
    this.storage = managerConfig.config.storage ?? new InMemoryOfflineStorage();
    this.onMutationSync = managerConfig.onMutationSync;
    this.onMutationFailed = managerConfig.onMutationFailed;
    this.onSyncComplete = managerConfig.onSyncComplete;
    this.onIdRemapped = managerConfig.onIdRemapped ?? this.config.onIdRemapped;

    if (typeof window !== "undefined") {
      window.addEventListener("online", () => this.handleOnline());
      window.addEventListener("offline", () => this.handleOffline());
      this.isOnline = navigator.onLine;
    }
  }

  private handleOnline(): void {
    this.isOnline = true;
    this.syncPendingMutations();
  }

  private handleOffline(): void {
    this.isOnline = false;
  }

  async queueMutation(
    type: "create" | "update" | "delete",
    resource: string,
    data?: unknown,
    objectId?: string,
    optimisticId?: string
  ): Promise<string> {
    const mutation: OfflineMutation = {
      id: uuidv4(),
      idempotencyKey: generateIdempotencyKey(type, resource, objectId),
      type,
      resource,
      data,
      objectId,
      optimisticId: type === "create" ? (optimisticId ?? uuidv4()) : undefined,
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    const pending = await this.storage.getMutations();
    const dedupeWindowMs = this.config.dedupeWindowMs ?? 5000;

    if (isDuplicateMutation(mutation, pending, dedupeWindowMs)) {
      console.warn("Duplicate mutation detected, skipping:", mutation.id);
      return mutation.id;
    }

    await this.storage.addMutation(mutation);

    if (this.isOnline) {
      this.syncPendingMutations();
    }

    return mutation.id;
  }

  private async handleConflict(
    mutation: OfflineMutation,
    error: ConflictError
  ): Promise<ResolvedMutation | "retry" | "discard"> {
    const strategy = this.config.conflictResolution ?? "server-wins";

    if (this.config.onConflict) {
      return this.config.onConflict(mutation, error.serverState, error);
    }

    switch (strategy) {
      case "server-wins":
        return "discard";
      case "client-wins":
        return { data: mutation.data, retryWith: mutation.type as "create" | "update" };
      case "manual":
        return "discard";
      default:
        return "discard";
    }
  }

  async syncPendingMutations(): Promise<void> {
    if (this.syncInProgress || !this.isOnline || !this.onMutationSync) {
      return;
    }

    this.syncInProgress = true;

    try {
      const mutations = await this.storage.getMutations();
      const pending = mutations
        .filter((m) => m.status === "pending" || m.status === "failed")
        .sort((a, b) => a.timestamp - b.timestamp);

      for (const mutation of pending) {
        if (mutation.retryCount >= (this.config.maxRetries ?? 3)) {
          continue;
        }

        await this.storage.updateMutation(mutation.id, { status: "processing" });

        try {
          const result = await this.onMutationSync(mutation);

          if (result.success) {
            if (
              mutation.type === "create" &&
              mutation.optimisticId &&
              result.serverId &&
              mutation.optimisticId !== result.serverId
            ) {
              this.idMappings.set(mutation.optimisticId, result.serverId);
              this.onIdRemapped?.(mutation.optimisticId, result.serverId);

              await this.storage.updateMutation(mutation.id, {
                serverId: result.serverId,
                status: "synced",
              });
            }

            await this.storage.removeMutation(mutation.id);
          } else if (result.error) {
            throw result.error;
          }
        } catch (error) {
          if (isConflictError(error)) {
            const resolution = await this.handleConflict(mutation, error);

            if (resolution === "discard") {
              await this.storage.removeMutation(mutation.id);
              continue;
            }

            if (resolution === "retry") {
              await this.storage.updateMutation(mutation.id, {
                status: "pending",
                retryCount: mutation.retryCount + 1,
              });
              continue;
            }

            const resolvedMutation: OfflineMutation = {
              ...mutation,
              data: resolution.data,
              type: resolution.retryWith ?? mutation.type,
              idempotencyKey: generateIdempotencyKey(
                resolution.retryWith ?? mutation.type,
                mutation.resource,
                mutation.objectId
              ),
              retryCount: mutation.retryCount + 1,
              status: "pending",
            };

            await this.storage.updateMutation(mutation.id, resolvedMutation);
            continue;
          }

          await this.storage.updateMutation(mutation.id, {
            status: "failed",
            retryCount: mutation.retryCount + 1,
            error: error instanceof Error ? error.message : "Unknown error",
          });

          this.onMutationFailed?.(mutation, error as Error);
        }
      }

      this.onSyncComplete?.();
    } finally {
      this.syncInProgress = false;
    }
  }

  async getPendingMutations(): Promise<OfflineMutation[]> {
    const mutations = await this.storage.getMutations();
    return mutations.filter((m) => m.status === "pending" || m.status === "failed");
  }

  async clearMutations(): Promise<void> {
    await this.storage.clear();
    this.idMappings.clear();
  }

  getIsOnline(): boolean {
    return this.isOnline;
  }

  getServerIdForOptimisticId(optimisticId: string): string | undefined {
    return this.idMappings.get(optimisticId);
  }

  resolveId(id: string): string {
    return this.idMappings.get(id) ?? id;
  }

  registerIdMapping(optimisticId: string, serverId: string): void {
    if (optimisticId !== serverId) {
      this.idMappings.set(optimisticId, serverId);
      this.onIdRemapped?.(optimisticId, serverId);
    }
  }

  getIdMappings(): Map<string, string> {
    return new Map(this.idMappings);
  }
}

export const createOfflineManager = (config: OfflineManagerConfig): OfflineManager => {
  return new OfflineManager(config);
};
