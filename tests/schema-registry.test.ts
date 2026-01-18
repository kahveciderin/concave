import { describe, it, expect, beforeEach } from "vitest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import {
  registerResourceSchema,
  unregisterResourceSchema,
  getResourceSchema,
  getAllResourceSchemas,
  getSchemaInfo,
  getAllSchemaInfos,
  clearSchemaRegistry,
} from "../src/ui/schema-registry";

const testUsers = sqliteTable("users", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email"),
  age: integer("age"),
});

const testPosts = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  authorId: text("author_id"),
});

describe("Schema Registry", () => {
  const mockDb = {} as any;

  beforeEach(() => {
    clearSchemaRegistry();
  });

  describe("registerResourceSchema", () => {
    it("registers a schema", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("users");
      expect(schema?.schema).toBe(testUsers);
    });

    it("registers with config", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {
        relations: {},
        procedures: ["getPosts"],
        generatedFields: ["createdAt"],
      });

      const schema = getResourceSchema("users");
      expect(schema?.config.procedures).toContain("getPosts");
      expect(schema?.config.generatedFields).toContain("createdAt");
    });
  });

  describe("unregisterResourceSchema", () => {
    it("removes a schema", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});
      expect(getResourceSchema("users")).toBeDefined();

      unregisterResourceSchema("users");
      expect(getResourceSchema("users")).toBeNull();
    });
  });

  describe("getAllResourceSchemas", () => {
    it("returns all registered schemas", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});
      registerResourceSchema("posts", testPosts, mockDb, testPosts.id, {});

      const schemas = getAllResourceSchemas();
      expect(schemas).toHaveLength(2);
      expect(schemas.map((s) => s.name)).toContain("users");
      expect(schemas.map((s) => s.name)).toContain("posts");
    });
  });

  describe("getSchemaInfo", () => {
    it("returns schema information", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {
        procedures: ["getProfile"],
      });

      const info = getSchemaInfo("users");
      expect(info).toBeDefined();
      expect(info?.name).toBe("users");
      expect(info?.columns).toHaveLength(4);
      expect(info?.procedures).toContain("getProfile");
    });

    it("identifies column types", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});

      const info = getSchemaInfo("users");
      const idColumn = info?.columns.find((c) => c.name === "id");
      const nameColumn = info?.columns.find((c) => c.name === "name");

      expect(idColumn?.isPrimary).toBe(true);
      expect(nameColumn?.isNullable).toBe(false);
    });

    it("identifies generated fields", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {
        generatedFields: ["id"],
      });

      const info = getSchemaInfo("users");
      const idColumn = info?.columns.find((c) => c.name === "id");
      expect(idColumn?.isGenerated).toBe(true);
    });

    it("returns null for unregistered schema", () => {
      expect(getSchemaInfo("nonexistent")).toBeNull();
    });
  });

  describe("getAllSchemaInfos", () => {
    it("returns info for all schemas", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});
      registerResourceSchema("posts", testPosts, mockDb, testPosts.id, {});

      const infos = getAllSchemaInfos();
      expect(infos).toHaveLength(2);
      expect(infos.every((i) => i.columns.length > 0)).toBe(true);
    });
  });

  describe("clearSchemaRegistry", () => {
    it("clears all schemas", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});
      registerResourceSchema("posts", testPosts, mockDb, testPosts.id, {});

      expect(getAllResourceSchemas()).toHaveLength(2);

      clearSchemaRegistry();

      expect(getAllResourceSchemas()).toHaveLength(0);
    });
  });

  describe("path normalization", () => {
    it("finds schema registered with leading slash when queried without", () => {
      registerResourceSchema("/api/users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("api/users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("/api/users");
    });

    it("finds schema registered without leading slash when queried with", () => {
      registerResourceSchema("api/users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("/api/users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("api/users");
    });

    it("finds schema info with path normalization", () => {
      registerResourceSchema("/api/posts", testPosts, mockDb, testPosts.id, {});

      const info = getSchemaInfo("api/posts");
      expect(info).toBeDefined();
      expect(info?.name).toBe("/api/posts");
    });

    it("handles exact match first", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("users");
    });

    it("handles multi-level paths", () => {
      registerResourceSchema("/api/v1/users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("api/v1/users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("/api/v1/users");
    });

    it("handles URL-encoded paths", () => {
      registerResourceSchema("/api/users", testUsers, mockDb, testUsers.id, {});

      const decoded = decodeURIComponent("api%2Fusers");
      const schema = getResourceSchema(decoded);
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("/api/users");
    });

    it("extracts table name from path (api/tablename -> tablename)", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});

      // Looking up with path should find by table name
      const schema = getResourceSchema("api/users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("users");
    });

    it("extracts table name from versioned path", () => {
      registerResourceSchema("posts", testPosts, mockDb, testPosts.id, {});

      // /api/v1/posts should find "posts"
      const schema = getResourceSchema("api/v1/posts");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("posts");
    });

    it("extracts table name from deeply nested path", () => {
      registerResourceSchema("users", testUsers, mockDb, testUsers.id, {});

      const schema = getResourceSchema("api/v2/admin/users");
      expect(schema).toBeDefined();
      expect(schema?.name).toBe("users");
    });
  });
});
