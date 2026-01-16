import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  observabilityMiddleware,
  requestIdMiddleware,
  timingMiddleware,
  resourceContextMiddleware,
  getRequestId,
  getRequestDuration,
  createMetricsCollector,
  ObservabilityConfig,
  RequestMetrics,
} from "@/middleware/observability";

describe("Observability Middleware", () => {
  const createMockRequest = (overrides: Partial<Request> = {}): Request => {
    return {
      method: "GET",
      path: "/users",
      headers: {},
      get: vi.fn((header: string) => {
        const headers = overrides.headers as Record<string, string> | undefined;
        return headers?.[header.toLowerCase()];
      }),
      ...overrides,
    } as unknown as Request;
  };

  const createMockResponse = (): Response => {
    const listeners: Record<string, Function[]> = {};
    const res: Partial<Response> = {
      statusCode: 200,
      set: vi.fn().mockReturnThis(),
      on: vi.fn((event: string, callback: Function) => {
        listeners[event] = listeners[event] || [];
        listeners[event].push(callback);
        return res;
      }),
      emit: (event: string) => {
        listeners[event]?.forEach((cb) => cb());
      },
    };
    return res as Response & { emit: (event: string) => void };
  };

  describe("requestIdMiddleware", () => {
    it("should generate request ID if not present", () => {
      const middleware = requestIdMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect((req as any).requestId).toBeDefined();
      expect(res.set).toHaveBeenCalledWith("X-Request-Id", expect.any(String));
      expect(next).toHaveBeenCalled();
    });

    it("should use existing request ID from header", () => {
      const middleware = requestIdMiddleware();
      const existingId = "existing-request-id";
      const req = createMockRequest({
        headers: { "x-request-id": existingId },
      });
      (req.get as ReturnType<typeof vi.fn>).mockReturnValue(existingId);
      
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect((req as any).requestId).toBe(existingId);
      expect(res.set).toHaveBeenCalledWith("X-Request-Id", existingId);
    });
  });

  describe("timingMiddleware", () => {
    it("should record start time", () => {
      const middleware = timingMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect((req as any).startTime).toBeDefined();
      expect(next).toHaveBeenCalled();
    });
  });

  describe("observabilityMiddleware", () => {
    it("should combine request ID and timing", () => {
      const config: ObservabilityConfig = {
        enableRequestId: true,
        enableTiming: true,
      };
      const middleware = observabilityMiddleware(config);
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect((req as any).requestId).toBeDefined();
      expect((req as any).startTime).toBeDefined();
      expect(next).toHaveBeenCalled();
    });

    it("should call onMetrics callback on response finish", async () => {
      const onMetrics = vi.fn();
      const config: ObservabilityConfig = {
        enableRequestId: true,
        enableTiming: true,
        onMetrics,
      };
      const middleware = observabilityMiddleware(config);
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);
      
      // Simulate response finish
      (res as any).emit("finish");

      expect(onMetrics).toHaveBeenCalledWith(
        expect.objectContaining({
          requestId: expect.any(String),
          method: "GET",
          path: "/users",
          status: 200,
          duration: expect.any(Number),
        })
      );
    });

    it("should log slow queries when threshold exceeded", async () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
      const config: ObservabilityConfig = {
        enableTiming: true,
        enableSlowQueryLog: true,
        slowQueryThresholdMs: 0, // Everything is slow
      };
      const middleware = observabilityMiddleware(config);
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);
      
      // Small delay to ensure duration > 0
      await new Promise((r) => setTimeout(r, 1));
      (res as any).emit("finish");

      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });

  describe("resourceContextMiddleware", () => {
    it("should add resource context to request", () => {
      const middleware = resourceContextMiddleware("users");
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect((req as any).resource).toBe("users");
      expect(next).toHaveBeenCalled();
    });
  });

  describe("getRequestId", () => {
    it("should return request ID from request", () => {
      const req = createMockRequest();
      (req as any).requestId = "test-id";

      expect(getRequestId(req)).toBe("test-id");
    });

    it("should return undefined if not set", () => {
      const req = createMockRequest();

      expect(getRequestId(req)).toBeUndefined();
    });
  });

  describe("getRequestDuration", () => {
    it("should calculate duration from start time", () => {
      const req = createMockRequest();
      (req as any).startTime = process.hrtime.bigint() - BigInt(1000000); // 1ms ago

      const duration = getRequestDuration(req);

      expect(duration).toBeGreaterThanOrEqual(0);
    });

    it("should return 0 if start time not set", () => {
      const req = createMockRequest();

      expect(getRequestDuration(req)).toBe(0);
    });
  });

  describe("createMetricsCollector", () => {
    it("should collect metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });
      
      const metrics: RequestMetrics = {
        requestId: "test-1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      };

      collector.record(metrics);

      expect(collector.getRecent(10)).toHaveLength(1);
      expect(collector.getRecent(10)[0]).toEqual(metrics);
    });

    it("should limit stored metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 5 });
      
      for (let i = 0; i < 10; i++) {
        collector.record({
          requestId: `test-${i}`,
          method: "GET",
          path: "/users",
          resource: "users",
          operation: "list",
          status: 200,
          duration: 50,
          timestamp: Date.now(),
        });
      }

      expect(collector.getRecent(100)).toHaveLength(5);
    });

    it("should calculate statistics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });
      
      for (let i = 0; i < 5; i++) {
        collector.record({
          requestId: `test-${i}`,
          method: "GET",
          path: "/users",
          resource: "users",
          operation: "list",
          status: i < 4 ? 200 : 500,
          duration: 10 * (i + 1), // 10, 20, 30, 40, 50
          timestamp: Date.now(),
        });
      }

      const stats = collector.getStats();

      expect(stats.total).toBe(5);
      expect(stats.avgDuration).toBe(30);
      expect(stats.errorRate).toBe(0.2); // 1 out of 5
    });

    it("should filter by path", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });
      
      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });
      
      collector.record({
        requestId: "2",
        method: "GET",
        path: "/posts",
        resource: "posts",
        operation: "list",
        status: 200,
        duration: 30,
        timestamp: Date.now(),
      });

      const userMetrics = collector.getByPath("/users");
      
      expect(userMetrics).toHaveLength(1);
      expect(userMetrics[0].path).toBe("/users");
    });

    it("should filter slow requests", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });
      
      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });
      
      collector.record({
        requestId: "2",
        method: "GET",
        path: "/slow",
        resource: "slow",
        operation: "list",
        status: 200,
        duration: 1000,
        timestamp: Date.now(),
      });

      const slowRequests = collector.getSlow(100);
      
      expect(slowRequests).toHaveLength(1);
      expect(slowRequests[0].duration).toBe(1000);
    });

    it("should clear metrics", () => {
      const collector = createMetricsCollector({ maxMetrics: 100 });
      
      collector.record({
        requestId: "1",
        method: "GET",
        path: "/users",
        resource: "users",
        operation: "list",
        status: 200,
        duration: 50,
        timestamp: Date.now(),
      });

      collector.clear();

      expect(collector.getRecent(100)).toHaveLength(0);
    });
  });
});
