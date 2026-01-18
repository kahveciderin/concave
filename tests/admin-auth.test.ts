import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import request from "supertest";
import {
  createAdminAuthMiddleware,
  logAdminAction,
  getAdminAuditLog,
  clearAdminAuditLog,
  getAdminUser,
  detectEnvironment,
} from "../src/ui/admin-auth";

describe("Admin Auth", () => {
  let app: Express;
  const originalEnv = process.env.NODE_ENV;

  beforeEach(() => {
    app = express();
    clearAdminAuditLog();
  });

  afterEach(() => {
    process.env.NODE_ENV = originalEnv;
  });

  describe("detectEnvironment", () => {
    it("returns development for no NODE_ENV", () => {
      delete process.env.NODE_ENV;
      expect(detectEnvironment()).toBe("development");
    });

    it("returns production for NODE_ENV=production", () => {
      process.env.NODE_ENV = "production";
      expect(detectEnvironment()).toBe("production");
    });

    it("returns staging for NODE_ENV=staging", () => {
      process.env.NODE_ENV = "staging";
      expect(detectEnvironment()).toBe("staging");
    });
  });

  describe("createAdminAuthMiddleware", () => {
    it("allows access in development mode without auth", async () => {
      process.env.NODE_ENV = "development";

      const middleware = createAdminAuthMiddleware({ mode: "development" });
      app.use(middleware);
      app.get("/test", (req: Request, res: Response) => {
        const user = getAdminUser(req);
        res.json({ user });
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.user).toBeDefined();
    });

    it("requires auth in production mode", async () => {
      const middleware = createAdminAuthMiddleware({ mode: "production" });
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      const res = await request(app).get("/test");
      expect(res.status).toBe(401);
    });

    it("allows access with valid API key", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use(middleware);
      app.get("/test", (req: Request, res: Response) => {
        const user = getAdminUser(req);
        res.json({ user });
      });

      const res = await request(app)
        .get("/test")
        .set("X-Admin-API-Key", "secret-key");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("api-key");
    });

    it("allows access with Bearer token", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use(middleware);
      app.get("/test", (req: Request, res: Response) => {
        const user = getAdminUser(req);
        res.json({ user });
      });

      const res = await request(app)
        .get("/test")
        .set("Authorization", "Bearer secret-key");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("api-key");
    });

    it("rejects invalid API key", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { apiKey: "secret-key" },
      });
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      const res = await request(app)
        .get("/test")
        .set("X-Admin-API-Key", "wrong-key");
      expect(res.status).toBe(401);
    });

    it("allows access when auth is disabled", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "development",
        auth: { disabled: true },
      });
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
    });

    it("enforces IP allowlist in production", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: { disabled: true },
        allowedIPs: ["192.168.1.1"],
      });
      app.set("trust proxy", true);
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      const res = await request(app)
        .get("/test")
        .set("X-Forwarded-For", "10.0.0.1");
      expect(res.status).toBe(403);
    });

    it("enforces required role", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: {
          authenticate: async () => ({
            id: "user1",
            email: "user@test.com",
            roles: ["viewer"],
          }),
        },
        authorization: { requiredRole: "admin" },
      });
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      const res = await request(app).get("/test");
      expect(res.status).toBe(403);
    });

    it("uses custom authenticate function", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "production",
        auth: {
          authenticate: async () => ({
            id: "custom",
            email: "custom@test.com",
            roles: ["admin"],
          }),
        },
      });
      app.use(middleware);
      app.get("/test", (req: Request, res: Response) => {
        const user = getAdminUser(req);
        res.json({ user });
      });

      const res = await request(app).get("/test");
      expect(res.status).toBe(200);
      expect(res.body.user.id).toBe("custom");
    });

    it("enforces rate limit", async () => {
      const middleware = createAdminAuthMiddleware({
        mode: "development",
        auth: { disabled: true },
        rateLimit: { windowMs: 1000, maxRequests: 2 },
      });
      app.use(middleware);
      app.get("/test", (_req: Request, res: Response) => res.json({ ok: true }));

      await request(app).get("/test");
      await request(app).get("/test");
      const res = await request(app).get("/test");
      expect(res.status).toBe(429);
    });
  });

  describe("Admin Audit Log", () => {
    it("logs admin actions", () => {
      logAdminAction({
        userId: "user-1",
        userEmail: "admin@test.com",
        operation: "test_operation",
        reason: "Testing",
      });

      const log = getAdminAuditLog();
      expect(log).toHaveLength(1);
      expect(log[0].userId).toBe("user-1");
      expect(log[0].operation).toBe("test_operation");
      expect(log[0].timestamp).toBeDefined();
    });

    it("supports pagination", () => {
      for (let i = 0; i < 10; i++) {
        logAdminAction({
          userId: `user-${i}`,
          userEmail: `admin${i}@test.com`,
          operation: "test",
        });
      }

      const page1 = getAdminAuditLog(3, 0);
      expect(page1).toHaveLength(3);

      const page2 = getAdminAuditLog(3, 3);
      expect(page2).toHaveLength(3);
      expect(page2[0].userId).not.toBe(page1[0].userId);
    });

    it("maintains order (newest first)", () => {
      logAdminAction({ userId: "first", userEmail: "a@t.com", operation: "a" });
      logAdminAction({ userId: "second", userEmail: "b@t.com", operation: "b" });

      const log = getAdminAuditLog();
      expect(log[0].userId).toBe("second");
      expect(log[1].userId).toBe("first");
    });

    it("clears the log", () => {
      logAdminAction({ userId: "test", userEmail: "t@t.com", operation: "test" });
      expect(getAdminAuditLog()).toHaveLength(1);

      clearAdminAuditLog();
      expect(getAdminAuditLog()).toHaveLength(0);
    });

    it("includes before/after values for mutations", () => {
      logAdminAction({
        userId: "admin",
        userEmail: "admin@test.com",
        operation: "update",
        resource: "users",
        resourceId: "123",
        beforeValue: { name: "Old" },
        afterValue: { name: "New" },
      });

      const log = getAdminAuditLog();
      expect(log[0].beforeValue).toEqual({ name: "Old" });
      expect(log[0].afterValue).toEqual({ name: "New" });
    });
  });
});
