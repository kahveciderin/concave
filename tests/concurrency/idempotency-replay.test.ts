import { describe, it, expect, beforeEach, afterEach, afterAll, beforeAll } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { idempotencyMiddleware, validateIdempotencyKey } from "@/middleware/idempotency";
import { createMemoryKV } from "@/kv/memory";

const testOrdersTable = sqliteTable("test_orders", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  product: text("product").notNull(),
  quantity: integer("quantity").notNull(),
  status: text("status").default("pending"),
});

const injectTestUser = (userId: string) => (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: userId, roles: ["user"] };
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

describe("Idempotency Replay Tests", () => {
  let app: Express;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;
  let kvStore: ReturnType<typeof createMemoryKV>;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-idempotency-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);
    kvStore = createMemoryKV("idempotency");
    await kvStore.connect();

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_orders`);
    await libsqlClient.execute(`
      CREATE TABLE test_orders (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        product TEXT NOT NULL,
        quantity INTEGER NOT NULL,
        status TEXT DEFAULT 'pending'
      )
    `);

    app = express();
    app.use(express.json());
  });

  afterEach(async () => {
    await kvStore.disconnect();
    libsqlClient.close();
  });

  const setupAppWithIdempotency = (userId = "test-user") => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(injectTestUser(userId));
    testApp.use(
      idempotencyMiddleware({
        storage: kvStore,
        ttlMs: 60000,
      })
    );
    testApp.use(
      "/orders",
      useResource(testOrdersTable, {
        id: testOrdersTable.id,
        db,
      })
    );
    testApp.use(errorHandler);
    return testApp;
  };

  describe("validateIdempotencyKey", () => {
    it("should accept valid keys", () => {
      expect(validateIdempotencyKey("my-key-123")).toBe(true);
      expect(validateIdempotencyKey("abc_DEF_123")).toBe(true);
      expect(validateIdempotencyKey("a".repeat(256))).toBe(true);
    });

    it("should reject invalid keys", () => {
      expect(validateIdempotencyKey("")).toBe(false);
      expect(validateIdempotencyKey("short")).toBe(false);
      expect(validateIdempotencyKey("a".repeat(257))).toBe(false);
      expect(validateIdempotencyKey("key with space")).toBe(false);
      expect(validateIdempotencyKey("key@special")).toBe(false);
    });
  });

  it("should return same response for same idempotency key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "create-order-12345678";

    const res1 = await request(testApp)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "Widget", quantity: 5 })
      .expect(201);

    const res2 = await request(testApp)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "Widget", quantity: 5 })
      .expect(201);

    expect(res1.body.id).toBe(res2.body.id);
    expect(res1.body.product).toBe(res2.body.product);
    expect(res1.body.quantity).toBe(res2.body.quantity);

    const listRes = await request(testApp).get("/orders").expect(200);
    expect(listRes.body.items.length).toBe(1);
  });

  it("should execute once for concurrent requests with same key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "concurrent-order-12345";

    const requests = Array.from({ length: 10 }, () =>
      request(testApp)
        .post("/orders")
        .set("idempotency-key", idempotencyKey)
        .send({ product: "Gadget", quantity: 1 })
    );

    const results = await Promise.all(requests);

    const successResponses = results.filter((r) => r.status === 201);
    expect(successResponses.length).toBeGreaterThan(0);

    const ids = successResponses.map((r) => r.body.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(1);

    const listRes = await request(testApp).get("/orders").expect(200);
    expect(listRes.body.items.length).toBe(1);
  });

  it("should reject different request body with same key", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "mismatch-order-123456";

    await request(testApp)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "ItemA", quantity: 1 })
      .expect(201);

    const res2 = await request(testApp)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "ItemB", quantity: 2 });

    expect(res2.status).toBe(409);
    expect(res2.body.detail || res2.body.title || "").toMatch(/[Ii]dempotency/);
  });

  it("should allow same key for different users", async () => {
    const idempotencyKey = "shared-key-12345678";

    const app1 = setupAppWithIdempotency("user-1");
    const app2 = setupAppWithIdempotency("user-2");

    const res1 = await request(app1)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "Product1", quantity: 1 })
      .expect(201);

    const res2 = await request(app2)
      .post("/orders")
      .set("idempotency-key", idempotencyKey)
      .send({ product: "Product2", quantity: 2 })
      .expect(201);

    expect(res1.body.id).not.toBe(res2.body.id);
    expect(res1.body.product).toBe("Product1");
    expect(res2.body.product).toBe("Product2");
  });

  it("should not apply idempotency to GET requests", async () => {
    const testApp = setupAppWithIdempotency();
    const idempotencyKey = "get-request-12345678";

    await request(testApp)
      .post("/orders")
      .send({ product: "TestProduct", quantity: 1 })
      .expect(201);

    const res1 = await request(testApp)
      .get("/orders")
      .set("idempotency-key", idempotencyKey)
      .expect(200);

    await request(testApp)
      .post("/orders")
      .send({ product: "AnotherProduct", quantity: 2 })
      .expect(201);

    const res2 = await request(testApp)
      .get("/orders")
      .set("idempotency-key", idempotencyKey)
      .expect(200);

    expect(res2.body.items.length).toBe(2);
  });

  it("should work without idempotency key - creates multiple resources", async () => {
    const testApp = setupAppWithIdempotency();

    const requests = Array.from({ length: 5 }, () =>
      request(testApp).post("/orders").send({ product: "NoKeyProduct", quantity: 1 })
    );

    const results = await Promise.all(requests);

    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(5);

    const listRes = await request(testApp).get("/orders").expect(200);
    expect(listRes.body.items.length).toBe(5);
  });

  it("should apply idempotency to PATCH requests", async () => {
    const testApp = setupAppWithIdempotency();

    const createRes = await request(testApp)
      .post("/orders")
      .send({ product: "Original", quantity: 1 })
      .expect(201);

    const orderId = createRes.body.id;
    const idempotencyKey = "update-order-12345678";

    const res1 = await request(testApp)
      .patch(`/orders/${orderId}`)
      .set("idempotency-key", idempotencyKey)
      .send({ quantity: 10 })
      .expect(200);

    const res2 = await request(testApp)
      .patch(`/orders/${orderId}`)
      .set("idempotency-key", idempotencyKey)
      .send({ quantity: 10 })
      .expect(200);

    expect(res1.body.quantity).toBe(res2.body.quantity);
    expect(res1.body.quantity).toBe(10);
  });

  it("should not cache server errors (5xx)", async () => {
    const testApp = express();
    testApp.use(express.json());
    testApp.use(injectTestUser("test-user"));
    testApp.use(
      idempotencyMiddleware({
        storage: kvStore,
        ttlMs: 60000,
      })
    );

    let callCount = 0;
    testApp.post("/flaky", (_req, res) => {
      callCount++;
      if (callCount === 1) {
        res.status(500).json({ error: "Server error" });
      } else {
        res.status(201).json({ success: true, attempt: callCount });
      }
    });

    const idempotencyKey = "flaky-operation-1234";

    await request(testApp)
      .post("/flaky")
      .set("idempotency-key", idempotencyKey)
      .expect(500);

    const res2 = await request(testApp)
      .post("/flaky")
      .set("idempotency-key", idempotencyKey)
      .expect(201);

    expect(res2.body.success).toBe(true);
    expect(res2.body.attempt).toBe(2);
  });
});
