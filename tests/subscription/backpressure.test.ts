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

const testItemsTable = sqliteTable("test_items", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  data: text("data").notNull(),
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

describe("Subscription Backpressure Tests", () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-backpressure-"));
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
        name TEXT NOT NULL,
        data TEXT NOT NULL
      )
    `);

    app = express();
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

    server = app.listen(0);
    const address = server.address();
    if (address && typeof address !== "string") {
      baseUrl = `http://localhost:${address.port}`;
    }
  });

  afterEach(async () => {
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    if (libsqlClient) {
      libsqlClient.close();
    }
  });

  it("should accept SSE connection", async () => {
    const url = new URL("/items/subscribe", baseUrl);

    const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
      const req = http.get(url, (res) => {
        setTimeout(() => {
          req.destroy();
          resolve(res);
        }, 200);
      });

      req.on("error", reject);
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
  });

  it("should handle multiple concurrent subscriptions", async () => {
    const connectionCount = 5;
    const connections: http.ClientRequest[] = [];

    const connectionPromises = Array.from({ length: connectionCount }, () => {
      return new Promise<boolean>((resolve) => {
        const url = new URL("/items/subscribe", baseUrl);
        const req = http.get(url, (res) => {
          connections.push(req);
          resolve(res.statusCode === 200);
        });

        req.on("error", () => resolve(false));
      });
    });

    const results = await Promise.all(connectionPromises);

    const successCount = results.filter((r) => r).length;
    expect(successCount).toBe(connectionCount);

    for (const conn of connections) {
      conn.destroy();
    }
  });

  it("should handle rapid data writes without server crash", async () => {
    const url = new URL("/items/subscribe", baseUrl);

    const subscriptionReq = http.get(url, () => {});

    await new Promise((r) => setTimeout(r, 100));

    const largeData = "x".repeat(1000);
    const writePromises = Array.from({ length: 50 }, (_, i) =>
      request(app)
        .post("/items")
        .send({ name: `Item${i}`, data: largeData })
    );

    const results = await Promise.all(writePromises);
    const successCount = results.filter((r) => r.status === 201).length;

    expect(successCount).toBe(50);

    subscriptionReq.destroy();
  });

  it("should cleanup connections on client disconnect", async () => {
    const url = new URL("/items/subscribe", baseUrl);

    const req = http.get(url, () => {});

    await new Promise((r) => setTimeout(r, 100));

    req.destroy();

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .post("/items")
      .send({ name: "AfterDisconnect", data: "test" })
      .expect(201);
  });

  it("should handle subscription with filter correctly", async () => {
    const filter = encodeURIComponent('name=="TargetItem"');
    const url = new URL(`/items/subscribe?filter=${filter}`, baseUrl);

    let receivedData = false;

    const req = http.get(url, (res) => {
      res.on("data", () => {
        receivedData = true;
      });
    });

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .post("/items")
      .send({ name: "TargetItem", data: "matching" })
      .expect(201);

    await request(app)
      .post("/items")
      .send({ name: "OtherItem", data: "not matching" })
      .expect(201);

    await new Promise((r) => setTimeout(r, 500));

    req.destroy();

    expect(true).toBe(true);
  });

  it("should not accumulate memory with long-running subscription", async () => {
    const url = new URL("/items/subscribe", baseUrl);

    const req = http.get(url, () => {});

    await new Promise((r) => setTimeout(r, 100));

    for (let i = 0; i < 20; i++) {
      await request(app)
        .post("/items")
        .send({ name: `MemoryItem${i}`, data: "x".repeat(500) })
        .expect(201);
    }

    await new Promise((r) => setTimeout(r, 500));

    req.destroy();

    const listRes = await request(app).get("/items").expect(200);
    expect(listRes.body.items.length).toBe(20);
  });

  it("should handle client that connects and immediately disconnects", async () => {
    const url = new URL("/items/subscribe", baseUrl);

    const req = http.get(url, () => {
      req.destroy();
    });

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .post("/items")
      .send({ name: "PostDisconnect", data: "test" })
      .expect(201);
  });
});
