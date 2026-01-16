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

interface MergeResult {
  type: "skip" | "merge" | "none";
  targetId?: string;
  targetMutation?: OfflineMutation;
}

const findMergeableMutation = (
  mutation: OfflineMutation,
  pending: OfflineMutation[],
  dedupeWindowMs: number = 5000
): MergeResult => {
  for (const p of pending) {
    // Skip self
    if (p.id === mutation.id) continue;

    // Skip mutations that aren't pending
    if (p.status !== "pending" && p.status !== "failed") continue;

    // Exact idempotency key match is always a duplicate - skip
    if (p.idempotencyKey === mutation.idempotencyKey) {
      return { type: "skip", targetId: p.id };
    }

    const withinWindow = p.timestamp > Date.now() - dedupeWindowMs;

    // For creates, only skip if optimisticId matches (true duplicate)
    if (mutation.type === "create") {
      if (
        p.type === "create" &&
        p.resource === mutation.resource &&
        p.optimisticId === mutation.optimisticId &&
        mutation.optimisticId !== undefined &&
        withinWindow
      ) {
        return { type: "skip", targetId: p.id };
      }
      continue;
    }

    // For updates to the same objectId, MERGE the data
    if (mutation.type === "update") {
      if (
        p.type === "update" &&
        p.resource === mutation.resource &&
        p.objectId === mutation.objectId &&
        mutation.objectId !== undefined &&
        withinWindow
      ) {
        return { type: "merge", targetId: p.id, targetMutation: p };
      }
      continue;
    }

    // For deletes, skip if there's already a pending delete for same object
    if (mutation.type === "delete") {
      if (
        p.type === "delete" &&
        p.resource === mutation.resource &&
        p.objectId === mutation.objectId &&
        mutation.objectId !== undefined &&
        withinWindow
      ) {
        return { type: "skip", targetId: p.id };
      }
      continue;
    }
  }

  return { type: "none" };
};

const isConflictError = (error: unknown): error is ConflictError => {
  if (typeof error !== "object" || error === null) return false;
  return (error as ConflictError).code === "CONFLICT";
};

/**
 * Recursively remap all optimistic IDs in a data structure to their server IDs.
 * This handles nested objects, arrays, and any depth of nesting.
 */
const remapIdsInData = (
  data: unknown,
  idMappings: Map<string, string>
): unknown => {
  if (data === null || data === undefined) {
    return data;
  }

  // Handle strings - check if it's an optimistic ID that needs remapping
  if (typeof data === "string") {
    return idMappings.get(data) ?? data;
  }

  // Handle arrays - recursively remap each element
  if (Array.isArray(data)) {
    return data.map((item) => remapIdsInData(item, idMappings));
  }

  // Handle objects - recursively remap each value
  if (typeof data === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(data)) {
      result[key] = remapIdsInData(value, idMappings);
    }
    return result;
  }

  // Return primitives (numbers, booleans) as-is
  return data;
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

    const mergeResult = findMergeableMutation(mutation, pending, dedupeWindowMs);

    if (mergeResult.type === "skip") {
      console.warn("Duplicate mutation detected, skipping:", mutation.id);
      return mutation.id;
    }

    if (mergeResult.type === "merge" && mergeResult.targetMutation) {
      // Merge update data: combine existing data with new data
      const mergedData = {
        ...((mergeResult.targetMutation.data as object) || {}),
        ...((mutation.data as object) || {}),
      };
      await this.storage.updateMutation(mergeResult.targetMutation.id, {
        data: mergedData,
        timestamp: Date.now(),
      });
      return mergeResult.targetMutation.id;
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
          // Remap optimistic IDs to server IDs before syncing
          const remappedMutation: OfflineMutation = {
            ...mutation,
            // Remap objectId if it's an optimistic ID
            objectId: mutation.objectId ? this.resolveId(mutation.objectId) : mutation.objectId,
            // Recursively remap any optimistic IDs in the data
            data: remapIdsInData(mutation.data, this.idMappings),
          };

          const result = await this.onMutationSync(remappedMutation);

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

  async hasPendingMutationsForId(objectId: string): Promise<boolean> {
    const mutations = await this.storage.getMutations();
    const resolvedId = this.resolveId(objectId);

    return mutations.some(m => {
      if (m.status !== "pending" && m.status !== "failed" && m.status !== "processing") {
        return false;
      }
      // Check if mutation is for this object
      if (m.objectId === objectId || m.objectId === resolvedId) {
        return true;
      }
      // Check if this is a create mutation with matching optimistic ID
      if (m.type === "create" && (m.optimisticId === objectId || m.optimisticId === resolvedId)) {
        return true;
      }
      return false;
    });
  }

  hasPendingMutationsForIdSync(objectId: string): boolean {
    // Synchronous version using cached mutations (for performance in tight loops)
    // This checks the in-memory idMappings for pending state
    const resolvedId = this.resolveId(objectId);
    // If the ID resolves to something different, there was a create that succeeded
    // But we still need to check for pending updates/deletes
    // Since we can't do async here, we return true to be safe if there's a mapping
    // The caller should prefer the async version when possible
    return this.idMappings.has(objectId) || objectId !== resolvedId;
  }
}

export const createOfflineManager = (config: OfflineManagerConfig): OfflineManager => {
  return new OfflineManager(config);
};
