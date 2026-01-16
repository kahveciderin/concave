import { describe, it, expect, vi, beforeEach } from "vitest";
import { Request, Response, NextFunction } from "express";
import {
  versioningMiddleware,
  addFieldDeprecationWarnings,
  wrapWithVersion,
  checkMinimumVersion,
  createVersionChecker,
  schemaVersionMiddleware,
  formatSchemaVersionEvent,
  CONCAVE_VERSION,
  CURSOR_VERSION_HEADER,
  SCHEMA_VERSION_HEADER,
  VersioningConfig,
  DeprecationWarning,
} from "@/middleware/versioning";

describe("Versioning Middleware", () => {
  const createMockRequest = (overrides: Partial<Request> = {}): Request => {
    return {
      method: "GET",
      path: "/users",
      query: {},
      headers: {},
      get: vi.fn((header: string) => {
        const headers = overrides.headers as Record<string, string> | undefined;
        return headers?.[header.toLowerCase()];
      }),
      ...overrides,
    } as unknown as Request;
  };

  const createMockResponse = (): Response => {
    const res: Partial<Response> = {
      statusCode: 200,
      set: vi.fn().mockReturnThis(),
      json: vi.fn().mockReturnThis(),
      status: vi.fn().mockReturnThis(),
    };
    return res as Response;
  };

  describe("CONCAVE_VERSION", () => {
    it("should be a valid semver string", () => {
      expect(CONCAVE_VERSION).toMatch(/^\d+\.\d+\.\d+/);
      expect(CONCAVE_VERSION).toBe("1.0.0");
    });
  });

  describe("versioningMiddleware", () => {
    it("should set version header on response", () => {
      const middleware = versioningMiddleware();
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith("X-Concave-Version", CONCAVE_VERSION);
      expect(next).toHaveBeenCalled();
    });

    it("should add deprecation warning header for affected paths", () => {
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/users"],
            message: "Use /v2/users instead",
            sunsetDate: new Date("2025-06-01"),
          },
        ],
      };
      const middleware = versioningMiddleware(config);
      const req = createMockRequest({ path: "/users" });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith("X-Concave-Warn", "Use /v2/users instead");
      expect(res.set).toHaveBeenCalledWith("Deprecation", "2025-06-01");
      expect(res.set).toHaveBeenCalledWith("Sunset", expect.any(String));
    });

    it("should set Sunset header when sunsetDate is provided", () => {
      const sunsetDate = new Date("2025-12-31");
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/old-endpoint"],
            message: "Deprecated",
            sunsetDate,
          },
        ],
      };
      const middleware = versioningMiddleware(config);
      const req = createMockRequest({ path: "/old-endpoint" });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith("Sunset", sunsetDate.toUTCString());
    });

    it("should not add warnings for unaffected paths", () => {
      const config: VersioningConfig = {
        deprecations: [
          {
            affectedPaths: ["/old-api"],
            message: "Deprecated",
          },
        ],
      };
      const middleware = versioningMiddleware(config);
      const req = createMockRequest({ path: "/users" });
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      // Should only have version header, not deprecation
      expect(res.set).toHaveBeenCalledTimes(1);
      expect(res.set).toHaveBeenCalledWith("X-Concave-Version", CONCAVE_VERSION);
    });
  });

  describe("addFieldDeprecationWarnings", () => {
    it("should add warnings for deprecated fields", () => {
      const items = [
        { id: "1", legacyField: "old", newField: "new" },
        { id: "2", legacyField: "old2", newField: "new2" },
      ];
      const deprecatedFields = [
        {
          field: "legacyField",
          replacement: "newField",
          message: "legacyField is deprecated",
        },
      ];

      const result = addFieldDeprecationWarnings(items, deprecatedFields);

      expect(result[0]._warnings).toContainEqual(
        expect.objectContaining({
          field: "legacyField",
          replacement: "newField",
        })
      );
    });

    it("should not add warnings if field not present", () => {
      const items = [{ id: "1", newField: "value" }];
      const deprecatedFields = [
        {
          field: "legacyField",
          replacement: "newField",
          message: "deprecated",
        },
      ];

      const result = addFieldDeprecationWarnings(items, deprecatedFields);

      expect(result[0]._warnings).toBeUndefined();
    });
  });

  describe("wrapWithVersion", () => {
    it("should wrap data with version info", () => {
      const data = { users: [{ id: "1" }] };

      const result = wrapWithVersion(data);

      expect(result.version).toBe(CONCAVE_VERSION);
      expect(result.data).toEqual(data);
      expect(result.timestamp).toBeDefined();
    });

    it("should include warnings when provided", () => {
      const data = { users: [] };
      const warnings = [{ type: "deprecation", message: "Test warning" }];

      const result = wrapWithVersion(data, warnings);

      expect(result.warnings).toEqual(warnings);
    });
  });

  describe("checkMinimumVersion", () => {
    it("should return true for version >= minimum", () => {
      expect(checkMinimumVersion("2.0.0", "1.0.0").supported).toBe(true);
      expect(checkMinimumVersion("1.0.0", "1.0.0").supported).toBe(true);
      expect(checkMinimumVersion("1.1.0", "1.0.0").supported).toBe(true);
    });

    it("should return false for version < minimum", () => {
      expect(checkMinimumVersion("0.9.0", "1.0.0").supported).toBe(false);
      expect(checkMinimumVersion("1.0.0", "2.0.0").supported).toBe(false);
    });

    it("should handle pre-release versions", () => {
      expect(checkMinimumVersion("1.0.0-beta", "1.0.0").supported).toBe(false);
    });
  });

  describe("createVersionChecker", () => {
    it("should pass requests with valid version", () => {
      const middleware = createVersionChecker("1.0.0");
      const req = createMockRequest({
        headers: { "x-concave-client-version": "2.0.0" },
      });

      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });

    it("should reject requests with old version", () => {
      const middleware = createVersionChecker("2.0.0");
      const req = createMockRequest({
        headers: { "x-concave-client-version": "1.0.0" },
      });

      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.status).toHaveBeenCalledWith(400);
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "/__concave/problems/unsupported-version",
          status: 400,
        })
      );
      expect(next).not.toHaveBeenCalled();
    });

    it("should pass requests without version header", () => {
      const middleware = createVersionChecker("1.0.0");
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(next).toHaveBeenCalled();
    });
  });

  describe("schemaVersionMiddleware", () => {
    it("should set schema version header", () => {
      const middleware = schemaVersionMiddleware(5);
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith(SCHEMA_VERSION_HEADER, "5");
      expect(next).toHaveBeenCalled();
    });

    it("should accept string version", () => {
      const middleware = schemaVersionMiddleware("10");
      const req = createMockRequest();
      const res = createMockResponse();
      const next = vi.fn();

      middleware(req, res, next);

      expect(res.set).toHaveBeenCalledWith(SCHEMA_VERSION_HEADER, "10");
    });
  });

  describe("formatSchemaVersionEvent", () => {
    it("should format schema version SSE event", () => {
      const event = formatSchemaVersionEvent(3, "users", ["added email field"]);

      expect(event).toContain("event: schemaVersion");
      expect(event).toContain('"resource":"users"');
      expect(event).toContain('"version":3');
      expect(event).toContain('"changes":["added email field"]');
    });
  });

  describe("Header constants", () => {
    it("should have correct header names", () => {
      expect(CURSOR_VERSION_HEADER).toBe("X-Concave-Cursor-Version");
      expect(SCHEMA_VERSION_HEADER).toBe("X-Concave-Schema-Version");
    });
  });
});
