import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryOfflineStorage,
  LocalStorageOfflineStorage,
  OfflineManager,
  createOfflineManager,
} from "../../src/client/offline";
import { OfflineMutation } from "../../src/client/types";

describe("InMemoryOfflineStorage", () => {
  let storage: InMemoryOfflineStorage;

  beforeEach(() => {
    storage = new InMemoryOfflineStorage();
  });

  it("should start with empty mutations", async () => {
    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });

  it("should add mutation", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      data: { name: "Test" },
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    const mutations = await storage.getMutations();

    expect(mutations).toHaveLength(1);
    expect(mutations[0]).toEqual(mutation);
  });

  it("should return copy of mutations array", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    const mutations1 = await storage.getMutations();
    const mutations2 = await storage.getMutations();

    expect(mutations1).not.toBe(mutations2);
  });

  it("should update mutation", async () => {
    const mutation: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation);
    await storage.updateMutation("1", { status: "processing", retryCount: 1 });

    const mutations = await storage.getMutations();
    expect(mutations[0].status).toBe("processing");
    expect(mutations[0].retryCount).toBe(1);
  });

  it("should not fail when updating non-existent mutation", async () => {
    await expect(
      storage.updateMutation("nonexistent", { status: "failed" })
    ).resolves.toBeUndefined();
  });

  it("should remove mutation", async () => {
    const mutation1: OfflineMutation = {
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };
    const mutation2: OfflineMutation = {
      id: "2",
      type: "update",
      resource: "/users",
      objectId: "user1",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    };

    await storage.addMutation(mutation1);
    await storage.addMutation(mutation2);
    await storage.removeMutation("1");

    const mutations = await storage.getMutations();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("2");
  });

  it("should clear all mutations", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });
    await storage.addMutation({
      id: "2",
      type: "delete",
      resource: "/users",
      objectId: "1",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.clear();

    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });
});

describe("LocalStorageOfflineStorage", () => {
  let storage: LocalStorageOfflineStorage;
  let mockLocalStorage: { [key: string]: string };

  beforeEach(() => {
    mockLocalStorage = {};
    global.localStorage = {
      getItem: (key: string) => mockLocalStorage[key] ?? null,
      setItem: (key: string, value: string) => {
        mockLocalStorage[key] = value;
      },
      removeItem: (key: string) => {
        delete mockLocalStorage[key];
      },
      clear: () => {
        mockLocalStorage = {};
      },
      length: 0,
      key: () => null,
    };

    storage = new LocalStorageOfflineStorage();
  });

  it("should use default storage key", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    expect(mockLocalStorage["concave_offline_mutations"]).toBeDefined();
  });

  it("should use custom storage key", async () => {
    storage = new LocalStorageOfflineStorage("my_custom_key");

    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    expect(mockLocalStorage["my_custom_key"]).toBeDefined();
  });

  it("should return empty array for invalid JSON", async () => {
    mockLocalStorage["concave_offline_mutations"] = "invalid json";

    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });

  it("should persist mutations across instances", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      data: { name: "Test" },
      timestamp: 1234567890,
      retryCount: 0,
      status: "pending",
    });

    const newStorage = new LocalStorageOfflineStorage();
    const mutations = await newStorage.getMutations();

    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("1");
  });

  it("should update mutation and persist", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.updateMutation("1", { status: "failed", error: "Network error" });

    const mutations = await storage.getMutations();
    expect(mutations[0].status).toBe("failed");
    expect(mutations[0].error).toBe("Network error");
  });

  it("should remove mutation and persist", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });
    await storage.addMutation({
      id: "2",
      type: "update",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.removeMutation("1");

    const mutations = await storage.getMutations();
    expect(mutations).toHaveLength(1);
    expect(mutations[0].id).toBe("2");
  });

  it("should clear storage", async () => {
    await storage.addMutation({
      id: "1",
      type: "create",
      resource: "/users",
      timestamp: Date.now(),
      retryCount: 0,
      status: "pending",
    });

    await storage.clear();

    expect(mockLocalStorage["concave_offline_mutations"]).toBeUndefined();
    const mutations = await storage.getMutations();
    expect(mutations).toEqual([]);
  });
});

describe("OfflineManager", () => {
  let manager: OfflineManager;
  let mockSyncHandler: ReturnType<typeof vi.fn>;
  let mockFailedHandler: ReturnType<typeof vi.fn>;
  let mockCompleteHandler: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockSyncHandler = vi.fn().mockResolvedValue(undefined);
    mockFailedHandler = vi.fn();
    mockCompleteHandler = vi.fn();

    manager = new OfflineManager({
      config: { enabled: true, maxRetries: 3 },
      onMutationSync: mockSyncHandler,
      onMutationFailed: mockFailedHandler,
      onSyncComplete: mockCompleteHandler,
    });
  });

  describe("queueMutation", () => {
    it("should queue create mutation", async () => {
      // set offline to prevent auto-sync
      (manager as any).isOnline = false;

      const id = await manager.queueMutation("create", "/users", { name: "Test" });

      expect(id).toBeDefined();
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].type).toBe("create");
      expect(pending[0].resource).toBe("/users");
      expect(pending[0].data).toEqual({ name: "Test" });
    });

    it("should queue update mutation with objectId", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("update", "/users", { name: "Updated" }, "user123");

      const pending = await manager.getPendingMutations();
      expect(pending[0].type).toBe("update");
      expect(pending[0].objectId).toBe("user123");
    });

    it("should queue delete mutation", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("delete", "/users", undefined, "user123");

      const pending = await manager.getPendingMutations();
      expect(pending[0].type).toBe("delete");
      expect(pending[0].objectId).toBe("user123");
    });

    it("should auto-sync when online", async () => {
      await manager.queueMutation("create", "/users", { name: "Test" });

      // give sync time to run
      await new Promise((r) => setTimeout(r, 10));

      expect(mockSyncHandler).toHaveBeenCalled();
    });
  });

  describe("syncPendingMutations", () => {
    it("should sync pending mutations in order", async () => {
      // manually set offline then queue
      (manager as any).isOnline = false;

      await manager.queueMutation("create", "/users", { name: "First" });
      await manager.queueMutation("create", "/users", { name: "Second" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockSyncHandler).toHaveBeenCalledTimes(2);
      expect(mockSyncHandler.mock.calls[0][0].data.name).toBe("First");
      expect(mockSyncHandler.mock.calls[1][0].data.name).toBe("Second");
    });

    it("should remove mutation after successful sync", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });

    it("should handle sync failure", async () => {
      mockSyncHandler.mockRejectedValueOnce(new Error("Network error"));

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockFailedHandler).toHaveBeenCalled();
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("failed");
      expect(pending[0].retryCount).toBe(1);
    });

    it("should skip mutations that exceeded max retries", async () => {
      const storage = (manager as any).storage;
      await storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 3,
        status: "failed",
      });

      await manager.syncPendingMutations();

      expect(mockSyncHandler).not.toHaveBeenCalled();
    });

    it("should call onSyncComplete after sync", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      await manager.syncPendingMutations();

      expect(mockCompleteHandler).toHaveBeenCalled();
    });

    it("should not sync when already in progress", async () => {
      let resolveFirst: () => void;
      const firstPromise = new Promise<void>((r) => {
        resolveFirst = r;
      });

      mockSyncHandler.mockImplementationOnce(async () => {
        await firstPromise;
      });

      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      (manager as any).isOnline = true;
      const sync1 = manager.syncPendingMutations();
      const sync2 = manager.syncPendingMutations();

      resolveFirst!();
      await Promise.all([sync1, sync2]);

      // should only sync once
      expect(mockSyncHandler).toHaveBeenCalledTimes(1);
    });

    it("should not sync when offline", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      await manager.syncPendingMutations();

      expect(mockSyncHandler).not.toHaveBeenCalled();
    });

    it("should not sync without sync handler", async () => {
      const managerNoHandler = new OfflineManager({
        config: { enabled: true },
      });

      (managerNoHandler as any).isOnline = false;
      await (managerNoHandler as any).storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      });

      (managerNoHandler as any).isOnline = true;
      await managerNoHandler.syncPendingMutations();

      // should not throw
    });
  });

  describe("getPendingMutations", () => {
    it("should return only pending and failed mutations", async () => {
      const storage = (manager as any).storage;
      await storage.addMutation({
        id: "1",
        type: "create",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending",
      });
      await storage.addMutation({
        id: "2",
        type: "update",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 1,
        status: "failed",
      });
      await storage.addMutation({
        id: "3",
        type: "delete",
        resource: "/users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "processing",
      });

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(2);
      expect(pending.map((m) => m.id)).toContain("1");
      expect(pending.map((m) => m.id)).toContain("2");
    });
  });

  describe("clearMutations", () => {
    it("should clear all mutations", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      await manager.clearMutations();

      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(0);
    });
  });

  describe("getIsOnline", () => {
    it("should return online status", () => {
      expect(manager.getIsOnline()).toBe(true);

      (manager as any).isOnline = false;
      expect(manager.getIsOnline()).toBe(false);
    });
  });

  describe("online/offline events", () => {
    it("should handle coming online", async () => {
      (manager as any).isOnline = false;
      await manager.queueMutation("create", "/users", { name: "Test" });

      // simulate coming online
      (manager as any).handleOnline();

      await new Promise((r) => setTimeout(r, 10));

      expect(manager.getIsOnline()).toBe(true);
      expect(mockSyncHandler).toHaveBeenCalled();
    });

    it("should handle going offline", () => {
      (manager as any).handleOffline();

      expect(manager.getIsOnline()).toBe(false);
    });
  });

  describe("custom storage", () => {
    it("should use provided storage", async () => {
      const customStorage = new InMemoryOfflineStorage();
      const managerWithStorage = new OfflineManager({
        config: { enabled: true, storage: customStorage },
      });

      (managerWithStorage as any).isOnline = false;
      await managerWithStorage.queueMutation("create", "/users", { name: "Test" });

      const storageMutations = await customStorage.getMutations();
      expect(storageMutations).toHaveLength(1);
    });
  });
});

describe("createOfflineManager", () => {
  it("should create OfflineManager instance", () => {
    const manager = createOfflineManager({
      config: { enabled: true },
    });

    expect(manager).toBeDefined();
    expect(typeof manager.queueMutation).toBe("function");
    expect(typeof manager.syncPendingMutations).toBe("function");
  });
});
