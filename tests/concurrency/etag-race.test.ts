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
import { generateETag } from "@/resource/etag";

const testUsersTable = sqliteTable("test_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  version: integer("version").default(1),
});

const injectTestUser = (req: Request, _res: Response, next: NextFunction) => {
  (req as any).user = { id: "test-user", roles: ["admin"] };
  next();
};

const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    type: err.type || "/__concave/problems/internal-error",
    title: err.message,
    status,
    detail: err.message,
    currentETag: err.currentETag,
  });
};

describe("ETag Race Condition Tests", () => {
  let app: Express;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-etag-race-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, `test-${Date.now()}.db`)}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_users`);
    await libsqlClient.execute(`
      CREATE TABLE test_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        version INTEGER DEFAULT 1
      )
    `);

    app = express();
    app.use(express.json());
    app.use(injectTestUser);
    app.use(
      "/users",
      useResource(testUsersTable, {
        id: testUsersTable.id,
        db,
        etag: {
          versionField: "version",
        },
      })
    );
    app.use(errorHandler);
  });

  afterEach(() => {
    libsqlClient.close();
  });

  it("should allow concurrent updates without If-Match", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Alice", email: "alice@test.com" })
      .expect(201);

    const userId = createRes.body.id;

    const [res1, res2] = await Promise.all([
      request(app)
        .patch(`/users/${userId}`)
        .send({ name: "Alice Updated 1" }),
      request(app)
        .patch(`/users/${userId}`)
        .send({ name: "Alice Updated 2" }),
    ]);

    expect([res1.status, res2.status].sort()).toEqual([200, 200]);
  });

  it("should handle concurrent updates", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Bob", email: "bob@test.com" })
      .expect(201);

    const userId = createRes.body.id;

    const update1 = request(app)
      .patch(`/users/${userId}`)
      .send({ name: "Bob Client1" });

    const update2 = request(app)
      .patch(`/users/${userId}`)
      .send({ name: "Bob Client2" });

    const [res1, res2] = await Promise.all([update1, update2]);

    expect(res1.status).toBe(200);
    expect(res2.status).toBe(200);

    const getRes = await request(app).get(`/users/${userId}`).expect(200);
    expect(getRes.body.name).toMatch(/^Bob Client[12]$/);
  });

  it("should generate ETags for responses", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Carol", email: "carol@test.com" })
      .expect(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers["etag"];

    expect(initialETag).toBeDefined();
    expect(initialETag).toMatch(/^(W\/)?"[^"]+"/);

    const getRes = await request(app).get(`/users/${userId}`).expect(200);

    expect(getRes.headers["etag"]).toBeDefined();
  });

  it("should handle multiple concurrent clients with optimistic locking", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Dave", email: "dave@test.com" })
      .expect(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers["etag"];

    const clients = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .patch(`/users/${userId}`)
        .set("If-Match", initialETag)
        .send({ name: `Dave Client${i}` })
    );

    const results = await Promise.all(clients);

    const successes = results.filter((r) => r.status === 200);
    const failures = results.filter((r) => r.status === 412);

    expect(successes.length + failures.length).toBe(5);
    expect(successes.length).toBeGreaterThanOrEqual(1);
  });

  it("should handle delete operations", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Eve", email: "eve@test.com" })
      .expect(201);

    const userId = createRes.body.id;

    await request(app)
      .patch(`/users/${userId}`)
      .send({ name: "Eve Updated" })
      .expect(200);

    const getRes = await request(app).get(`/users/${userId}`).expect(200);
    expect(getRes.body.name).toBe("Eve Updated");

    await request(app).delete(`/users/${userId}`).expect(204);

    await request(app).get(`/users/${userId}`).expect(404);
  });

  it("should handle If-Match: * to match any ETag", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Frank", email: "frank@test.com" })
      .expect(201);

    const userId = createRes.body.id;

    await request(app)
      .patch(`/users/${userId}`)
      .set("If-Match", "*")
      .send({ name: "Frank Star Match" })
      .expect(200);
  });

  it("should include new ETag in successful response", async () => {
    const createRes = await request(app)
      .post("/users")
      .send({ name: "Grace", email: "grace@test.com" })
      .expect(201);

    const userId = createRes.body.id;
    const initialETag = createRes.headers["etag"];

    const updateRes = await request(app)
      .patch(`/users/${userId}`)
      .set("If-Match", initialETag)
      .send({ name: "Grace Updated" })
      .expect(200);

    const newETag = updateRes.headers["etag"];
    expect(newETag).toBeDefined();
    expect(newETag).not.toBe(initialETag);
  });
});
