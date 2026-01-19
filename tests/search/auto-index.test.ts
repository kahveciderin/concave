import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import {
  setGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
} from "@/search";

const injectTestUser = (req: Request, res: Response, next: NextFunction) => {
  (req as any).user = { id: "test-user", email: "test@test.com" };
  next();
};

const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: err.message,
    code: err.code || "INTERNAL_ERROR",
  });
};

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  title: text("title").notNull(),
  description: text("description"),
});

describe("Search Auto-Indexing", () => {
  let app: Express;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let searchAdapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-autoindex-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_items`);
    await libsqlClient.execute(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT
      )
    `);

    searchAdapter = createMemorySearchAdapter();
    setGlobalSearch(searchAdapter);

    app = express();
    app.use(express.json());
    app.use(injectTestUser);
  });

  afterEach(() => {
    libsqlClient.close();
    clearGlobalSearch();
  });

  describe("auto-indexing enabled (default)", () => {
    beforeEach(() => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
        })
      );
      app.use(errorHandler);
    });

    it("should index documents on create", async () => {
      const res = await request(app)
        .post("/items")
        .send({ title: "New Item", description: "Test description" })
        .expect(201);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.has(String(res.body.id))).toBe(true);
    });

    it("should re-index documents on update (PATCH)", async () => {
      const createRes = await request(app)
        .post("/items")
        .send({ title: "Original", description: "Test" })
        .expect(201);

      await request(app)
        .patch(`/items/${createRes.body.id}`)
        .send({ title: "Updated" })
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Updated");
    });

    it("should re-index documents on update (PUT)", async () => {
      const createRes = await request(app)
        .post("/items")
        .send({ title: "Original", description: "Test" })
        .expect(201);

      await request(app)
        .put(`/items/${createRes.body.id}`)
        .send({ title: "Replaced", description: "New" })
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Replaced");
    });

    it("should remove documents from index on delete", async () => {
      const createRes = await request(app)
        .post("/items")
        .send({ title: "To Delete" })
        .expect(201);

      const id = String(createRes.body.id);
      expect(searchAdapter.getIndex("test_items")?.has(id)).toBe(true);

      await request(app)
        .delete(`/items/${createRes.body.id}`)
        .expect(204);

      expect(searchAdapter.getIndex("test_items")?.has(id)).toBe(false);
    });

    it("should index all created documents in batch create", async () => {
      app = express();
      app.use(express.json());
      app.use(injectTestUser);
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { create: 10 },
        })
      );
      app.use(errorHandler);

      const res = await request(app)
        .post("/items/batch")
        .send({
          items: [
            { title: "Item 1" },
            { title: "Item 2" },
            { title: "Item 3" },
          ],
        })
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size).toBe(3);
    });

    it("should update all documents in batch update", async () => {
      const createRes = await request(app)
        .post("/items")
        .send({ title: "To Update" })
        .expect(201);

      app = express();
      app.use(express.json());
      app.use(injectTestUser);
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { update: 10 },
        })
      );
      app.use(errorHandler);

      await request(app)
        .patch("/items/batch")
        .send({ title: "Batch Updated" })
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      const doc = index?.get(String(createRes.body.id));
      expect(doc?.title).toBe("Batch Updated");
    });

    it("should remove all documents in batch delete", async () => {
      await request(app)
        .post("/items")
        .send({ title: "Delete 1" })
        .expect(201);
      await request(app)
        .post("/items")
        .send({ title: "Delete 2" })
        .expect(201);

      app = express();
      app.use(express.json());
      app.use(injectTestUser);
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          batch: { delete: 10 },
        })
      );
      app.use(errorHandler);

      await request(app)
        .delete("/items/batch")
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size ?? 0).toBe(0);
    });
  });

  describe("auto-indexing disabled", () => {
    beforeEach(() => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true, autoIndex: false },
        })
      );
      app.use(errorHandler);
    });

    it("should not index documents on create", async () => {
      await request(app)
        .post("/items")
        .send({ title: "Not Indexed" })
        .expect(201);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size ?? 0).toBe(0);
    });

    it("should not update index on update", async () => {
      await searchAdapter.index("test_items", "manual", { title: "Manual" });

      const createRes = await request(app)
        .post("/items")
        .send({ title: "Original" })
        .expect(201);

      await request(app)
        .patch(`/items/${createRes.body.id}`)
        .send({ title: "Updated" })
        .expect(200);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.size).toBe(1);
      expect(index?.get("manual")).toBeDefined();
    });

    it("should not remove from index on delete", async () => {
      const createRes = await request(app)
        .post("/items")
        .send({ title: "Not Deleted" })
        .expect(201);

      await searchAdapter.index("test_items", String(createRes.body.id), {
        title: "Manually Indexed",
      });

      await request(app)
        .delete(`/items/${createRes.body.id}`)
        .expect(204);

      const index = searchAdapter.getIndex("test_items");
      expect(index?.has(String(createRes.body.id))).toBe(true);
    });
  });

  describe("custom index name", () => {
    beforeEach(() => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: {
            enabled: true,
            indexName: "custom_items",
          },
        })
      );
      app.use(errorHandler);
    });

    it("should use custom index name for auto-indexing", async () => {
      await request(app)
        .post("/items")
        .send({ title: "Custom Index" })
        .expect(201);

      expect(searchAdapter.getIndex("custom_items")?.size).toBe(1);
      expect(searchAdapter.getIndex("test_items")).toBeUndefined();
    });
  });

  describe("with existing hooks", () => {
    let hookCalled = false;

    beforeEach(() => {
      hookCalled = false;
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
          hooks: {
            onAfterCreate: async () => {
              hookCalled = true;
            },
          },
        })
      );
      app.use(errorHandler);
    });

    it("should call existing hooks alongside auto-indexing", async () => {
      await request(app)
        .post("/items")
        .send({ title: "With Hook" })
        .expect(201);

      expect(hookCalled).toBe(true);
      expect(searchAdapter.getIndex("test_items")?.size).toBe(1);
    });
  });
});
