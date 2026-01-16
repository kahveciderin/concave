import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import http from "http";
import { useResource } from "@/resource/hook";
import { createMemoryKV, setGlobalKV } from "@/kv";

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  value: integer("value").notNull(),
});

const injectTestUser = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: "test-user", roles: ["admin"] };
  next();
};

const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    type: err.type || "/__concave/problems/internal-error",
    title: err.title || "Error",
    status,
    detail: err.message,
  });
};

const createTestServer = (db: any): Express => {
  const app = express();
  app.use(express.json());
  app.use(injectTestUser);
  app.use(
    "/items",
    useResource(testItemsTable, {
      id: testItemsTable.id,
      db,
    })
  );
  app.use(errorHandler);
  return app;
};

describe("Multi-Instance Distributed Tests", () => {
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let sharedKV: ReturnType<typeof createMemoryKV>;

  beforeAll(async () => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-distributed-"));
    sharedKV = createMemoryKV("shared");
    await sharedKV.connect();
    setGlobalKV(sharedKV);
  });

  afterAll(async () => {
    await sharedKV.disconnect();
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
        name TEXT NOT NULL,
        value INTEGER NOT NULL
      )
    `);
  });

  afterEach(() => {
    libsqlClient.close();
  });

  it("should share data between two instances using same database", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await request(instance1)
      .post("/items")
      .send({ name: "SharedItem", value: 100 })
      .expect(201);

    const itemId = createRes.body.id;

    const getRes = await request(instance2).get(`/items/${itemId}`).expect(200);

    expect(getRes.body.name).toBe("SharedItem");
    expect(getRes.body.value).toBe(100);
  });

  it("should see updates from one instance on another", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await request(instance1)
      .post("/items")
      .send({ name: "ToUpdate", value: 50 })
      .expect(201);

    const itemId = createRes.body.id;

    await request(instance2)
      .patch(`/items/${itemId}`)
      .send({ value: 150 })
      .expect(200);

    const getRes = await request(instance1).get(`/items/${itemId}`).expect(200);

    expect(getRes.body.value).toBe(150);
  });

  it("should see deletions from one instance on another", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const createRes = await request(instance1)
      .post("/items")
      .send({ name: "ToDelete", value: 200 })
      .expect(201);

    const itemId = createRes.body.id;

    await request(instance2).delete(`/items/${itemId}`).expect(204);

    await request(instance1).get(`/items/${itemId}`).expect(404);
  });

  it("should maintain consistency with concurrent writes to different instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    const items: number[] = [];

    const createPromises = [
      request(instance1).post("/items").send({ name: "Item1", value: 1 }),
      request(instance2).post("/items").send({ name: "Item2", value: 2 }),
      request(instance1).post("/items").send({ name: "Item3", value: 3 }),
      request(instance2).post("/items").send({ name: "Item4", value: 4 }),
    ];

    const results = await Promise.all(createPromises);

    for (const res of results) {
      expect(res.status).toBe(201);
      items.push(res.body.id);
    }

    const listRes1 = await request(instance1).get("/items").expect(200);
    const listRes2 = await request(instance2).get("/items").expect(200);

    expect(listRes1.body.items.length).toBe(4);
    expect(listRes2.body.items.length).toBe(4);
  });

  it("should handle filter queries consistently across instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    await request(instance1).post("/items").send({ name: "A", value: 10 }).expect(201);
    await request(instance2).post("/items").send({ name: "B", value: 20 }).expect(201);
    await request(instance1).post("/items").send({ name: "C", value: 30 }).expect(201);

    const filter = encodeURIComponent("value>15");

    const filterRes1 = await request(instance1).get(`/items?filter=${filter}`).expect(200);
    const filterRes2 = await request(instance2).get(`/items?filter=${filter}`).expect(200);

    expect(filterRes1.body.items.length).toBe(2);
    expect(filterRes2.body.items.length).toBe(2);
  });

  it("should handle count queries consistently across instances", async () => {
    const instance1 = createTestServer(db);
    const instance2 = createTestServer(db);

    await request(instance1).post("/items").send({ name: "Count1", value: 5 }).expect(201);
    await request(instance2).post("/items").send({ name: "Count2", value: 10 }).expect(201);
    await request(instance1).post("/items").send({ name: "Count3", value: 15 }).expect(201);

    const countRes1 = await request(instance1).get("/items/count").expect(200);
    const countRes2 = await request(instance2).get("/items/count").expect(200);

    expect(countRes1.body.count).toBe(3);
    expect(countRes2.body.count).toBe(3);
  });
});
