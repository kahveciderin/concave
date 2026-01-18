import { describe, it, expect, beforeEach, afterEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import { useResource } from "../../src/resource/hook";
import { createAdminUI } from "../../src/ui";
import {
  getAllResourcesForDisplay,
  clearSchemaRegistry,
  getResourcesForOpenAPI,
} from "../../src/ui/schema-registry";

const testTable = sqliteTable("test_items", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  status: text("status"),
  count: integer("count"),
});

describe("Capability Inference", () => {
  let app: Express;
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle>;

  beforeEach(() => {
    sqlite = new Database(":memory:");
    db = drizzle(sqlite);

    sqlite.exec(`
      CREATE TABLE test_items (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        status TEXT,
        count INTEGER
      )
    `);

    clearSchemaRegistry();

    app = express();
    app.use(express.json());
  });

  afterEach(() => {
    sqlite.close();
    clearSchemaRegistry();
  });

  describe("default capabilities", () => {
    it("should enable all CRUD capabilities by default", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
        })
      );

      const resources = getAllResourcesForDisplay();
      expect(resources).toHaveLength(1);

      const resource = resources[0];
      expect(resource.capabilities.enableCreate).toBe(true);
      expect(resource.capabilities.enableUpdate).toBe(true);
      expect(resource.capabilities.enableDelete).toBe(true);
      expect(resource.capabilities.enableSubscriptions).toBe(true);
      expect(resource.capabilities.enableAggregations).toBe(true);
    });

    it("should create all endpoints when no capabilities specified", async () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          auth: { public: true },
        })
      );

      // Verify endpoints exist (may return 401 for writes without auth, but routes are registered)
      // GET list should work with public read
      const listRes = await request(app).get("/api/items");
      expect(listRes.status).toBe(200);

      // POST endpoint exists (returns 401 without auth, not 404)
      const createRes = await request(app)
        .post("/api/items")
        .send({ id: "1", name: "Test" });
      expect(createRes.status).not.toBe(404);

      // PATCH endpoint exists
      const updateRes = await request(app)
        .patch("/api/items/1")
        .send({ name: "Updated" });
      expect(updateRes.status).not.toBe(404);

      // DELETE endpoint exists
      const deleteRes = await request(app).delete("/api/items/1");
      expect(deleteRes.status).not.toBe(404);

      // Count endpoint exists
      const countRes = await request(app).get("/api/items/count");
      expect(countRes.status).toBe(200);
    });
  });

  describe("explicit capability disabling", () => {
    it("should reflect disabled create capability", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: { enableCreate: false },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];
      expect(resource.capabilities.enableCreate).toBe(false);
      expect(resource.capabilities.enableUpdate).toBe(true);
      expect(resource.capabilities.enableDelete).toBe(true);
    });

    it("should reflect disabled update capability", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: { enableUpdate: false },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];
      expect(resource.capabilities.enableCreate).toBe(true);
      expect(resource.capabilities.enableUpdate).toBe(false);
      expect(resource.capabilities.enableDelete).toBe(true);
    });

    it("should reflect disabled delete capability", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: { enableDelete: false },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];
      expect(resource.capabilities.enableCreate).toBe(true);
      expect(resource.capabilities.enableUpdate).toBe(true);
      expect(resource.capabilities.enableDelete).toBe(false);
    });

    it("should reflect disabled subscribe capability", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: { enableSubscribe: false },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];
      expect(resource.capabilities.enableSubscriptions).toBe(false);
    });

    it("should reflect multiple disabled capabilities", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: {
            enableCreate: false,
            enableUpdate: false,
            enableDelete: false,
            enableSubscribe: false,
          },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];
      expect(resource.capabilities.enableCreate).toBe(false);
      expect(resource.capabilities.enableUpdate).toBe(false);
      expect(resource.capabilities.enableDelete).toBe(false);
      expect(resource.capabilities.enableSubscriptions).toBe(false);
    });
  });

  describe("admin UI display matches capabilities", () => {
    it("should show all endpoints in admin UI when all capabilities enabled", async () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
        })
      );
      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/resources")
        .expect(200);

      // Should show all endpoint types
      expect(response.text).toContain("GET");
      expect(response.text).toContain("POST");
      expect(response.text).toContain("PATCH");
      expect(response.text).toContain("DELETE");
      expect(response.text).toContain("SSE");
    });

    it("should hide disabled endpoints in admin UI", async () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: {
            enableCreate: false,
            enableUpdate: false,
            enableDelete: false,
            enableSubscribe: false,
          },
        })
      );
      app.use("/__concave", createAdminUI({}));

      const response = await request(app)
        .get("/__concave/ui/resources")
        .expect(200);

      // Should show GET but not mutation endpoints
      expect(response.text).toContain("GET");
      // POST, PATCH, DELETE badges should not appear for this resource
      // Note: GET badge appears, but POST/PATCH/DELETE should not be in endpoints table
      expect(response.text).not.toContain('>Create<');
      expect(response.text).not.toContain('>Update<');
      expect(response.text).not.toContain('>Delete<');
      expect(response.text).not.toContain('>SSE<');
    });
  });

  describe("multiple resources", () => {
    it("should track capabilities independently for each resource", () => {
      const table2 = sqliteTable("other_items", {
        id: text("id").primaryKey(),
        value: text("value"),
      });

      sqlite.exec(`
        CREATE TABLE other_items (
          id TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          capabilities: { enableDelete: false },
        })
      );

      app.use(
        "/api/other",
        useResource(table2, {
          id: table2.id,
          db,
          capabilities: { enableCreate: false },
        })
      );

      const resources = getAllResourcesForDisplay();
      expect(resources).toHaveLength(2);

      const items = resources.find((r) => r.name === "test_items");
      const other = resources.find((r) => r.name === "other_items");

      expect(items?.capabilities.enableCreate).toBe(true);
      expect(items?.capabilities.enableDelete).toBe(false);

      expect(other?.capabilities.enableCreate).toBe(false);
      expect(other?.capabilities.enableDelete).toBe(true);
    });
  });

  describe("auth config detection", () => {
    it("should detect auth scopes from config", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          auth: {
            read: async () => ({ toString: () => "*", isEmpty: () => false, and: (o: any) => o, or: (o: any) => o }),
            create: async () => ({ toString: () => "*", isEmpty: () => false, and: (o: any) => o, or: (o: any) => o }),
            update: async () => ({ toString: () => "*", isEmpty: () => false, and: (o: any) => o, or: (o: any) => o }),
            delete: async () => ({ toString: () => "*", isEmpty: () => false, and: (o: any) => o, or: (o: any) => o }),
          },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];

      expect(resource.auth?.hasReadScope).toBe(true);
      expect(resource.auth?.hasCreateScope).toBe(true);
      expect(resource.auth?.hasUpdateScope).toBe(true);
      expect(resource.auth?.hasDeleteScope).toBe(true);
    });

    it("should detect public read config", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          auth: {
            public: { read: true, subscribe: true },
          },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];

      expect(resource.auth?.public?.read).toBe(true);
      expect(resource.auth?.public?.subscribe).toBe(true);
    });
  });

  describe("procedures detection", () => {
    it("should list registered procedures", () => {
      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          procedures: {
            customAction: {
              handler: async () => ({ success: true }),
            },
            anotherAction: {
              handler: async () => ({ done: true }),
            },
          },
        })
      );

      const resources = getAllResourcesForDisplay();
      const resource = resources[0];

      expect(resource.procedures).toContain("customAction");
      expect(resource.procedures).toContain("anotherAction");
    });
  });

  describe("mount path auto-capture", () => {
    it("should capture mount path on first request", async () => {
      app.use(
        "/api/v2/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          auth: { public: true },
        })
      );

      // Before any request, path uses fallback
      let resources = getResourcesForOpenAPI();
      expect(resources[0].path).toBe("/test_items");

      // Make a request to trigger path capture
      await request(app).get("/api/v2/items");

      // After request, path should be the actual mount path
      resources = getResourcesForOpenAPI();
      expect(resources[0].path).toBe("/api/v2/items");
    });

    it("should capture different paths for different resources", async () => {
      const table2 = sqliteTable("other_items", {
        id: text("id").primaryKey(),
        value: text("value"),
      });

      sqlite.exec(`
        CREATE TABLE other_items (
          id TEXT PRIMARY KEY,
          value TEXT
        )
      `);

      app.use(
        "/api/items",
        useResource(testTable, {
          id: testTable.id,
          db,
          auth: { public: true },
        })
      );

      app.use(
        "/api/v2/other",
        useResource(table2, {
          id: table2.id,
          db,
          auth: { public: true },
        })
      );

      // Trigger path capture for both
      await request(app).get("/api/items");
      await request(app).get("/api/v2/other");

      const resources = getResourcesForOpenAPI();
      const items = resources.find((r) => r.name === "test_items");
      const other = resources.find((r) => r.name === "other_items");

      expect(items?.path).toBe("/api/items");
      expect(other?.path).toBe("/api/v2/other");
    });
  });
});
