import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import express, { Express } from "express";
import request from "supertest";
import {
  createHealthEndpoints,
  runLivenessChecks,
  runReadinessChecks,
  checkEventLoop,
  checkMemory,
  checkKV,
} from "../src/health";
import { createMemoryKV } from "../src/kv";

describe("Health Endpoints", () => {
  let app: Express;

  beforeEach(() => {
    app = express();
  });

  describe("createHealthEndpoints", () => {
    it("creates router with healthz and readyz endpoints", async () => {
      const router = createHealthEndpoints();
      app.use(router);

      const healthzRes = await request(app).get("/healthz");
      expect(healthzRes.status).toBe(200);
      expect(healthzRes.body.status).toBe("healthy");
      expect(healthzRes.body.timestamp).toBeDefined();
      expect(healthzRes.body.uptime).toBeGreaterThanOrEqual(0);

      const readyzRes = await request(app).get("/readyz");
      expect(readyzRes.status).toBe(200);
      expect(readyzRes.body.status).toBe("healthy");
    });

    it("supports custom base path", async () => {
      const router = createHealthEndpoints({ basePath: "/health" });
      app.use(router);

      const res = await request(app).get("/health/healthz");
      expect(res.status).toBe(200);
    });

    it("returns disabled when enabled is false", async () => {
      const router = createHealthEndpoints({ enabled: false });
      app.use(router);

      const res = await request(app).get("/healthz");
      expect(res.status).toBe(404);
    });

    it("includes version in response", async () => {
      const router = createHealthEndpoints({ version: "1.0.0" });
      app.use(router);

      const res = await request(app).get("/healthz");
      expect(res.body.version).toBe("1.0.0");
    });

    it("supports HEAD requests", async () => {
      const router = createHealthEndpoints();
      app.use(router);

      const healthzHead = await request(app).head("/healthz");
      expect(healthzHead.status).toBe(200);

      const readyzHead = await request(app).head("/readyz");
      expect(readyzHead.status).toBe(200);
    });
  });

  describe("Liveness Checks", () => {
    it("checks event loop lag", async () => {
      const result = await checkEventLoop(100);
      expect(result.name).toBe("event_loop");
      expect(result.healthy).toBe(true);
      expect(result.latencyMs).toBeDefined();
    });

    it("checks memory usage", async () => {
      const result = await checkMemory(90);
      expect(result.name).toBe("memory");
      expect(result.healthy).toBe(true);
    });

    it("runs all liveness checks", async () => {
      const results = await runLivenessChecks();
      expect(results).toHaveLength(2);
      expect(results.map((r) => r.name)).toContain("event_loop");
      expect(results.map((r) => r.name)).toContain("memory");
    });
  });

  describe("Readiness Checks", () => {
    it("checks KV connection", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const result = await checkKV(kv);
      expect(result.name).toBe("kv");
      expect(result.healthy).toBe(true);
      await kv.disconnect();
    });

    it("runs readiness checks with KV", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const results = await runReadinessChecks({ kv });
      expect(results).toHaveLength(1);
      expect(results[0].name).toBe("kv");
      expect(results[0].healthy).toBe(true);
      await kv.disconnect();
    });

    it("returns unhealthy for custom check failure", async () => {
      const results = await runReadinessChecks({
        custom: async () => ({
          healthy: false,
          name: "custom",
          message: "Custom check failed",
        }),
      });
      expect(results[0].healthy).toBe(false);
      expect(results[0].message).toBe("Custom check failed");
    });
  });

  describe("Integration", () => {
    it("returns 503 when check fails", async () => {
      const router = createHealthEndpoints({
        thresholds: { eventLoopLagMs: 0 },
      });
      app.use(router);

      await new Promise((resolve) => setTimeout(resolve, 10));

      const res = await request(app).get("/healthz");
      expect(res.status).toBe(503);
      expect(res.body.status).toBe("unhealthy");
    });

    it("includes KV check in readyz when configured", async () => {
      const kv = createMemoryKV();
      await kv.connect();
      const router = createHealthEndpoints({
        checks: { kv },
      });
      app.use(router);

      const res = await request(app).get("/readyz");
      expect(res.status).toBe(200);
      expect(res.body.checks).toBeDefined();
      expect(res.body.checks.some((c: { name: string }) => c.name === "kv")).toBe(true);
      await kv.disconnect();
    });
  });
});
