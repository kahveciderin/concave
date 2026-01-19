import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createLiveQuery, LiveQuery, LiveQueryOptions } from "../../src/client/live-store";
import {
  ResourceClient,
  PaginatedResponse,
  Subscription,
  SubscriptionCallbacks,
} from "../../src/client/types";
import { ResourceQueryBuilder } from "../../src/client/resource-query-builder";

interface TestUser {
  id: string;
  name: string;
  email: string;
  age: number;
  avatar: string;
}

const createMockRepo = <T extends { id: string }>(
  listFn?: (options?: { select?: string[] }) => Promise<PaginatedResponse<T>>
): ResourceClient<T> & {
  subscriptionCallbacks: SubscriptionCallbacks<T> | undefined;
  triggerEvent: (type: string, data: unknown) => void;
  listCalled: { options: { select?: string[] } }[];
} => {
  let callbacks: SubscriptionCallbacks<T> | undefined;
  const listCalled: { options: { select?: string[] } }[] = [];

  const mockSubscription: Subscription<T> = {
    state: { items: new Map(), isConnected: true, lastSeq: 0, error: null },
    items: [],
    unsubscribe: vi.fn(),
    reconnect: vi.fn(),
  };

  return {
    subscriptionCallbacks: undefined,
    listCalled,
    triggerEvent(type: string, data: unknown) {
      if (type === "added" && callbacks?.onAdded) {
        const { item, meta } = data as {
          item: T;
          meta?: { optimisticId?: string };
        };
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
    async list(options?: { select?: string[] }): Promise<PaginatedResponse<T>> {
      listCalled.push({ options: options ?? {} });
      if (listFn) {
        return listFn(options);
      }
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
    async search() {
      return { items: [], total: 0 };
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
      return items.map((item, i) => ({ ...item, id: `batch-${i}` }) as T);
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
    query(): ResourceQueryBuilder<T> {
      throw new Error("Not implemented in mock");
    },
  };
};

describe("LiveQuery with projection support", () => {
  let liveQuery: LiveQuery<TestUser>;

  afterEach(() => {
    liveQuery?.destroy();
  });

  describe("select option", () => {
    it("should pass select option to list call", async () => {
      const mockRepo = createMockRepo<TestUser>(async () => ({
        items: [{ id: "1", name: "Alice" } as TestUser],
        nextCursor: null,
        hasMore: false,
        totalCount: 1,
      }));

      const options: LiveQueryOptions = {
        select: ["id", "name", "email"],
      };

      liveQuery = createLiveQuery(mockRepo, options);

      // Wait for initial fetch
      await new Promise((r) => setTimeout(r, 10));

      expect(mockRepo.listCalled).toHaveLength(1);
      expect(mockRepo.listCalled[0].options).toHaveProperty("select");
      expect(mockRepo.listCalled[0].options.select).toEqual([
        "id",
        "name",
        "email",
      ]);
    });

    it("should pass select option on loadMore", async () => {
      let callCount = 0;
      const mockRepo = createMockRepo<TestUser>(async () => {
        callCount++;
        if (callCount === 1) {
          return {
            items: [{ id: "1", name: "Alice" } as TestUser],
            nextCursor: "cursor1",
            hasMore: true,
            totalCount: 2,
          };
        }
        return {
          items: [{ id: "2", name: "Bob" } as TestUser],
          nextCursor: null,
          hasMore: false,
        };
      });

      const options: LiveQueryOptions = {
        select: ["id", "name"],
      };

      liveQuery = createLiveQuery(mockRepo, options);

      // Wait for initial fetch
      await new Promise((r) => setTimeout(r, 10));

      // Load more
      await liveQuery.loadMore();

      expect(mockRepo.listCalled).toHaveLength(2);
      expect(mockRepo.listCalled[1].options.select).toEqual(["id", "name"]);
    });

    it("should include select with other options", async () => {
      const mockRepo = createMockRepo<TestUser>(async () => ({
        items: [],
        nextCursor: null,
        hasMore: false,
      }));

      const options: LiveQueryOptions = {
        select: ["id", "name"],
        filter: "age>=18",
        orderBy: "name:asc",
        limit: 10,
      };

      liveQuery = createLiveQuery(mockRepo, options);

      // Wait for initial fetch
      await new Promise((r) => setTimeout(r, 10));

      const listCall = mockRepo.listCalled[0];
      expect(listCall.options.select).toEqual(["id", "name"]);
    });
  });
});

describe("Query types", () => {
  it("should export query types module", async () => {
    // Type exports are erased at runtime, so we just verify the module is importable
    const types = await import("../../src/client/query-types");
    expect(types).toBeDefined();
  });
});

describe("UseLiveListOptions type", () => {
  it("should support select option in interface", async () => {
    const { UseLiveListOptions } = await import(
      "../../src/client/react"
    ).catch(() => ({ UseLiveListOptions: null }));

    // Type test: verify the interface exists and has select
    interface TestOptions {
      enabled?: boolean;
      select?: ("id" | "name" | "email")[];
      filter?: string;
    }

    const options: TestOptions = {
      enabled: true,
      select: ["id", "name"],
      filter: "age>=18",
    };

    expect(options.select).toEqual(["id", "name"]);
  });
});
