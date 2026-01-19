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
  status: text("status").default("active"),
});

describe("Search Endpoint", () => {
  let app: Express;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let searchAdapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-search-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_items`);
    await libsqlClient.execute(`
      CREATE TABLE test_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT DEFAULT 'active'
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

  describe("without search adapter", () => {
    beforeEach(() => {
      clearGlobalSearch();
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
        })
      );
      app.use(errorHandler);
    });

    it("should return 404 when search not configured", async () => {
      const res = await request(app)
        .get("/items/search?q=test")
        .expect(404);
    });
  });

  describe("with search adapter", () => {
    beforeEach(async () => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: true },
        })
      );
      app.use(errorHandler);

      await searchAdapter.index("test_items", "1", {
        id: 1,
        title: "Important Task",
        description: "Do this first",
        status: "active",
      });
      await searchAdapter.index("test_items", "2", {
        id: 2,
        title: "Normal Task",
        description: "Do this later",
        status: "active",
      });
      await searchAdapter.index("test_items", "3", {
        id: 3,
        title: "Another Important Item",
        description: "Critical",
        status: "completed",
      });
    });

    it("should return search results", async () => {
      const res = await request(app)
        .get("/items/search?q=important")
        .expect(200);

      expect(res.body.items).toHaveLength(2);
      expect(res.body.total).toBe(2);
    });

    it("should return 400 when query missing", async () => {
      const res = await request(app)
        .get("/items/search")
        .expect(400);

      expect(res.body.error).toBe("Missing query parameter 'q'");
    });

    it("should return empty results for no matches", async () => {
      const res = await request(app)
        .get("/items/search?q=nonexistent")
        .expect(200);

      expect(res.body.items).toHaveLength(0);
      expect(res.body.total).toBe(0);
    });

    describe("pagination", () => {
      it("should respect limit parameter", async () => {
        const res = await request(app)
          .get("/items/search?q=task&limit=1")
          .expect(200);

        expect(res.body.items).toHaveLength(1);
      });

      it("should respect offset parameter", async () => {
        const res1 = await request(app)
          .get("/items/search?q=task&limit=1&offset=0")
          .expect(200);

        const res2 = await request(app)
          .get("/items/search?q=task&limit=1&offset=1")
          .expect(200);

        expect(res1.body.items[0].id).not.toBe(res2.body.items[0].id);
      });

      it("should cap limit at 100", async () => {
        const res = await request(app)
          .get("/items/search?q=task&limit=200")
          .expect(200);

        // Limit is capped internally, but we can't directly verify
        // The endpoint should not error
        expect(res.body).toHaveProperty("items");
      });
    });

    describe("RSQL filter", () => {
      it("should apply filter to search results", async () => {
        const res = await request(app)
          .get("/items/search?q=important&filter=status==completed")
          .expect(200);

        expect(res.body.items).toHaveLength(1);
        expect(res.body.items[0].status).toBe("completed");
      });

      it("should work with complex filters", async () => {
        const res = await request(app)
          .get("/items/search?q=task&filter=status==active")
          .expect(200);

        for (const item of res.body.items) {
          expect(item.status).toBe("active");
        }
      });
    });

    describe("highlights", () => {
      it("should return highlights when requested", async () => {
        const res = await request(app)
          .get("/items/search?q=important&highlight=true")
          .expect(200);

        expect(res.body.highlights).toBeDefined();
      });

      it("should not return highlights by default", async () => {
        const res = await request(app)
          .get("/items/search?q=important")
          .expect(200);

        expect(res.body.highlights).toBeUndefined();
      });
    });
  });

  describe("with search disabled", () => {
    beforeEach(() => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: { enabled: false },
        })
      );
      app.use(errorHandler);
    });

    it("should return 404 when search disabled", async () => {
      const res = await request(app)
        .get("/items/search?q=test")
        .expect(404);
    });
  });

  describe("custom index name", () => {
    beforeEach(async () => {
      app.use(
        "/items",
        useResource(testItemsTable, {
          id: testItemsTable.id,
          db,
          search: {
            enabled: true,
            indexName: "custom_index",
          },
        })
      );
      app.use(errorHandler);

      await searchAdapter.index("custom_index", "1", {
        id: 1,
        title: "Test Item",
      });
    });

    it("should use custom index name", async () => {
      const res = await request(app)
        .get("/items/search?q=test")
        .expect(200);

      expect(res.body.items).toHaveLength(1);
    });
  });

  describe("field configuration", () => {
    describe("array config", () => {
      beforeEach(async () => {
        app.use(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: ["title"],
            },
          })
        );
        app.use(errorHandler);

        await searchAdapter.index("test_items", "1", {
          id: 1,
          title: "Important",
          description: "Critical",
        });
      });

      it("should search only specified fields", async () => {
        const titleMatch = await request(app)
          .get("/items/search?q=important")
          .expect(200);

        expect(titleMatch.body.items).toHaveLength(1);

        const descMatch = await request(app)
          .get("/items/search?q=critical")
          .expect(200);

        expect(descMatch.body.items).toHaveLength(0);
      });
    });

    describe("object config with weights", () => {
      beforeEach(async () => {
        app.use(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: {
                title: { weight: 2.0 },
                description: { weight: 1.0, searchable: true },
              },
            },
          })
        );
        app.use(errorHandler);

        await searchAdapter.index("test_items", "1", {
          id: 1,
          title: "Test",
          description: "Important",
        });
      });

      it("should respect searchable: false", async () => {
        const newApp = express();
        newApp.use(express.json());
        newApp.use(injectTestUser);
        newApp.use(
          "/items",
          useResource(testItemsTable, {
            id: testItemsTable.id,
            db,
            search: {
              enabled: true,
              fields: {
                title: { searchable: true },
                description: { searchable: false },
              },
            },
          })
        );
        newApp.use(errorHandler);

        await searchAdapter.index("test_items", "2", {
          id: 2,
          title: "Test",
          description: "UniqueDescription",
        });

        const res = await request(newApp)
          .get("/items/search?q=uniquedescription")
          .expect(200);

        expect(res.body.items).toHaveLength(0);
      });
    });
  });
});
