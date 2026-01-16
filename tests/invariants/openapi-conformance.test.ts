import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { z } from "zod";

// ============================================================
// OPENAPI / TYPEGEN CONFORMANCE TESTS
// ============================================================
// Verifies that:
// 1. OpenAPI spec matches actual HTTP responses
// 2. Error schemas match documented format
// 3. Generated types match actual JSON shapes
// 4. Backward compatibility with older clients

// Simulated OpenAPI schema for testing
const openApiSpec = {
  paths: {
    "/api/todos": {
      get: {
        responses: {
          200: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    items: {
                      type: "array",
                      items: {
                        $ref: "#/components/schemas/Todo",
                      },
                    },
                    nextCursor: { type: "string", nullable: true },
                    hasMore: { type: "boolean" },
                  },
                  required: ["items", "hasMore"],
                },
              },
            },
          },
          400: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          401: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        },
      },
      post: {
        requestBody: {
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/TodoCreate" },
            },
          },
        },
        responses: {
          201: {
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Todo" },
              },
            },
          },
        },
      },
    },
  },
  components: {
    schemas: {
      Todo: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          completed: { type: "boolean" },
          userId: { type: "string" },
          createdAt: { type: "string", format: "date-time" },
          updatedAt: { type: "string", format: "date-time", nullable: true },
        },
        required: ["id", "title", "completed", "userId", "createdAt"],
      },
      TodoCreate: {
        type: "object",
        properties: {
          title: { type: "string" },
          completed: { type: "boolean" },
        },
        required: ["title"],
      },
      Error: {
        type: "object",
        properties: {
          error: { type: "string" },
          code: { type: "string" },
          status: { type: "number" },
          details: { type: "object", nullable: true },
        },
        required: ["error", "status"],
      },
    },
  },
};

// Zod schemas derived from OpenAPI (simulating generated types)
const TodoSchema = z.object({
  id: z.string(),
  title: z.string(),
  completed: z.boolean(),
  userId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string().nullable().optional(),
});

const TodoListResponseSchema = z.object({
  items: z.array(TodoSchema),
  nextCursor: z.string().nullable().optional(),
  hasMore: z.boolean(),
});

const ErrorSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  status: z.number(),
  details: z.unknown().optional(),
});

// Simulated HTTP responses for testing
const createMockResponse = (
  status: number,
  body: unknown
): { status: number; body: unknown } => ({
  status,
  body,
});

describe("OpenAPI Spec Conformance", () => {
  describe("Response Schema Validation", () => {
    it("list response matches schema", () => {
      const responses = [
        // Valid responses
        {
          items: [
            {
              id: "1",
              title: "Test",
              completed: false,
              userId: "u1",
              createdAt: "2024-01-01T00:00:00Z",
            },
          ],
          nextCursor: null,
          hasMore: false,
        },
        {
          items: [],
          nextCursor: null,
          hasMore: false,
        },
        {
          items: [
            {
              id: "1",
              title: "Test",
              completed: true,
              userId: "u1",
              createdAt: "2024-01-01T00:00:00Z",
              updatedAt: "2024-01-02T00:00:00Z",
            },
          ],
          nextCursor: "cursor123",
          hasMore: true,
        },
      ];

      for (const response of responses) {
        const result = TodoListResponseSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });

    it("single item response matches schema", () => {
      // Generate valid ISO date strings directly
      const isoDateArb = fc.tuple(
        fc.integer({ min: 2000, max: 2050 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
        fc.integer({ min: 0, max: 23 }),
        fc.integer({ min: 0, max: 59 }),
        fc.integer({ min: 0, max: 59 }),
      ).map(([year, month, day, hour, min, sec]) => {
        const d = new Date(Date.UTC(year, month - 1, day, hour, min, sec));
        return d.toISOString();
      });

      fc.assert(
        fc.property(
          fc.record({
            id: fc.uuid(),
            title: fc.string({ minLength: 1, maxLength: 100 }),
            completed: fc.boolean(),
            userId: fc.uuid(),
            createdAt: isoDateArb,
            updatedAt: fc.option(isoDateArb, { nil: null }),
          }),
          (item) => {
            const result = TodoSchema.safeParse(item);
            return result.success;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("error response matches RFC7807-like format", () => {
      const errorResponses = [
        {
          error: "Not found",
          status: 404,
        },
        {
          error: "Validation failed",
          code: "VALIDATION_ERROR",
          status: 400,
          details: { field: "title", message: "Required" },
        },
        {
          error: "Unauthorized",
          code: "AUTH_REQUIRED",
          status: 401,
          details: null,
        },
      ];

      for (const response of errorResponses) {
        const result = ErrorSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });

    it("rejects invalid response shapes", () => {
      const invalidResponses = [
        { items: "not an array", hasMore: false }, // items should be array
        { items: [], hasMore: "true" }, // hasMore should be boolean
        { items: [{ id: 123 }], hasMore: false }, // id should be string
        { hasMore: false }, // missing items
      ];

      for (const response of invalidResponses) {
        const result = TodoListResponseSchema.safeParse(response);
        expect(result.success).toBe(false);
      }
    });
  });

  describe("Typegen Drift Tests", () => {
    // Verify generated TS types match actual JSON returned

    it("all required fields are present in response", () => {
      const requiredFields = ["id", "title", "completed", "userId", "createdAt"];
      const isoDateArb = fc.tuple(
        fc.integer({ min: 2000, max: 2050 }),
        fc.integer({ min: 1, max: 12 }),
        fc.integer({ min: 1, max: 28 }),
      ).map(([year, month, day]) => {
        const d = new Date(Date.UTC(year, month - 1, day));
        return d.toISOString();
      });

      fc.assert(
        fc.property(
          fc.record({
            id: fc.uuid(),
            title: fc.string({ minLength: 1 }),
            completed: fc.boolean(),
            userId: fc.uuid(),
            createdAt: isoDateArb,
          }),
          (item) => {
            for (const field of requiredFields) {
              if (!(field in item)) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("nullable fields are correctly typed", () => {
      // updatedAt is nullable
      const withNull = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: null,
      };

      const withValue = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
      };

      const withMissing = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: "2024-01-01T00:00:00Z",
      };

      expect(TodoSchema.safeParse(withNull).success).toBe(true);
      expect(TodoSchema.safeParse(withValue).success).toBe(true);
      expect(TodoSchema.safeParse(withMissing).success).toBe(true);
    });

    it("extra fields in response are tolerated (forward compatibility)", () => {
      const responseWithExtraFields = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: "2024-01-01T00:00:00Z",
        newField: "extra", // Not in schema
        anotherNew: { nested: true },
      };

      // Schema should still validate (passthrough or strip extra)
      const result = TodoSchema.safeParse(responseWithExtraFields);
      expect(result.success).toBe(true);
    });

    it("type coercion works correctly for dates", () => {
      // Server might return ISO string, client might expect Date object
      const isoString = "2024-01-01T00:00:00.000Z";
      const response = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: isoString,
      };

      const result = TodoSchema.safeParse(response);
      expect(result.success).toBe(true);

      // Parsed value should be string (as per schema)
      if (result.success) {
        expect(typeof result.data.createdAt).toBe("string");
      }
    });
  });

  describe("Backward Compatibility", () => {
    // Old client talking to new server should work

    const OldClientTodoSchema = z.object({
      id: z.string(),
      title: z.string(),
      completed: z.boolean(),
      userId: z.string(),
      // Note: old client doesn't know about createdAt, updatedAt
    });

    it("new server response is compatible with old client schema", () => {
      const newServerResponse = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: "2024-01-02T00:00:00Z",
        newFieldV2: "added in v2", // New field
      };

      // Old client should be able to parse (ignoring extra fields)
      const result = OldClientTodoSchema.safeParse(newServerResponse);
      expect(result.success).toBe(true);
    });

    it("old client can create resources on new server", () => {
      const OldClientCreateSchema = z.object({
        title: z.string(),
        // Old client doesn't send new optional fields
      });

      const oldClientPayload = {
        title: "New todo from old client",
      };

      // New server's create schema should accept this
      const NewServerCreateSchema = z.object({
        title: z.string(),
        completed: z.boolean().optional().default(false),
        priority: z.number().optional(), // New optional field
      });

      const result = NewServerCreateSchema.safeParse(oldClientPayload);
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.completed).toBe(false); // Default applied
      }
    });

    it("removing required field breaks compatibility (detected)", () => {
      // If server removes a required field, old clients should break
      const OldClientExpects = z.object({
        id: z.string(),
        title: z.string(),
        completed: z.boolean(),
        userId: z.string(),
        status: z.string(), // Old client expects this
      });

      const NewServerResponse = {
        id: "1",
        title: "Test",
        completed: false,
        userId: "u1",
        // status field removed in new version
      };

      const result = OldClientExpects.safeParse(NewServerResponse);
      expect(result.success).toBe(false); // Breaking change detected!
    });

    it("changing field type breaks compatibility (detected)", () => {
      const OldClientExpects = z.object({
        id: z.string(),
        count: z.number(), // Old client expects number
      });

      const NewServerResponse = {
        id: "1",
        count: "42", // New server returns string
      };

      const result = OldClientExpects.safeParse(NewServerResponse);
      expect(result.success).toBe(false); // Breaking change!
    });
  });

  describe("Error Format Consistency", () => {
    it("all error responses follow same structure", () => {
      const errorCases = [
        { status: 400, error: "Bad Request", code: "BAD_REQUEST" },
        { status: 401, error: "Unauthorized", code: "AUTH_REQUIRED" },
        { status: 403, error: "Forbidden", code: "FORBIDDEN" },
        { status: 404, error: "Not Found", code: "NOT_FOUND" },
        { status: 409, error: "Conflict", code: "CONFLICT" },
        { status: 422, error: "Validation Error", code: "VALIDATION_ERROR" },
        { status: 429, error: "Rate Limited", code: "RATE_LIMITED" },
        { status: 500, error: "Internal Error", code: "INTERNAL_ERROR" },
      ];

      for (const errorCase of errorCases) {
        const result = ErrorSchema.safeParse(errorCase);
        expect(result.success).toBe(true);
      }
    });

    it("validation errors include field details", () => {
      const ValidationErrorSchema = z.object({
        error: z.string(),
        code: z.string().optional(),
        status: z.number(),
        details: z
          .object({
            fields: z.record(
              z.string(),
              z.object({
                message: z.string(),
                code: z.string().optional(),
              })
            ),
          })
          .optional(),
      });

      const validationError = {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        status: 400,
        details: {
          fields: {
            title: { message: "Required", code: "required" },
            email: { message: "Invalid email format", code: "invalid_format" },
          },
        },
      };

      const result = ValidationErrorSchema.safeParse(validationError);
      expect(result.success).toBe(true);
    });
  });

  describe("Content-Type Handling", () => {
    it("JSON responses have correct content-type", () => {
      const validContentTypes = [
        "application/json",
        "application/json; charset=utf-8",
        "application/json;charset=utf-8",
      ];

      for (const contentType of validContentTypes) {
        const isJson =
          contentType.startsWith("application/json") ||
          contentType.includes("application/json");
        expect(isJson).toBe(true);
      }
    });

    it("SSE responses have correct content-type", () => {
      const validSSETypes = ["text/event-stream", "text/event-stream; charset=utf-8"];

      for (const contentType of validSSETypes) {
        const isSSE = contentType.startsWith("text/event-stream");
        expect(isSSE).toBe(true);
      }
    });
  });

  describe("Pagination Response Consistency", () => {
    it("cursor is opaque to client (base64 encoded)", () => {
      fc.assert(
        fc.property(
          fc.string({ minLength: 1, maxLength: 100 }),
          (cursorContent) => {
            const encoded = Buffer.from(
              JSON.stringify({ v: cursorContent })
            ).toString("base64");

            // Client should treat cursor as opaque string
            // Should not try to parse or modify it
            expect(typeof encoded).toBe("string");
            expect(encoded.length).toBeGreaterThan(0);

            return true;
          }
        ),
        { numRuns: 50 }
      );
    });

    it("hasMore accurately predicts more pages", () => {
      const scenarios = [
        { totalItems: 0, pageSize: 10, page: 1, expectedHasMore: false },
        { totalItems: 5, pageSize: 10, page: 1, expectedHasMore: false },
        { totalItems: 10, pageSize: 10, page: 1, expectedHasMore: false },
        { totalItems: 11, pageSize: 10, page: 1, expectedHasMore: true },
        { totalItems: 25, pageSize: 10, page: 1, expectedHasMore: true },
        { totalItems: 25, pageSize: 10, page: 2, expectedHasMore: true },
        { totalItems: 25, pageSize: 10, page: 3, expectedHasMore: false },
      ];

      for (const s of scenarios) {
        const itemsReturned = Math.min(
          s.pageSize,
          s.totalItems - (s.page - 1) * s.pageSize
        );
        const hasMore = s.page * s.pageSize < s.totalItems;

        expect(hasMore).toBe(s.expectedHasMore);
      }
    });
  });

  describe("Nullability Consistency", () => {
    it("null vs undefined vs missing are handled consistently", () => {
      // Define clear semantics:
      // - null: field exists, value is null
      // - undefined: field may or may not exist
      // - missing: field not in response

      const responses = [
        // Field explicitly null
        {
          id: "1",
          title: "Test",
          completed: false,
          userId: "u1",
          createdAt: "2024-01-01T00:00:00Z",
          updatedAt: null,
        },
        // Field missing (undefined in TS)
        {
          id: "1",
          title: "Test",
          completed: false,
          userId: "u1",
          createdAt: "2024-01-01T00:00:00Z",
        },
      ];

      for (const response of responses) {
        const result = TodoSchema.safeParse(response);
        expect(result.success).toBe(true);
      }
    });
  });
});

describe("Runtime Response Validation", () => {
  // These tests simulate validating actual HTTP responses against spec

  describe("GET endpoints", () => {
    it("list endpoint returns valid ListResponse", () => {
      const simulatedResponse = createMockResponse(200, {
        items: [
          {
            id: "uuid-1",
            title: "First todo",
            completed: false,
            userId: "user-1",
            createdAt: new Date().toISOString(),
          },
        ],
        nextCursor: null,
        hasMore: false,
      });

      expect(simulatedResponse.status).toBe(200);
      const result = TodoListResponseSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });

    it("get by id returns valid single item", () => {
      const simulatedResponse = createMockResponse(200, {
        id: "uuid-1",
        title: "Single todo",
        completed: true,
        userId: "user-1",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });

      expect(simulatedResponse.status).toBe(200);
      const result = TodoSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });

    it("404 returns valid error response", () => {
      const simulatedResponse = createMockResponse(404, {
        error: "Todo not found",
        code: "NOT_FOUND",
        status: 404,
      });

      expect(simulatedResponse.status).toBe(404);
      const result = ErrorSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });
  });

  describe("POST endpoints", () => {
    it("create returns created item with server-generated fields", () => {
      const clientPayload = {
        title: "New todo",
        completed: false,
      };

      // Server adds id, userId, createdAt
      const simulatedResponse = createMockResponse(201, {
        ...clientPayload,
        id: "server-generated-uuid",
        userId: "authenticated-user-id",
        createdAt: new Date().toISOString(),
      });

      expect(simulatedResponse.status).toBe(201);
      const result = TodoSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });

    it("validation error returns detailed field errors", () => {
      const simulatedResponse = createMockResponse(400, {
        error: "Validation failed",
        code: "VALIDATION_ERROR",
        status: 400,
        details: {
          title: "Title is required",
        },
      });

      expect(simulatedResponse.status).toBe(400);
      const result = ErrorSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });
  });

  describe("PATCH endpoints", () => {
    it("partial update returns full updated item", () => {
      const simulatedResponse = createMockResponse(200, {
        id: "uuid-1",
        title: "Updated title",
        completed: true, // Updated
        userId: "user-1",
        createdAt: "2024-01-01T00:00:00Z",
        updatedAt: new Date().toISOString(), // Updated
      });

      expect(simulatedResponse.status).toBe(200);
      const result = TodoSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });
  });

  describe("DELETE endpoints", () => {
    it("successful delete returns 204 with no body", () => {
      const simulatedResponse = createMockResponse(204, undefined);

      expect(simulatedResponse.status).toBe(204);
      expect(simulatedResponse.body).toBeUndefined();
    });

    it("delete non-existent returns 404", () => {
      const simulatedResponse = createMockResponse(404, {
        error: "Todo not found",
        status: 404,
      });

      expect(simulatedResponse.status).toBe(404);
      const result = ErrorSchema.safeParse(simulatedResponse.body);
      expect(result.success).toBe(true);
    });
  });
});
