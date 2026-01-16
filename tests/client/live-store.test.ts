import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLiveQuery, LiveQuery } from "../../src/client/live-store";
import { ResourceClient, PaginatedResponse, Subscription, SubscriptionState, SubscriptionCallbacks } from "../../src/client/types";

// Mock resource client
const createMockRepo = <T extends { id: string }>(): ResourceClient<T> & {
  subscriptionCallbacks: SubscriptionCallbacks<T> | undefined;
  triggerEvent: (type: string, data: unknown) => void;
} => {
  let callbacks: SubscriptionCallbacks<T> | undefined;

  const mockSubscription: Subscription<T> = {
    state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
    items: [],
    unsubscribe: vi.fn(),
    reconnect: vi.fn(),
  };

  return {
    subscriptionCallbacks: undefined,
    triggerEvent(type: string, data: unknown) {
      if (type === "added" && callbacks?.onAdded) {
        const { item, meta } = data as { item: T; meta?: { optimisticId?: string } };
        callbacks.onAdded(item, meta);
      }
      if (type === "existing" && callbacks?.onExisting) {
        callbacks.onExisting(data as T);
      }
      if (type === "changed" && callbacks?.onChanged) {
        callbacks.onChanged(data as T);
      }
      if (type === "removed" && callbacks?.onRemoved) {
        callbacks.onRemoved(data as string);
      }
      if (type === "connected" && callbacks?.onConnected) {
        callbacks.onConnected(data as number);
      }
    },
    async list(): Promise<PaginatedResponse<T>> {
      return { items: [], nextCursor: null, hasMore: false };
    },
    async get(id: string): Promise<T> {
      return { id } as T;
    },
    async count(): Promise<number> {
      return 0;
    },
    async aggregate() {
      return { groups: [] };
    },
    async create(data: Omit<T, "id">): Promise<T> {
      return { ...data, id: "new-id" } as T;
    },
    async update(id: string, data: Partial<T>): Promise<T> {
      return { ...data, id } as T;
    },
    async replace(id: string, data: Omit<T, "id">): Promise<T> {
      return { ...data, id } as T;
    },
    async delete(): Promise<void> {},
    async batchCreate(items: Omit<T, "id">[]): Promise<T[]> {
      return items.map((item, i) => ({ ...item, id: `batch-${i}` } as T));
    },
    async batchUpdate(): Promise<{ count: number }> {
      return { count: 0 };
    },
    async batchDelete(): Promise<{ count: number }> {
      return { count: 0 };
    },
    subscribe(options, cbs) {
      callbacks = cbs;
      (this as any).subscriptionCallbacks = cbs;
      return mockSubscription;
    },
    async rpc() {
      return {} as any;
    },
  };
};

interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

describe("LiveStore", () => {
  describe("onExisting callback", () => {
    it("should handle existing events", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate existing event
      repo.triggerEvent("existing", { id: "1", title: "Test Todo", completed: false });

      const snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });

    it("should reconcile optimistic items with existing items via getIdMappings", async () => {
      // This test simulates the ghost todo scenario:
      // 1. Create todo optimistically while offline
      // 2. Come back online
      // 3. Offline manager syncs, creates mapping optimistic -> server
      // 4. Subscription reconnects, sends existing events
      // 5. Live store should remove optimistic item and keep server item

      const idMappings = new Map<string, string>();
      idMappings.set("optimistic_123", "server_456"); // optimistic -> server

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
      });

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate optimistic create (normally done via mutate.create)
      // We'll manually add to the cache by triggering an added event without proper reconciliation
      repo.triggerEvent("added", {
        item: { id: "optimistic_123", title: "Test Todo", completed: false },
        meta: undefined, // No optimisticId in meta since this is the optimistic item itself
      });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("optimistic_123");

      // Now simulate subscription reconnect with existing event for the server item
      repo.triggerEvent("existing", { id: "server_456", title: "Test Todo", completed: false });

      snapshot = query.getSnapshot();
      // Should have only one item - the server one
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_456");

      query.destroy();
    });

    it("should not create ghost items when added event has optimisticId meta", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Simulate optimistic create
      query.mutate.create({ title: "Test Todo", completed: false });

      await new Promise((resolve) => setTimeout(resolve, 10));

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      const optimisticId = snapshot.items[0].id;
      expect(optimisticId).toMatch(/^optimistic_/);

      // Simulate server returning the item with optimisticId in meta
      repo.triggerEvent("added", {
        item: { id: "server_789", title: "Test Todo", completed: false },
        meta: { optimisticId },
      });

      snapshot = query.getSnapshot();
      // Should have only one item - the server one
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("server_789");

      query.destroy();
    });

    it("should handle multiple existing events during reconnect", async () => {
      const idMappings = new Map<string, string>();
      idMappings.set("opt_1", "srv_1");
      idMappings.set("opt_2", "srv_2");

      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {}, {
        getIdMappings: () => idMappings,
      });

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add optimistic items
      repo.triggerEvent("added", { item: { id: "opt_1", title: "Todo 1", completed: false } });
      repo.triggerEvent("added", { item: { id: "opt_2", title: "Todo 2", completed: true } });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Simulate reconnect with existing events
      repo.triggerEvent("existing", { id: "srv_1", title: "Todo 1", completed: false });
      repo.triggerEvent("existing", { id: "srv_2", title: "Todo 2", completed: true });
      repo.triggerEvent("existing", { id: "srv_3", title: "Todo 3", completed: false }); // New item

      snapshot = query.getSnapshot();
      // Should have 3 items: srv_1, srv_2, srv_3 (not opt_1, opt_2)
      expect(snapshot.items).toHaveLength(3);
      expect(snapshot.items.map(i => i.id).sort()).toEqual(["srv_1", "srv_2", "srv_3"]);

      query.destroy();
    });
  });

  describe("offline mutation reconciliation", () => {
    it("should update item via mutate.update", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add an item
      repo.triggerEvent("existing", { id: "1", title: "Original", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(false);

      // Update optimistically
      query.mutate.update("1", { completed: true });

      snapshot = query.getSnapshot();
      expect(snapshot.items[0].completed).toBe(true);

      query.destroy();
    });

    it("should delete item via mutate.delete", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Add items
      repo.triggerEvent("existing", { id: "1", title: "Keep", completed: false });
      repo.triggerEvent("existing", { id: "2", title: "Delete", completed: false });

      let snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(2);

      // Delete optimistically
      query.mutate.delete("2");

      snapshot = query.getSnapshot();
      expect(snapshot.items).toHaveLength(1);
      expect(snapshot.items[0].id).toBe("1");

      query.destroy();
    });
  });

  describe("status transitions", () => {
    it("should transition to live or offline status after connected based on navigator.onLine", async () => {
      const repo = createMockRepo<Todo>();
      const query = createLiveQuery(repo, {});

      // Wait for init and connection
      await new Promise((resolve) => setTimeout(resolve, 10));

      repo.triggerEvent("connected", 0);

      const snapshot = query.getSnapshot();
      // Status depends on navigator.onLine - in test env it may be offline
      expect(["live", "offline"]).toContain(snapshot.status);

      query.destroy();
    });
  });
});

describe("Offline Create + Update Sync (Ghost Prevention)", () => {
  it("should NOT replace optimistic item if there are pending mutations", async () => {
    // This is the exact bug scenario:
    // 1. Offline: Create todo with optimistic ID
    // 2. Offline: Update todo (mark as checked)
    // 3. Online: Subscription reconnects, gets existing event with unchecked state
    // 4. BUG: Old code would replace checked optimistic with unchecked server state

    const idMappings = new Map<string, string>();
    idMappings.set("opt_123", "srv_456");

    // Simulate pending update mutation
    const pendingMutationIds = new Set<string>(["opt_123"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item (completed: true - user checked it while offline)
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: true },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");
    expect(snapshot.items[0].completed).toBe(true);

    // Subscription reconnects, sends existing event with SERVER state (completed: false)
    // because the update hasn't synced yet
    repo.triggerEvent("existing", { id: "srv_456", title: "Test Todo", completed: false });

    // Wait for async handleExisting
    await new Promise((resolve) => setTimeout(resolve, 10));

    snapshot = query.getSnapshot();

    // Should STILL have the optimistic item with completed: true
    // because there are pending mutations
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");
    expect(snapshot.items[0].completed).toBe(true);

    // Now simulate mutation completing - clear pending
    pendingMutationIds.clear();

    // Simulate changed event from server (after update synced)
    repo.triggerEvent("changed", { id: "srv_456", title: "Test Todo", completed: true });

    snapshot = query.getSnapshot();

    // Now should have server item with correct state
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("srv_456");
    expect(snapshot.items[0].completed).toBe(true);

    query.destroy();
  });

  it("should replace optimistic item if no pending mutations", async () => {
    const idMappings = new Map<string, string>();
    idMappings.set("opt_123", "srv_456");

    // No pending mutations
    const hasPendingMutationsForId = async () => false;

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("opt_123");

    // Existing event with server state
    repo.triggerEvent("existing", { id: "srv_456", title: "Test Todo", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 10));

    snapshot = query.getSnapshot();

    // Should have replaced with server item
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0].id).toBe("srv_456");

    query.destroy();
  });

  it("should handle offline create + delete scenario", async () => {
    // 1. Offline: Create todo
    // 2. Offline: Delete todo
    // 3. Online: Should not see the todo at all

    const idMappings = new Map<string, string>();
    // No mapping yet - create hasn't synced

    const pendingMutationIds = new Set<string>(["opt_123"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic item
    repo.triggerEvent("added", {
      item: { id: "opt_123", title: "Test Todo", completed: false },
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(1);

    // Delete optimistically
    query.mutate.delete("opt_123");

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(0);

    query.destroy();
  });

  it("should handle multiple offline creates with updates", async () => {
    // 1. Offline: Create todo 1, mark checked
    // 2. Offline: Create todo 2, mark unchecked (no change)
    // 3. Online: Both should sync correctly

    const idMappings = new Map<string, string>();
    idMappings.set("opt_1", "srv_1");
    idMappings.set("opt_2", "srv_2");

    // Only opt_1 has pending update
    const pendingMutationIds = new Set<string>(["opt_1"]);
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Add optimistic items
    repo.triggerEvent("added", {
      item: { id: "opt_1", title: "Todo 1", completed: true }, // Checked offline
    });
    repo.triggerEvent("added", {
      item: { id: "opt_2", title: "Todo 2", completed: false }, // Not changed
    });

    let snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(2);

    // Existing events from server (both unchecked initially)
    repo.triggerEvent("existing", { id: "srv_1", title: "Todo 1", completed: false });
    repo.triggerEvent("existing", { id: "srv_2", title: "Todo 2", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 20));

    snapshot = query.getSnapshot();

    // opt_1 should remain (has pending update), opt_2 should be replaced by srv_2
    const items = snapshot.items.sort((a, b) => a.title.localeCompare(b.title));
    expect(items).toHaveLength(2);

    const todo1 = items.find(i => i.title === "Todo 1");
    const todo2 = items.find(i => i.title === "Todo 2");

    // Todo 1: should keep optimistic state (completed: true)
    expect(todo1?.id).toBe("opt_1");
    expect(todo1?.completed).toBe(true);

    // Todo 2: should have server state (no pending mutations)
    expect(todo2?.id).toBe("srv_2");
    expect(todo2?.completed).toBe(false);

    query.destroy();
  });

  it("should handle rapid create/update/delete sequence", async () => {
    const idMappings = new Map<string, string>();
    const pendingMutationIds = new Set<string>();
    const hasPendingMutationsForId = async (id: string) => pendingMutationIds.has(id);

    const repo = createMockRepo<Todo>();
    const query = createLiveQuery(repo, {}, {
      getIdMappings: () => idMappings,
      hasPendingMutationsForId,
    });

    await new Promise((resolve) => setTimeout(resolve, 10));

    // Rapid sequence while offline
    query.mutate.create({ title: "Quick Todo", completed: false });

    await new Promise((resolve) => setTimeout(resolve, 5));

    let snapshot = query.getSnapshot();
    const optimisticId = snapshot.items[0]?.id;
    expect(optimisticId).toMatch(/^optimistic_/);

    // Update then delete
    query.mutate.update(optimisticId!, { completed: true });
    query.mutate.delete(optimisticId!);

    snapshot = query.getSnapshot();
    expect(snapshot.items).toHaveLength(0);

    query.destroy();
  });
});

describe("SubscriptionManager onExisting callback", () => {
  it("should call onExisting for existing events", async () => {
    const { SubscriptionManager } = await import("../../src/client/subscription-manager");
    const { FetchTransport } = await import("../../src/client/transport");

    const onExisting = vi.fn();
    const onAdded = vi.fn();

    // Mock EventSource
    const mockEventSource = {
      addEventListener: vi.fn(),
      close: vi.fn(),
      onerror: null as (() => void) | null,
    };

    const originalEventSource = globalThis.EventSource;
    globalThis.EventSource = vi.fn(() => mockEventSource) as any;

    try {
      const transport = new FetchTransport({ baseUrl: "http://localhost:3000" });

      const manager = new SubscriptionManager({
        transport,
        resourcePath: "/todos",
        idField: "id" as keyof { id: string },
        callbacks: { onExisting, onAdded },
      });

      // Find the message listener
      const messageHandler = mockEventSource.addEventListener.mock.calls.find(
        (call: unknown[]) => call[0] === "message"
      )?.[1] as ((e: MessageEvent) => void) | undefined;

      expect(messageHandler).toBeDefined();

      // Simulate existing event
      messageHandler!({
        data: JSON.stringify({
          type: "existing",
          object: { id: "1", title: "Test" },
          seq: 1,
        }),
      } as MessageEvent);

      expect(onExisting).toHaveBeenCalledWith({ id: "1", title: "Test" });
      expect(onAdded).not.toHaveBeenCalled();

      // Simulate added event
      messageHandler!({
        data: JSON.stringify({
          type: "added",
          object: { id: "2", title: "New" },
          seq: 2,
          meta: { optimisticId: "opt_2" },
        }),
      } as MessageEvent);

      expect(onAdded).toHaveBeenCalledWith({ id: "2", title: "New" }, { optimisticId: "opt_2" });

      manager.unsubscribe();
    } finally {
      globalThis.EventSource = originalEventSource;
    }
  });
});
