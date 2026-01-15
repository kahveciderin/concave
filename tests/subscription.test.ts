import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { Response } from "express";
import {
  createSubscription,
  removeSubscription,
  getSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  sendExistingItems,
  sendInvalidateEvent,
  getSubscriptionsForResource,
  getSubscriptionStats,
  isHandlerConnected,
  getHandlerSubscriptions,
  clearRelevantObjects,
  invalidateFilterCache,
  processChangelogEntries,
  updateSubscriptionSeq,
  getCatchupEvents,
  clearAllSubscriptions,
  addRelevantObject,
} from "@/resource/subscription";
import { changelog } from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

let kv: KVAdapter;

const createMockResponse = () => {
  const chunks: string[] = [];
  const mockRes = {
    write: vi.fn((data: string) => {
      chunks.push(data);
      return true;
    }),
    writableEnded: false,
    end: vi.fn(() => {
      mockRes.writableEnded = true;
    }),
    getChunks: () => chunks,
    getEvents: () =>
      chunks
        .filter((c) => c.startsWith("data: "))
        .map((c) => JSON.parse(c.slice(6).trim())),
  } as unknown as Response & {
    getChunks: () => string[];
    getEvents: () => any[];
  };
  return mockRes;
};

const createMockFilter = () => ({
  compile: (expr: string) => ({
    execute: (obj: Record<string, unknown>) => {
      if (!expr || expr === "*") return true;
      if (expr.includes("status==")) {
        const match = expr.match(/status=="([^"]+)"/);
        if (match) return obj.status === match[1];
      }
      if (expr.includes("age>")) {
        const match = expr.match(/age>(\d+)/);
        if (match) return (obj.age as number) > parseInt(match[1]);
      }
      return true;
    },
  }),
  convert: (expr: string) => expr,
  execute: (expr: string, obj: Record<string, unknown>) => {
    if (!expr || expr === "*") return true;
    return true;
  },
  clearCache: () => {},
});

describe("Subscription System", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test");
    await kv.connect();
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    await clearAllSubscriptions();
    await changelog.clear();
  });

  describe("Subscription Lifecycle", () => {
    it("should create a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
      });

      expect(subscriptionId).toBeDefined();
      expect(typeof subscriptionId).toBe("string");
    });

    it("should retrieve a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription).toBeDefined();
      expect(subscription?.resource).toBe("users");
      expect(subscription?.filter).toBe('status=="active"');
      expect(subscription?.authId).toBe("user-123");
    });

    it("should remove a subscription", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: null,
      });

      await removeSubscription(subscriptionId);
      const subscription = await getSubscription(subscriptionId);
      expect(subscription).toBeUndefined();
    });

    it("should track creation timestamp", async () => {
      const before = new Date();
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: null,
      });
      const after = new Date();

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.createdAt.getTime()).toBeGreaterThanOrEqual(
        before.getTime()
      );
      expect(subscription?.createdAt.getTime()).toBeLessThanOrEqual(
        after.getTime()
      );
    });

    it("should store scope filter", async () => {
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-1",
        authId: "user-123",
        scopeFilter: 'userId=="user-123"',
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.scopeFilter).toBe('userId=="user-123"');
    });

    it("should store auth expiration", async () => {
      const expiresAt = new Date(Date.now() + 3600000);
      const subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-1",
        authId: "user-123",
        authExpiresAt: expiresAt,
      });

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.authExpiresAt?.getTime()).toBe(expiresAt.getTime());
    });
  });

  describe("Handler Management", () => {
    it("should register a handler", () => {
      const mockRes = createMockResponse();
      registerHandler("handler-1", mockRes);
      expect(isHandlerConnected("handler-1")).toBe(true);
    });

    it("should detect disconnected handlers", () => {
      const mockRes = createMockResponse();
      registerHandler("handler-2", mockRes);
      mockRes.writableEnded = true;
      expect(isHandlerConnected("handler-2")).toBe(false);
    });

    it("should unregister handler and cleanup subscriptions", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-3", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-3",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-3",
        authId: null,
      });

      await unregisterHandler("handler-3");

      expect(isHandlerConnected("handler-3")).toBe(false);
      const subs = await getHandlerSubscriptions("handler-3");
      expect(subs).toHaveLength(0);
    });

    it("should return handler subscriptions", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-4", mockRes);

      const sub1 = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-4",
        authId: null,
      });

      const sub2 = await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-4",
        authId: null,
      });

      const subscriptions = await getHandlerSubscriptions("handler-4");
      expect(subscriptions).toContain(sub1);
      expect(subscriptions).toContain(sub2);
    });
  });

  describe("Event Sending", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-events", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-events",
        authId: null,
      });
    });

    it("should send existing items", async () => {
      const items = [
        { id: "1", name: "John", status: "active" },
        { id: "2", name: "Jane", status: "active" },
      ];

      await sendExistingItems(subscriptionId, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(2);
      expect(events[0].type).toBe("existing");
      expect(events[0].object.name).toBe("John");
      expect(events[1].object.name).toBe("Jane");
    });

    it("should include sequence numbers", async () => {
      const items = [{ id: "1", name: "John" }];
      await sendExistingItems(subscriptionId, items, "id");

      const events = mockRes.getEvents();
      expect(events[0].seq).toBe(1);
    });

    it("should send invalidate event", async () => {
      await sendInvalidateEvent(subscriptionId, "Test reason");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("invalidate");
      expect(events[0].reason).toBe("Test reason");
    });

    it("should track relevant object ids", async () => {
      const items = [
        { id: "1", name: "John" },
        { id: "2", name: "Jane" },
      ];

      await sendExistingItems(subscriptionId, items, "id");

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("1")).toBe(true);
      expect(subscription?.relevantObjectIds.has("2")).toBe(true);
    });

    it("should not send to ended handlers", async () => {
      mockRes.writableEnded = true;

      const items = [{ id: "1", name: "John" }];
      await sendExistingItems(subscriptionId, items, "id");

      expect(mockRes.write).not.toHaveBeenCalled();
    });
  });

  describe("Push Inserts to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-inserts", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-inserts",
        authId: null,
      });
    });

    it("should push matching inserts", async () => {
      const items = [{ id: "1", name: "John", status: "active" }];

      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("added");
      expect(events[0].object.name).toBe("John");
    });

    it("should not push non-matching inserts", async () => {
      const items = [{ id: "1", name: "John", status: "inactive" }];

      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should not push to different resources", async () => {
      const items = [{ id: "1", name: "John", status: "active" }];

      await pushInsertsToSubscriptions("posts", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should handle expired auth", async () => {
      const expiredSubId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-inserts",
        authId: "user-123",
        authExpiresAt: new Date(Date.now() - 1000),
      });

      const items = [{ id: "1", name: "John", status: "active" }];
      await pushInsertsToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      const invalidateEvent = events.find((e) => e.type === "invalidate");
      expect(invalidateEvent).toBeDefined();
    });
  });

  describe("Push Updates to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-updates", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-updates",
        authId: null,
      });

      // Add relevant object via KV
      await addRelevantObject(subscriptionId, "1");
    });

    it("should send changed event for matching update", async () => {
      const items = [{ id: "1", name: "Updated John", status: "active" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "changed")).toBe(true);
    });

    it("should send added event when item enters filter", async () => {
      // Item "2" is not yet relevant
      const items = [{ id: "2", name: "New Match", status: "active" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "added")).toBe(true);
    });

    it("should send removed event when item leaves filter", async () => {
      const items = [{ id: "1", name: "John", status: "inactive" }];

      await pushUpdatesToSubscriptions("users", mockFilter as any, items, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "removed")).toBe(true);
    });

    it("should include previous object reference", async () => {
      const items = [{ id: "1", name: "Updated", status: "active" }];
      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set("1", { id: "1", name: "Original", status: "active" });

      await pushUpdatesToSubscriptions(
        "users",
        mockFilter as any,
        items,
        "id",
        previousMap
      );

      const events = mockRes.getEvents();
      const changedEvent = events.find((e) => e.type === "changed");
      expect(changedEvent?.previousObjectId).toBe("1");
    });
  });

  describe("Push Deletes to Subscriptions", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-deletes", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-deletes",
        authId: null,
      });

      // Add relevant objects via KV
      await addRelevantObject(subscriptionId, "1");
      await addRelevantObject(subscriptionId, "2");
    });

    it("should send removed events for deleted items", async () => {
      await pushDeletesToSubscriptions("users", ["1"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("removed");
      expect(events[0].objectId).toBe("1");
    });

    it("should not send removed for non-relevant items", async () => {
      await pushDeletesToSubscriptions("users", ["999"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(0);
    });

    it("should remove from relevant objects set", async () => {
      await pushDeletesToSubscriptions("users", ["1"]);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.has("1")).toBe(false);
      expect(subscription?.relevantObjectIds.has("2")).toBe(true);
    });

    it("should handle multiple deletes", async () => {
      await pushDeletesToSubscriptions("users", ["1", "2"]);

      const events = mockRes.getEvents();
      expect(events).toHaveLength(2);
    });
  });

  describe("Subscription Queries", () => {
    beforeEach(async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-query", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-query",
        authId: null,
      });

      await createSubscription({
        resource: "users",
        filter: 'status=="active"',
        handlerId: "handler-query",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-query",
        authId: null,
      });
    });

    it("should get subscriptions for resource", async () => {
      const userSubs = await getSubscriptionsForResource("users");
      expect(userSubs).toHaveLength(2);

      const postSubs = await getSubscriptionsForResource("posts");
      expect(postSubs).toHaveLength(1);
    });

    it("should return empty for unknown resource", async () => {
      const subs = await getSubscriptionsForResource("unknown");
      expect(subs).toHaveLength(0);
    });
  });

  describe("Subscription Stats", () => {
    beforeEach(async () => {
      const mockRes1 = createMockResponse();
      const mockRes2 = createMockResponse();
      registerHandler("handler-stats-1", mockRes1);
      registerHandler("handler-stats-2", mockRes2);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-stats-1",
        authId: null,
      });

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-stats-2",
        authId: null,
      });

      await createSubscription({
        resource: "posts",
        filter: "",
        handlerId: "handler-stats-1",
        authId: null,
      });
    });

    it("should return correct stats", async () => {
      const stats = await getSubscriptionStats();

      expect(stats.totalSubscriptions).toBeGreaterThanOrEqual(3);
      expect(stats.totalHandlers).toBeGreaterThanOrEqual(2);
      expect(stats.subscriptionsByResource["users"]).toBeGreaterThanOrEqual(2);
      expect(stats.subscriptionsByResource["posts"]).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Subscription Utilities", () => {
    let subscriptionId: string;

    beforeEach(async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-utils", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-utils",
        authId: null,
      });

      // Add relevant objects via KV
      await addRelevantObject(subscriptionId, "1");
      await addRelevantObject(subscriptionId, "2");
    });

    it("should clear relevant objects", async () => {
      await clearRelevantObjects(subscriptionId);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.relevantObjectIds.size).toBe(0);
    });

    it("should invalidate filter cache", () => {
      invalidateFilterCache(subscriptionId);
    });

    it("should update subscription sequence", async () => {
      await updateSubscriptionSeq(subscriptionId, 100);

      const subscription = await getSubscription(subscriptionId);
      expect(subscription?.lastSeq).toBe(100);
    });
  });

  describe("Changelog Integration", () => {
    let mockRes: ReturnType<typeof createMockResponse>;
    let subscriptionId: string;
    const mockFilter = createMockFilter();

    beforeEach(async () => {
      mockRes = createMockResponse();
      registerHandler("handler-changelog", mockRes);
      subscriptionId = await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-changelog",
        authId: null,
      });
    });

    it("should process create changelog entries", async () => {
      const entries = [
        {
          seq: 1,
          resource: "users",
          type: "create" as const,
          objectId: "1",
          object: { id: "1", name: "John", status: "active" },
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "added")).toBe(true);
    });

    it("should process update changelog entries", async () => {
      // Add relevant object first
      await addRelevantObject(subscriptionId, "1");

      const entries = [
        {
          seq: 2,
          resource: "users",
          type: "update" as const,
          objectId: "1",
          object: { id: "1", name: "Updated", status: "active" },
          previousObject: { id: "1", name: "Original", status: "active" },
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "changed")).toBe(true);
    });

    it("should process delete changelog entries", async () => {
      // Add relevant object first
      await addRelevantObject(subscriptionId, "1");

      const entries = [
        {
          seq: 3,
          resource: "users",
          type: "delete" as const,
          objectId: "1",
          timestamp: Date.now(),
        },
      ];

      await processChangelogEntries(entries, mockFilter as any, "id");

      const events = mockRes.getEvents();
      expect(events.some((e) => e.type === "removed")).toBe(true);
    });

    it("should get catchup events", async () => {
      await changelog.clear();

      for (let i = 1; i <= 5; i++) {
        await changelog.append({
          resource: "users",
          type: "create",
          objectId: String(i),
          object: { id: String(i) },
          timestamp: Date.now(),
        });
      }

      const events = await getCatchupEvents(subscriptionId, 2);
      expect(events).toBeDefined();
      expect(events?.length).toBeGreaterThan(0);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent subscription creation", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-concurrent", mockRes);

      const promises = Array.from({ length: 10 }, (_, i) =>
        createSubscription({
          resource: "users",
          filter: "",
          handlerId: "handler-concurrent",
          authId: `user-${i}`,
        })
      );

      const ids = await Promise.all(promises);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(10);
    });

    it("should handle concurrent event pushing", async () => {
      const mockRes = createMockResponse();
      registerHandler("handler-concurrent-push", mockRes);

      await createSubscription({
        resource: "users",
        filter: "",
        handlerId: "handler-concurrent-push",
        authId: null,
      });

      const mockFilter = createMockFilter();
      const promises = Array.from({ length: 10 }, (_, i) =>
        pushInsertsToSubscriptions(
          "users",
          mockFilter as any,
          [{ id: String(i), name: `User ${i}` }],
          "id"
        )
      );

      await Promise.all(promises);

      const events = mockRes.getEvents();
      expect(events.length).toBeGreaterThan(0);
    });
  });
});
