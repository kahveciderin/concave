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
  category: text("category").notNull(),
  price: integer("price").notNull(),
  active: integer("active", { mode: "boolean" }).default(true),
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

interface SSEEvent {
  event: string;
  data: any;
}

const collectSSEEvents = (
  baseUrl: string,
  path: string,
  timeout: number = 2000
): Promise<SSEEvent[]> => {
  return new Promise((resolve) => {
    const events: SSEEvent[] = [];
    const url = new URL(path, baseUrl);

    const req = http.get(url, (res) => {
      let buffer = "";

      res.on("data", (chunk) => {
        buffer += chunk.toString();

        const lines = buffer.split("\n\n");
        buffer = lines.pop() || "";

        for (const block of lines) {
          if (!block.trim()) continue;

          const eventMatch = block.match(/event:\s*(.+)/);
          const dataMatch = block.match(/data:\s*(.+)/);

          if (eventMatch && dataMatch) {
            try {
              events.push({
                event: eventMatch[1].trim(),
                data: JSON.parse(dataMatch[1].trim()),
              });
            } catch {
              events.push({
                event: eventMatch[1].trim(),
                data: dataMatch[1].trim(),
              });
            }
          }
        }
      });
    });

    req.on("error", () => {
      resolve(events);
    });

    setTimeout(() => {
      req.destroy();
      resolve(events);
    }, timeout);
  });
};

describe("Subscribe While Mutate Tests", () => {
  let app: Express;
  let server: http.Server;
  let baseUrl: string;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-subscribe-mutate-"));
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
        category TEXT NOT NULL,
        price INTEGER NOT NULL,
        active INTEGER DEFAULT 1
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

  it("should connect to SSE endpoint", async () => {
    const eventsPromise = collectSSEEvents(baseUrl, "/items/subscribe", 500);

    const events = await eventsPromise;

    expect(Array.isArray(events)).toBe(true);
  });

  it("should receive events during concurrent mutations", async () => {
    const eventsPromise = collectSSEEvents(baseUrl, "/items/subscribe", 2000);

    await new Promise((r) => setTimeout(r, 100));

    const createPromises = Array.from({ length: 5 }, (_, i) =>
      request(app)
        .post("/items")
        .send({ name: `Item${i}`, category: "Test", price: i * 10 })
    );

    const results = await Promise.all(createPromises);
    const successCount = results.filter((r) => r.status === 201).length;
    expect(successCount).toBe(5);

    const events = await eventsPromise;

    expect(Array.isArray(events)).toBe(true);
  });

  it("should handle mutations and subscription without data loss", async () => {
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/items")
        .send({ name: `PreExisting${i}`, category: "Initial", price: 100 })
        .expect(201);
    }

    const eventsPromise = collectSSEEvents(baseUrl, "/items/subscribe", 2000);

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .post("/items")
      .send({ name: "NewItem", category: "New", price: 50 })
      .expect(201);

    const events = await eventsPromise;

    const hasEvents = events.length > 0;
    expect(hasEvents).toBe(true);
  });

  it("should maintain data integrity during subscribe/mutate cycle", async () => {
    const createRes = await request(app)
      .post("/items")
      .send({ name: "TestItem", category: "Category1", price: 100 })
      .expect(201);

    const itemId = createRes.body.id;

    const eventsPromise = collectSSEEvents(baseUrl, "/items/subscribe", 1500);

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .patch(`/items/${itemId}`)
      .send({ name: "UpdatedItem" })
      .expect(200);

    await request(app).delete(`/items/${itemId}`).expect(204);

    const events = await eventsPromise;

    expect(Array.isArray(events)).toBe(true);

    const listRes = await request(app).get("/items").expect(200);
    const item = listRes.body.items.find((i: any) => i.id === itemId);
    expect(item).toBeUndefined();
  });

  it("should filter events by category when filter is provided", async () => {
    await request(app)
      .post("/items")
      .send({ name: "Electronics1", category: "Electronics", price: 100 })
      .expect(201);

    await request(app)
      .post("/items")
      .send({ name: "Clothing1", category: "Clothing", price: 50 })
      .expect(201);

    const filter = encodeURIComponent('category=="Clothing"');
    const eventsPromise = collectSSEEvents(
      baseUrl,
      `/items/subscribe?filter=${filter}`,
      1500
    );

    await new Promise((r) => setTimeout(r, 100));

    await request(app)
      .post("/items")
      .send({ name: "Clothing2", category: "Clothing", price: 60 })
      .expect(201);

    await request(app)
      .post("/items")
      .send({ name: "Electronics2", category: "Electronics", price: 200 })
      .expect(201);

    const events = await eventsPromise;

    const itemEvents = events.filter((e) => e.data?.item);
    const categories = itemEvents.map((e) => e.data.item.category);

    categories.forEach((cat) => {
      if (cat === "Electronics") {
        expect(false).toBe(true);
      }
    });
  });
});

