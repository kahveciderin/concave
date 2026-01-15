import {
  OfflineMutation,
  OfflineConfig,
  OfflineStorage,
} from "./types";
import { v4 as uuidv4 } from "uuid";

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
      this.mutations[index] = { ...this.mutations[index], ...update };
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

export interface OfflineManagerConfig {
  config: OfflineConfig;
  onMutationSync?: (mutation: OfflineMutation) => Promise<void>;
  onMutationFailed?: (mutation: OfflineMutation, error: Error) => void;
  onSyncComplete?: () => void;
}

export class OfflineManager {
  private storage: OfflineStorage;
  private config: OfflineConfig;
  private syncInProgress = false;
  private isOnline = true;
  private onMutationSync?: (mutation: OfflineMutation) => Promise<void>;
  private onMutationFailed?: (mutation: OfflineMutation, error: Error) => void;
  private onSyncComplete?: () => void;

  constructor(managerConfig: OfflineManagerConfig) {
    this.config = managerConfig.config;
    this.storage = managerConfig.config.storage ?? new InMemoryOfflineStorage();
    this.onMutationSync = managerConfig.onMutationSync;
    this.onMutationFailed = managerConfig.onMutationFailed;
    this.onSyncComplete = managerConfig.onSyncComplete;

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
    objectId?: string
  ): Promise<string> {
    const mutation: OfflineMutation = {
      id: uuidv4(),
      type,
      resource,
      data,
      objectId,
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await this.storage.addMutation(mutation);

    if (this.isOnline) {
      this.syncPendingMutations();
    }

    return mutation.id;
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
          await this.onMutationSync(mutation);
          await this.storage.removeMutation(mutation.id);
        } catch (error) {
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
  }

  getIsOnline(): boolean {
    return this.isOnline;
  }
}

export const createOfflineManager = (config: OfflineManagerConfig): OfflineManager => {
  return new OfflineManager(config);
};
