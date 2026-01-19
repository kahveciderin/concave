import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  ResourceQueryBuilder,
  createResourceQueryBuilder,
} from "../../src/client/resource-query-builder";
import { Transport } from "../../src/client/transport";

interface TestUser {
  id: string;
  name: string;
  email: string;
  age: number;
  role: "admin" | "user" | "guest";
  score: number;
  createdAt: string;
  deletedAt: string | null;
}

describe("ResourceQueryBuilder", () => {
  let mockTransport: Transport;
  let mockRequest: ReturnType<typeof vi.fn>;
  let builder: ResourceQueryBuilder<TestUser>;

  beforeEach(() => {
    mockRequest = vi.fn();
    mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };

    builder = new ResourceQueryBuilder<TestUser>(mockTransport, "/users");
  });

  describe("select", () => {
    it("should build query with select projection", async () => {
      mockRequest.mockResolvedValue({
        data: {
          items: [{ id: "1", name: "Alice" }],
          hasMore: false,
          nextCursor: null,
        },
      });

      const narrowedBuilder = builder.select("id", "name");
      const result = await narrowedBuilder.list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { select: "id,name" },
      });
      expect(result.items).toHaveLength(1);
    });

    it("should accumulate multiple select calls", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.select("id", "name").select("email").list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { select: "id,name,email" },
      });
    });

    it("should narrow type for get operation", async () => {
      mockRequest.mockResolvedValue({
        data: { id: "1", name: "Alice", email: "alice@test.com" },
      });

      const result = await builder.select("id", "name", "email").get("1");

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/1",
        params: { select: "id,name,email" },
      });
      expect(result).toHaveProperty("id");
      expect(result).toHaveProperty("name");
      expect(result).toHaveProperty("email");
    });
  });

  describe("filter", () => {
    it("should build query with filter", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.filter('age>=18').list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: "age>=18" },
      });
    });

    it("should combine multiple filters with AND", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.filter('age>=18').filter('role=="user"').list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: '(age>=18);(role=="user")' },
      });
    });

    it("should work with where alias", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.where('age>=18').list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: "age>=18" },
      });
    });
  });

  describe("orderBy", () => {
    it("should build query with orderBy", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.orderBy("name:asc").list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { orderBy: "name:asc" },
      });
    });

    it("should support multiple sort fields", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.orderBy("role:asc,name:desc").list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { orderBy: "role:asc,name:desc" },
      });
    });
  });

  describe("pagination", () => {
    it("should build query with limit", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: true, nextCursor: "cursor123" },
      });

      await builder.limit(10).list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { limit: 10 },
      });
    });

    it("should build query with cursor", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.cursor("cursor123").list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { cursor: "cursor123" },
      });
    });

    it("should build query with totalCount", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null, totalCount: 100 },
      });

      const result = await builder.withTotalCount().list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { totalCount: true },
      });
      expect(result.totalCount).toBe(100);
    });
  });

  describe("include", () => {
    it("should build query with include", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder.include("posts,comments").list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: { include: "posts,comments" },
      });
    });
  });

  describe("aggregations", () => {
    describe("groupBy", () => {
      it("should build aggregation with groupBy", async () => {
        mockRequest.mockResolvedValue({
          data: {
            groups: [
              { key: { role: "admin" }, count: 5 },
              { key: { role: "user" }, count: 95 },
            ],
          },
        });

        const result = await builder.groupBy("role").withCount().aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { groupBy: "role", count: true },
        });
        expect(result.groups).toHaveLength(2);
      });

      it("should support multiple groupBy fields", async () => {
        mockRequest.mockResolvedValue({
          data: { groups: [] },
        });

        await builder.groupBy("role", "age").withCount().aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { groupBy: "role,age", count: true },
        });
      });
    });

    describe("numeric aggregations", () => {
      it("should build aggregation with sum", async () => {
        mockRequest.mockResolvedValue({
          data: {
            groups: [{ key: null, sum: { age: 1000, score: 5000 } }],
          },
        });

        const result = await builder.sum("age", "score").aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { sum: "age,score" },
        });
        expect(result.groups[0]).toHaveProperty("sum");
      });

      it("should build aggregation with avg", async () => {
        mockRequest.mockResolvedValue({
          data: {
            groups: [{ key: null, avg: { age: 25 } }],
          },
        });

        const result = await builder.avg("age").aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { avg: "age" },
        });
        expect(result.groups[0]).toHaveProperty("avg");
      });

      it("should build aggregation with min", async () => {
        mockRequest.mockResolvedValue({
          data: {
            groups: [{ key: null, min: { age: 18 } }],
          },
        });

        const result = await builder.min("age").aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { min: "age" },
        });
        expect(result.groups[0]).toHaveProperty("min");
      });

      it("should build aggregation with max", async () => {
        mockRequest.mockResolvedValue({
          data: {
            groups: [{ key: null, max: { age: 65 } }],
          },
        });

        const result = await builder.max("age").aggregate();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/aggregate",
          params: { max: "age" },
        });
        expect(result.groups[0]).toHaveProperty("max");
      });
    });

    it("should combine multiple aggregation operations", async () => {
      mockRequest.mockResolvedValue({
        data: {
          groups: [
            {
              key: { role: "admin" },
              count: 5,
              avg: { age: 35 },
              sum: { score: 500 },
            },
            {
              key: { role: "user" },
              count: 95,
              avg: { age: 28 },
              sum: { score: 9500 },
            },
          ],
        },
      });

      const result = await builder
        .groupBy("role")
        .withCount()
        .avg("age")
        .sum("score")
        .aggregate();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/aggregate",
        params: {
          groupBy: "role",
          count: true,
          avg: "age",
          sum: "score",
        },
      });
      expect(result.groups).toHaveLength(2);
    });

    it("should support filter with aggregation", async () => {
      mockRequest.mockResolvedValue({
        data: { groups: [] },
      });

      await builder.filter('role=="user"').withCount().aggregate();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users/aggregate",
        params: { filter: 'role=="user"', count: true },
      });
    });
  });

  describe("terminal methods", () => {
    describe("list", () => {
      it("should return paginated response", async () => {
        mockRequest.mockResolvedValue({
          data: {
            items: [
              { id: "1", name: "Alice" },
              { id: "2", name: "Bob" },
            ],
            hasMore: true,
            nextCursor: "cursor123",
          },
        });

        const result = await builder.select("id", "name").list();

        expect(result.items).toHaveLength(2);
        expect(result.hasMore).toBe(true);
        expect(result.nextCursor).toBe("cursor123");
      });
    });

    describe("get", () => {
      it("should return single item", async () => {
        mockRequest.mockResolvedValue({
          data: { id: "1", name: "Alice", email: "alice@test.com" },
        });

        const result = await builder.select("id", "name", "email").get("1");

        expect(result).toEqual({
          id: "1",
          name: "Alice",
          email: "alice@test.com",
        });
      });
    });

    describe("first", () => {
      it("should return first item", async () => {
        mockRequest.mockResolvedValue({
          data: {
            items: [{ id: "1", name: "Alice" }],
            hasMore: false,
            nextCursor: null,
          },
        });

        const result = await builder.select("id", "name").first();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users",
          params: { select: "id,name", limit: 1 },
        });
        expect(result).toEqual({ id: "1", name: "Alice" });
      });

      it("should return null when no items", async () => {
        mockRequest.mockResolvedValue({
          data: { items: [], hasMore: false, nextCursor: null },
        });

        const result = await builder.first();

        expect(result).toBeNull();
      });
    });

    describe("count", () => {
      it("should return count", async () => {
        mockRequest.mockResolvedValue({
          data: { count: 42 },
        });

        const result = await builder.count();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/count",
          params: {},
        });
        expect(result).toBe(42);
      });

      it("should return count with filter", async () => {
        mockRequest.mockResolvedValue({
          data: { count: 10 },
        });

        const result = await builder.filter('role=="admin"').count();

        expect(mockRequest).toHaveBeenCalledWith({
          method: "GET",
          path: "/users/count",
          params: { filter: 'role=="admin"' },
        });
        expect(result).toBe(10);
      });
    });
  });

  describe("method chaining", () => {
    it("should support complex chained queries", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      await builder
        .select("id", "name", "email")
        .filter("age>=18")
        .filter('role=="user"')
        .orderBy("name:asc")
        .limit(10)
        .list();

      expect(mockRequest).toHaveBeenCalledWith({
        method: "GET",
        path: "/users",
        params: {
          select: "id,name,email",
          filter: '(age>=18);(role=="user")',
          orderBy: "name:asc",
          limit: 10,
        },
      });
    });

    it("should be immutable (not modify original builder)", async () => {
      mockRequest.mockResolvedValue({
        data: { items: [], hasMore: false, nextCursor: null },
      });

      const baseBuilder = builder.filter("age>=18");
      const withRole = baseBuilder.filter('role=="admin"');
      const withLimit = baseBuilder.limit(10);

      await withRole.list();
      expect(mockRequest).toHaveBeenLastCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: '(age>=18);(role=="admin")' },
      });

      await withLimit.list();
      expect(mockRequest).toHaveBeenLastCalledWith({
        method: "GET",
        path: "/users",
        params: { filter: "age>=18", limit: 10 },
      });
    });
  });

  describe("getState", () => {
    it("should return current query state", () => {
      const queryBuilder = builder
        .select("id", "name")
        .filter("age>=18")
        .orderBy("name:asc")
        .limit(10);

      const state = queryBuilder.getState();

      expect(state).toEqual({
        select: ["id", "name"],
        filter: "age>=18",
        orderBy: "name:asc",
        limit: 10,
      });
    });
  });

  describe("createResourceQueryBuilder", () => {
    it("should create a new builder instance", () => {
      const newBuilder = createResourceQueryBuilder<TestUser>(
        mockTransport,
        "/users"
      );

      expect(newBuilder).toBeInstanceOf(ResourceQueryBuilder);
    });
  });
});

describe("ResourceQueryBuilder type inference", () => {
  let mockTransport: Transport;
  let mockRequest: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockRequest = vi.fn();
    mockTransport = {
      request: mockRequest,
      createEventSource: vi.fn(),
      setHeader: vi.fn(),
      removeHeader: vi.fn(),
    };
  });

  it("should correctly narrow types with select", async () => {
    interface User {
      id: string;
      name: string;
      email: string;
      age: number;
      avatar: string;
    }

    mockRequest.mockResolvedValue({
      data: { items: [{ id: "1", name: "Alice" }], hasMore: false, nextCursor: null },
    });

    const builder = new ResourceQueryBuilder<User>(mockTransport, "/users");
    const result = await builder.select("id", "name").list();

    expect(result.items[0]).toHaveProperty("id");
    expect(result.items[0]).toHaveProperty("name");
  });

  it("should work with aggregation type narrowing", async () => {
    interface Product {
      id: string;
      name: string;
      price: number;
      quantity: number;
      category: string;
    }

    mockRequest.mockResolvedValue({
      data: {
        groups: [
          {
            key: { category: "electronics" },
            count: 10,
            sum: { price: 1000 },
            avg: { price: 100 },
          },
        ],
      },
    });

    const builder = new ResourceQueryBuilder<Product>(mockTransport, "/products");
    const result = await builder
      .groupBy("category")
      .withCount()
      .sum("price")
      .avg("price")
      .aggregate();

    expect(result.groups[0]).toHaveProperty("key");
    expect(result.groups[0]).toHaveProperty("count");
    expect(result.groups[0]).toHaveProperty("sum");
    expect(result.groups[0]).toHaveProperty("avg");
  });
});
