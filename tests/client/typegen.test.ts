import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fetch for testing typegen
const mockSchema = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  resources: [
    {
      name: "User",
      path: "/api/users",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "name", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "email", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "age", type: { kind: "primitive", primitive: "integer" }, nullable: true },
        { name: "createdAt", type: { kind: "primitive", primitive: "datetime" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
    {
      name: "Todo",
      path: "/api/todos",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "userId", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "title", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "completed", type: { kind: "primitive", primitive: "boolean" }, nullable: false },
        { name: "position", type: { kind: "primitive", primitive: "integer" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: ["markComplete"],
    },
  ],
};

describe("Typegen", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSchema),
      });
    }));
  });

  it("should generate TypeScript types from schema", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface User {");
    expect(result.code).toContain("export interface Todo {");
    expect(result.code).toContain("id: string;");
    expect(result.code).toContain("name: string;");
    expect(result.code).toContain("email: string;");
    expect(result.code).toContain("age: number | null;");
  });

  it("should generate Input and Update types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export type UserInput =");
    expect(result.code).toContain("export type UserUpdate =");
    expect(result.code).toContain("export type TodoInput =");
    expect(result.code).toContain("export type TodoUpdate =");
  });

  it("should generate field metadata types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export type UserFields =");
    expect(result.code).toContain("export type UserNumericFields =");
    expect(result.code).toContain("export type UserComparableFields =");
    expect(result.code).toContain("export type UserStringFields =");
  });

  it("should generate ResourcePaths constants", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export const ResourcePaths = {");
    expect(result.code).toContain('"/api/api/users"');
    expect(result.code).toContain('"/api/api/todos"');
    expect(result.code).toContain("} as const;");
  });

  it("should import types from concave/client", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain('import type { ResourceClient, ConcaveClient } from "concave/client";');
  });

  it("should generate TypedResources using LiveQuery with type tracking", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface TypedResources {");
    expect(result.code).toContain("user: LiveQuery<User, {}>;");
    expect(result.code).toContain("todo: LiveQuery<Todo, {}>;");
  });

  it("should generate TypedConcaveClient extending ConcaveClient", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface TypedConcaveClient extends ConcaveClient {");
    expect(result.code).toContain("resources: TypedResources;");
  });

  it("should generate createTypedClient factory function", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export function createTypedClient(baseClient: ConcaveClient): TypedConcaveClient {");
    expect(result.code).toContain("resources: {");
    expect(result.code).toContain("user: createLiveQuery<User, {}>(baseClient, ResourcePaths.user),");
    expect(result.code).toContain("todo: createLiveQuery<Todo, {}>(baseClient, ResourcePaths.todo),");
  });

  it("should not generate duplicate ResourceQueryBuilder (uses library type)", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    // ResourceQueryBuilder should be imported from library, not generated
    expect(result.code).not.toContain("export interface ResourceQueryBuilder<");
  });

  it("should not include client types when includeClient is false", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: false,
    });

    expect(result.code).toContain("export interface User {");
    expect(result.code).toContain("export interface Todo {");
    expect(result.code).not.toContain("export const ResourcePaths =");
    expect(result.code).not.toContain("export function createTypedClient");
  });

  it("should include schema metadata in result", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.schema.resources).toHaveLength(2);
    expect(result.schema.resources[0].name).toBe("User");
    expect(result.schema.resources[1].name).toBe("Todo");
    expect(result.generatedAt).toBeDefined();
  });

  it("should generate LiveQuery interface with fluent methods", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface LiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T>");
    expect(result.code).toContain("filter(filter: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("where(filter: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("orderBy(orderBy: string): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("limit(limit: number): LiveQuery<T, Relations, Included, Selected>;");
    expect(result.code).toContain("select<K extends keyof T>(...fields: K[]): LiveQuery<T, Relations, Included, K | 'id'>;");
    expect(result.code).toContain("include<K extends keyof Relations>(...relations: K[]): LiveQuery<T, Relations, Included & Pick<Relations, K>, Selected>;");
  });

  it("should generate LiveQuery with proxied ResourceClient methods", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain('query(): ReturnType<ResourceClient<T>["query"]>;');
    expect(result.code).toContain('list(options?: Parameters<ResourceClient<T>["list"]>[0]): ReturnType<ResourceClient<T>["list"]>;');
    expect(result.code).toContain('search(query: string, options?: Parameters<ResourceClient<T>["search"]>[1]): ReturnType<ResourceClient<T>["search"]>;');
    expect(result.code).toContain('create(data: Parameters<ResourceClient<T>["create"]>[0], options?: Parameters<ResourceClient<T>["create"]>[1]): ReturnType<ResourceClient<T>["create"]>;');
  });

  it("should generate createLiveQuery function", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("function createLiveQuery<T extends { id: string }, Relations = {}, Included = {}, Selected extends keyof T = keyof T>(");
    expect(result.code).toContain("baseClient: ConcaveClient,");
    expect(result.code).toContain("const resourceClient = baseClient.resource<T>(path);");
    expect(result.code).toContain("query() { return resourceClient.query(); },");
  });
});

// Test schema with relations
const mockSchemaWithRelations = {
  version: "1.0.0",
  timestamp: new Date().toISOString(),
  resources: [
    {
      name: "Category",
      path: "/api/categories",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "name", type: { kind: "primitive", primitive: "string" }, nullable: false },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
    {
      name: "Post",
      path: "/api/posts",
      fields: [
        { name: "id", type: { kind: "primitive", primitive: "string" }, nullable: false, primaryKey: true },
        { name: "title", type: { kind: "primitive", primitive: "string" }, nullable: false },
        { name: "categoryId", type: { kind: "primitive", primitive: "string" }, nullable: true },
      ],
      relations: [
        { name: "category", type: "belongsTo", resource: "Category", foreignKey: "categoryId" },
      ],
      capabilities: {
        enableAggregations: true,
        enableBatch: true,
        enableSubscribe: true,
        enableCreate: true,
        enableUpdate: true,
        enableDelete: true,
      },
      procedures: [],
    },
  ],
};

describe("Typegen with Relations", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn((url: string) => {
      if (url.includes("/env")) {
        return Promise.reject(new Error("Env endpoint not available"));
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(mockSchemaWithRelations),
      });
    }));
  });

  it("should generate Relations interface for resources with relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface PostRelations {");
    expect(result.code).toContain("category: Category | null;");
  });

  it("should generate WithRelations and With types", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("export interface PostWithRelations extends Post {");
    expect(result.code).toContain("category?: Category | null;");
    expect(result.code).toContain("export type PostWith<K extends keyof PostRelations> = Post & { [P in K]?: PostRelations[P] };");
  });

  it("should generate TypedResources with relations type for resources that have relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("post: LiveQuery<Post, PostRelations>;");
    expect(result.code).toContain("category: LiveQuery<Category, {}>;");
  });

  it("should generate createTypedClient with relations for resources that have relations", async () => {
    const { generateTypes } = await import("../../src/client/typegen");

    const result = await generateTypes({
      serverUrl: "http://localhost:3000",
      output: "typescript",
      includeClient: true,
    });

    expect(result.code).toContain("post: createLiveQuery<Post, PostRelations>(baseClient, ResourcePaths.post),");
    expect(result.code).toContain("category: createLiveQuery<Category, {}>(baseClient, ResourcePaths.category),");
  });
});
