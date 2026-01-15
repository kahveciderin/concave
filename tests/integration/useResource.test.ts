import { describe, it, expect, beforeEach, afterEach, vi, beforeAll, afterAll } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { drizzle } from "drizzle-orm/libsql";
import { createClient as createLibsqlClient } from "@libsql/client";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { useResource } from "@/resource/hook";
import { sql } from "drizzle-orm";

const injectTestUser = (req: Request, res: Response, next: NextFunction) => {
  (req as any).user = { id: "test-user", email: "test@test.com", roles: ["admin"] };
  next();
};

const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: {
      message: err.message,
      code: err.code || "INTERNAL_ERROR",
    },
  });
};

// Helper to setup app with routes and error handler
const setupApp = (appInstance: Express, routerFactory: () => ReturnType<typeof useResource>) => {
  appInstance.use("/users", routerFactory());
  appInstance.use(errorHandler);
};

const testUsersTable = sqliteTable("test_users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  age: integer("age").notNull(),
  status: text("status").default("active"),
  role: text("role").default("user"),
});

describe("useResource Integration Tests", () => {
  let app: Express;
  let libsqlClient: ReturnType<typeof createLibsqlClient>;
  let db: ReturnType<typeof drizzle>;
  let tempDir: string;

  beforeAll(() => {
    tempDir = mkdtempSync(join(tmpdir(), "concave-integration-"));
  });

  afterAll(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  });

  beforeEach(async () => {
    libsqlClient = createLibsqlClient({ url: `file:${join(tempDir, "test.db")}` });
    db = drizzle(libsqlClient);

    await libsqlClient.execute(`DROP TABLE IF EXISTS test_users`);
    await libsqlClient.execute(`
      CREATE TABLE test_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        age INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        role TEXT DEFAULT 'user'
      )
    `);

    vi.doMock("@/db/db", () => ({ db }));

    app = express();
    app.use(express.json());
    app.use(injectTestUser);
  });

  afterEach(() => {
    libsqlClient.close();
    vi.clearAllMocks();
  });

  describe("Basic CRUD Operations", () => {
    beforeEach(() => {
      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
        })
      );
      app.use(errorHandler);
    });

    describe("POST / - Create", () => {
      it("should create a new resource", async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "John Doe", email: "john@test.com", age: 30 })
          .expect(201);

        expect(response.body).toMatchObject({
          name: "John Doe",
          email: "john@test.com",
          age: 30,
        });
        expect(response.body.id).toBeDefined();
      });

      it("should return 400 for invalid data", async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "John Doe" })
          .expect(400);

        expect(response.body.error).toBeDefined();
      });

      it("should create multiple resources sequentially", async () => {
        const users = [
          { name: "User 1", email: "user1@test.com", age: 25 },
          { name: "User 2", email: "user2@test.com", age: 30 },
          { name: "User 3", email: "user3@test.com", age: 35 },
        ];

        for (const user of users) {
          const response = await request(app)
            .post("/users")
            .send(user)
            .expect(201);

          expect(response.body.name).toBe(user.name);
        }
      });
    });

    describe("GET / - List", () => {
      beforeEach(async () => {
        const users = [
          { name: "Alice", email: "alice@test.com", age: 25, status: "active" },
          { name: "Bob", email: "bob@test.com", age: 30, status: "active" },
          { name: "Charlie", email: "charlie@test.com", age: 35, status: "inactive" },
          { name: "Diana", email: "diana@test.com", age: 28, status: "active" },
          { name: "Eve", email: "eve@test.com", age: 32, status: "pending" },
        ];

        for (const user of users) {
          await request(app).post("/users").send(user);
        }
      });

      it("should list all resources", async () => {
        const response = await request(app).get("/users").expect(200);

        expect(response.body.items).toHaveLength(5);
        expect(response.body.hasMore).toBe(false);
      });

      it("should filter resources with == operator", async () => {
        const response = await request(app)
          .get('/users?filter=status=="active"')
          .expect(200);

        expect(response.body.items).toHaveLength(3);
        expect(
          response.body.items.every((u: any) => u.status === "active")
        ).toBe(true);
      });

      it("should filter resources with > operator", async () => {
        const response = await request(app)
          .get("/users?filter=age>30")
          .expect(200);

        expect(response.body.items).toHaveLength(2);
        expect(response.body.items.every((u: any) => u.age > 30)).toBe(true);
      });

      it("should filter resources with complex AND expression", async () => {
        const response = await request(app)
          .get('/users?filter=status=="active";age>=28')
          .expect(200);

        expect(response.body.items).toHaveLength(2);
      });

      it("should filter resources with OR expression", async () => {
        const response = await request(app)
          .get('/users?filter=status=="active",status=="pending"')
          .expect(200);

        expect(response.body.items).toHaveLength(4);
      });

      it("should apply pagination with limit", async () => {
        const response = await request(app)
          .get("/users?limit=2")
          .expect(200);

        expect(response.body.items).toHaveLength(2);
        expect(response.body.hasMore).toBe(true);
        expect(response.body.nextCursor).toBeDefined();
      });

      it("should apply cursor-based pagination", async () => {
        const page1 = await request(app).get("/users?limit=2").expect(200);

        expect(page1.body.items).toHaveLength(2);

        const page2 = await request(app)
          .get(`/users?limit=2&cursor=${page1.body.nextCursor}`)
          .expect(200);

        expect(page2.body.items).toHaveLength(2);
        expect(page2.body.items[0].id).not.toBe(page1.body.items[0].id);
      });

      it("should return total count when requested", async () => {
        const response = await request(app)
          .get("/users?totalCount=true&limit=2")
          .expect(200);

        expect(response.body.totalCount).toBe(5);
        expect(response.body.items).toHaveLength(2);
      });

      it("should apply field selection", async () => {
        const response = await request(app)
          .get("/users?select=id,name")
          .expect(200);

        const firstItem = response.body.items[0];
        expect(firstItem.id).toBeDefined();
        expect(firstItem.name).toBeDefined();
        expect(firstItem.email).toBeUndefined();
        expect(firstItem.age).toBeUndefined();
      });

      it("should apply ordering", async () => {
        const response = await request(app)
          .get("/users?orderBy=age:desc")
          .expect(200);

        const ages = response.body.items.map((u: any) => u.age);
        expect(ages).toEqual([...ages].sort((a, b) => b - a));
      });
    });

    describe("GET /:id - Get Single", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "Test User", email: "test@test.com", age: 25 });
        createdId = response.body.id;
      });

      it("should return a single resource by id", async () => {
        const response = await request(app)
          .get(`/users/${createdId}`)
          .expect(200);

        expect(response.body.id).toBe(createdId);
        expect(response.body.name).toBe("Test User");
      });

      it("should return 404 for non-existent resource", async () => {
        const response = await request(app).get("/users/99999").expect(404);

        expect(response.body.error.code).toBe("NOT_FOUND");
      });

      it("should apply field selection to single resource", async () => {
        const response = await request(app)
          .get(`/users/${createdId}?select=id,name`)
          .expect(200);

        expect(response.body.id).toBeDefined();
        expect(response.body.name).toBeDefined();
        expect(response.body.email).toBeUndefined();
      });
    });

    describe("PATCH /:id - Update", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "Original Name", email: "original@test.com", age: 25 });
        createdId = response.body.id;
      });

      it("should update a resource partially", async () => {
        const response = await request(app)
          .patch(`/users/${createdId}`)
          .send({ name: "Updated Name" })
          .expect(200);

        expect(response.body.name).toBe("Updated Name");
        expect(response.body.email).toBe("original@test.com");
      });

      it("should update multiple fields", async () => {
        const response = await request(app)
          .patch(`/users/${createdId}`)
          .send({ name: "New Name", age: 30 })
          .expect(200);

        expect(response.body.name).toBe("New Name");
        expect(response.body.age).toBe(30);
      });

      it("should return 404 for non-existent resource", async () => {
        await request(app)
          .patch("/users/99999")
          .send({ name: "Updated" })
          .expect(404);
      });
    });

    describe("PUT /:id - Replace", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "Original", email: "original@test.com", age: 25 });
        createdId = response.body.id;
      });

      it("should replace a resource completely", async () => {
        const response = await request(app)
          .put(`/users/${createdId}`)
          .send({ name: "Replaced", email: "replaced@test.com", age: 35 })
          .expect(200);

        expect(response.body.name).toBe("Replaced");
        expect(response.body.email).toBe("replaced@test.com");
        expect(response.body.age).toBe(35);
      });

      it("should return 404 for non-existent resource", async () => {
        await request(app)
          .put("/users/99999")
          .send({ name: "Test", email: "test@test.com", age: 30 })
          .expect(404);
      });
    });

    describe("DELETE /:id - Delete", () => {
      let createdId: number;

      beforeEach(async () => {
        const response = await request(app)
          .post("/users")
          .send({ name: "To Delete", email: "delete@test.com", age: 25 });
        createdId = response.body.id;
      });

      it("should delete a resource", async () => {
        await request(app).delete(`/users/${createdId}`).expect(204);

        await request(app).get(`/users/${createdId}`).expect(404);
      });

      it("should return 404 for non-existent resource", async () => {
        await request(app).delete("/users/99999").expect(404);
      });
    });

    describe("GET /count - Count", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await request(app).post("/users").send(user);
        }
      });

      it("should return total count", async () => {
        const response = await request(app).get("/users/count").expect(200);

        expect(response.body.count).toBe(3);
      });

      it("should return filtered count", async () => {
        const response = await request(app)
          .get('/users/count?filter=status=="active"')
          .expect(200);

        expect(response.body.count).toBe(2);
      });
    });

    describe("GET /aggregate - Aggregations", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, role: "admin" },
          { name: "User 2", email: "u2@test.com", age: 30, role: "admin" },
          { name: "User 3", email: "u3@test.com", age: 35, role: "user" },
          { name: "User 4", email: "u4@test.com", age: 28, role: "user" },
          { name: "User 5", email: "u5@test.com", age: 32, role: "user" },
        ];

        for (const user of users) {
          await request(app).post("/users").send(user);
        }
      });

      it("should return count aggregation", async () => {
        const response = await request(app)
          .get("/users/aggregate?count=true")
          .expect(200);

        expect(response.body.groups).toHaveLength(1);
        expect(response.body.groups[0].count).toBe(5);
      });

      it("should return grouped count", async () => {
        const response = await request(app)
          .get("/users/aggregate?groupBy=role&count=true")
          .expect(200);

        expect(response.body.groups).toHaveLength(2);
      });

      it("should return sum aggregation", async () => {
        const response = await request(app)
          .get("/users/aggregate?sum=age")
          .expect(200);

        expect(response.body.groups[0].sum.age).toBe(150);
      });

      it("should return avg aggregation", async () => {
        const response = await request(app)
          .get("/users/aggregate?avg=age")
          .expect(200);

        expect(response.body.groups[0].avg.age).toBe(30);
      });

      it("should return min/max aggregation", async () => {
        const response = await request(app)
          .get("/users/aggregate?min=age&max=age")
          .expect(200);

        expect(response.body.groups[0].min.age).toBe(25);
        expect(response.body.groups[0].max.age).toBe(35);
      });

      it("should combine multiple aggregations", async () => {
        const response = await request(app)
          .get("/users/aggregate?groupBy=role&count=true&avg=age&sum=age")
          .expect(200);

        expect(response.body.groups).toHaveLength(2);
        for (const group of response.body.groups) {
          expect(group.count).toBeDefined();
          expect(group.avg.age).toBeDefined();
          expect(group.sum.age).toBeDefined();
        }
      });
    });
  });

  describe("Batch Operations", () => {
    beforeEach(() => {
      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          batch: {
            create: 10,
            update: 10,
            delete: 10,
          },
        })
      );
      app.use(errorHandler);
    });

    describe("POST /batch - Batch Create", () => {
      it("should create multiple resources", async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25 },
          { name: "User 2", email: "u2@test.com", age: 30 },
          { name: "User 3", email: "u3@test.com", age: 35 },
        ];

        const response = await request(app)
          .post("/users/batch")
          .send({ items: users })
          .expect(200);

        expect(response.body.items).toHaveLength(3);
      });

      it("should reject batch exceeding limit", async () => {
        const users = Array.from({ length: 15 }, (_, i) => ({
          name: `User ${i}`,
          email: `u${i}@test.com`,
          age: 20 + i,
        }));

        await request(app)
          .post("/users/batch")
          .send({ items: users })
          .expect(400);
      });
    });

    describe("PATCH /batch - Batch Update", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await request(app).post("/users").send(user);
        }
      });

      it("should update multiple resources", async () => {
        const response = await request(app)
          .patch('/users/batch?filter=status=="active"')
          .send({ status: "updated" })
          .expect(200);

        expect(response.body.count).toBe(2);
      });
    });

    describe("DELETE /batch - Batch Delete", () => {
      beforeEach(async () => {
        const users = [
          { name: "User 1", email: "u1@test.com", age: 25, status: "active" },
          { name: "User 2", email: "u2@test.com", age: 30, status: "active" },
          { name: "User 3", email: "u3@test.com", age: 35, status: "inactive" },
        ];

        for (const user of users) {
          await request(app).post("/users").send(user);
        }
      });

      it("should delete multiple resources", async () => {
        const response = await request(app)
          .delete('/users/batch?filter=status=="active"')
          .expect(200);

        expect(response.body.count).toBe(2);

        const remaining = await request(app).get("/users");
        expect(remaining.body.items).toHaveLength(1);
      });
    });
  });

  describe("Lifecycle Hooks", () => {
    let beforeCreateCalled: boolean;
    let afterCreateCalled: boolean;
    let beforeUpdateCalled: boolean;
    let afterUpdateCalled: boolean;
    let beforeDeleteCalled: boolean;
    let afterDeleteCalled: boolean;

    beforeEach(() => {
      beforeCreateCalled = false;
      afterCreateCalled = false;
      beforeUpdateCalled = false;
      afterUpdateCalled = false;
      beforeDeleteCalled = false;
      afterDeleteCalled = false;

      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          hooks: {
            onBeforeCreate: async (ctx, data) => {
              beforeCreateCalled = true;
              return { ...data, status: "new" };
            },
            onAfterCreate: async (ctx, created) => {
              afterCreateCalled = true;
            },
            onBeforeUpdate: async (ctx, id, data) => {
              beforeUpdateCalled = true;
              return { ...data, status: "modified" };
            },
            onAfterUpdate: async (ctx, updated) => {
              afterUpdateCalled = true;
            },
            onBeforeDelete: async (ctx, id) => {
              beforeDeleteCalled = true;
            },
            onAfterDelete: async (ctx, deleted) => {
              afterDeleteCalled = true;
            },
          },
        })
      );
      app.use(errorHandler);
    });

    it("should call create hooks", async () => {
      const response = await request(app)
        .post("/users")
        .send({ name: "Test", email: "test@test.com", age: 25 });

      expect(beforeCreateCalled).toBe(true);
      expect(afterCreateCalled).toBe(true);
      expect(response.body.status).toBe("new");
    });

    it("should call update hooks", async () => {
      const created = await request(app)
        .post("/users")
        .send({ name: "Test", email: "test@test.com", age: 25 });

      beforeCreateCalled = false;
      afterCreateCalled = false;

      const response = await request(app)
        .patch(`/users/${created.body.id}`)
        .send({ name: "Updated" });

      expect(beforeUpdateCalled).toBe(true);
      expect(afterUpdateCalled).toBe(true);
      expect(response.body.status).toBe("modified");
    });

    it("should call delete hooks", async () => {
      const created = await request(app)
        .post("/users")
        .send({ name: "Test", email: "test@test.com", age: 25 });

      await request(app).delete(`/users/${created.body.id}`);

      expect(beforeDeleteCalled).toBe(true);
      expect(afterDeleteCalled).toBe(true);
    });
  });

  describe("Pagination Configuration", () => {
    beforeEach(async () => {
      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          pagination: {
            defaultLimit: 5,
            maxLimit: 10,
          },
        })
      );
      app.use(errorHandler);

      for (let i = 0; i < 20; i++) {
        await request(app)
          .post("/users")
          .send({ name: `User ${i}`, email: `u${i}@test.com`, age: 20 + i });
      }
    });

    it("should use default limit", async () => {
      const response = await request(app).get("/users").expect(200);

      expect(response.body.items).toHaveLength(5);
    });

    it("should respect max limit", async () => {
      const response = await request(app)
        .get("/users?limit=100")
        .expect(200);

      expect(response.body.items).toHaveLength(10);
    });

    it("should allow limit within bounds", async () => {
      const response = await request(app)
        .get("/users?limit=8")
        .expect(200);

      expect(response.body.items).toHaveLength(8);
    });
  });

  describe("Error Handling", () => {
    beforeEach(() => {
      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
        })
      );
      app.use(errorHandler);
    });

    it("should return proper error format for validation errors", async () => {
      const response = await request(app)
        .post("/users")
        .send({ invalid: "data" })
        .expect(400);

      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("VALIDATION_ERROR");
    });

    it("should return proper error format for not found", async () => {
      const response = await request(app)
        .get("/users/99999")
        .expect(404);

      expect(response.body.error).toBeDefined();
      expect(response.body.error.code).toBe("NOT_FOUND");
    });

    it("should handle invalid filter expressions", async () => {
      const response = await request(app)
        .get('/users?filter=invalid===syntax')
        .expect(400);

      expect(response.body.error).toBeDefined();
    });
  });

  describe("Custom Operators", () => {
    beforeEach(async () => {
      app.use(
        "/users",
        useResource(testUsersTable, {
          id: testUsersTable.id,
          db,
          customOperators: {
            "=contains=": {
              convert: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
              execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
            },
          },
        })
      );
      app.use(errorHandler);

      await request(app)
        .post("/users")
        .send({ name: "John Doe", email: "john@test.com", age: 30 });
      await request(app)
        .post("/users")
        .send({ name: "Jane Smith", email: "jane@test.com", age: 25 });
    });

    it("should use custom operator in filter", async () => {
      const response = await request(app)
        .get('/users?filter=name=contains="Doe"')
        .expect(200);

      expect(response.body.items).toHaveLength(1);
      expect(response.body.items[0].name).toBe("John Doe");
    });
  });
});
