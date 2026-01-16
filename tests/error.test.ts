import { describe, it, expect } from "vitest";
import {
  ResourceError,
  NotFoundError,
  ValidationError,
  RateLimitError,
  UnauthorizedError,
  ForbiddenError,
  ConflictError,
  BatchLimitError,
  FilterParseError,
  formatZodError,
  formatErrorResponse,
} from "@/resource/error";
import { ZodError } from "zod";

describe("Error Classes", () => {
  describe("ResourceError", () => {
    it("should create base resource error", () => {
      const error = new ResourceError("Test error", 500, "TEST_ERROR", {
        foo: "bar",
      });

      expect(error.message).toBe("Test error");
      expect(error.statusCode).toBe(500);
      expect(error.code).toBe("TEST_ERROR");
      expect(error.details).toEqual({ foo: "bar" });
      expect(error.name).toBe("ResourceError");
    });
  });

  describe("NotFoundError", () => {
    it("should create not found error", () => {
      const error = new NotFoundError("users", "123");

      expect(error.message).toBe("users with id '123' not found");
      expect(error.statusCode).toBe(404);
      expect(error.code).toBe("NOT_FOUND");
      expect(error.details).toEqual({ resource: "users", id: "123" });
    });
  });

  describe("ValidationError", () => {
    it("should create validation error", () => {
      const error = new ValidationError("Invalid input", { field: "email" });

      expect(error.message).toBe("Invalid input");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.details).toEqual({ field: "email" });
    });
  });

  describe("RateLimitError", () => {
    it("should create rate limit error", () => {
      const error = new RateLimitError(60);

      expect(error.message).toBe("Rate limit exceeded");
      expect(error.statusCode).toBe(429);
      expect(error.code).toBe("RATE_LIMIT_EXCEEDED");
      expect(error.details).toEqual({ retryAfter: 60 });
    });
  });

  describe("UnauthorizedError", () => {
    it("should create unauthorized error with default message", () => {
      const error = new UnauthorizedError();

      expect(error.message).toBe("Unauthorized");
      expect(error.statusCode).toBe(401);
      expect(error.code).toBe("UNAUTHORIZED");
    });

    it("should create unauthorized error with custom message", () => {
      const error = new UnauthorizedError("Token expired");

      expect(error.message).toBe("Token expired");
    });
  });

  describe("ForbiddenError", () => {
    it("should create forbidden error", () => {
      const error = new ForbiddenError("Access denied");

      expect(error.message).toBe("Access denied");
      expect(error.statusCode).toBe(403);
      expect(error.code).toBe("FORBIDDEN");
    });
  });

  describe("ConflictError", () => {
    it("should create conflict error", () => {
      const error = new ConflictError("Email already exists", {
        field: "email",
      });

      expect(error.message).toBe("Email already exists");
      expect(error.statusCode).toBe(409);
      expect(error.code).toBe("CONFLICT");
    });
  });

  describe("BatchLimitError", () => {
    it("should create batch limit error", () => {
      const error = new BatchLimitError("create", 50, 100);

      expect(error.message).toBe(
        "Batch create limit exceeded. Max 50 items allowed, got 100."
      );
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("BATCH_LIMIT_EXCEEDED");
      expect(error.details).toEqual({
        operation: "create",
        limit: 50,
        requested: 100,
      });
    });
  });

  describe("FilterParseError", () => {
    it("should create filter parse error", () => {
      const error = new FilterParseError("Unexpected token", { position: 10 });

      expect(error.message).toBe("Invalid filter expression: Unexpected token");
      expect(error.statusCode).toBe(400);
      expect(error.code).toBe("FILTER_PARSE_ERROR");
      expect(error.details).toEqual({ position: 10 });
    });

    it("should include suggestions and allowed values", () => {
      const error = new FilterParseError("Unknown operator", {
        position: 5,
        suggestion: "Did you mean '=='?",
        allowedOperators: ["==", "!=", ">", "<"],
      });

      expect(error.statusCode).toBe(400);
      expect(error.details).toMatchObject({
        position: 5,
        suggestion: "Did you mean '=='?",
        allowedOperators: ["==", "!=", ">", "<"],
      });
    });
  });

  describe("formatZodError", () => {
    it("should format Zod errors", () => {
      const zodError = new ZodError([
        {
          code: "invalid_type",
          expected: "string",
          received: "number",
          path: ["email"],
          message: "Expected string, received number",
        },
        {
          code: "too_small",
          minimum: 1,
          type: "string",
          inclusive: true,
          exact: false,
          path: ["name"],
          message: "String must contain at least 1 character(s)",
        },
      ]);

      const formatted = formatZodError(zodError);

      expect(formatted).toEqual([
        { field: "email", message: "Expected string, received number" },
        {
          field: "name",
          message: "String must contain at least 1 character(s)",
        },
      ]);
    });
  });

  describe("formatErrorResponse", () => {
    it("should format ResourceError", () => {
      const error = new NotFoundError("users", "123");
      const response = formatErrorResponse(error);

      expect(response).toEqual({
        error: {
          code: "NOT_FOUND",
          message: "users with id '123' not found",
          details: { resource: "users", id: "123" },
        },
      });
    });

    it("should format ZodError", () => {
      const zodError = new ZodError([
        {
          code: "invalid_type",
          expected: "string",
          received: "number",
          path: ["email"],
          message: "Expected string",
        },
      ]);

      const response = formatErrorResponse(zodError);

      expect(response.error.code).toBe("VALIDATION_ERROR");
      expect(response.error.message).toBe("Validation failed");
      expect(response.error.details).toEqual([
        { field: "email", message: "Expected string" },
      ]);
    });

    it("should format generic Error", () => {
      const error = new Error("Something went wrong");
      const response = formatErrorResponse(error);

      expect(response.error.code).toBe("INTERNAL_ERROR");
      expect(response.error.message).toBe("Something went wrong");
    });

    it("should format unknown error", () => {
      const response = formatErrorResponse("string error");

      expect(response.error.code).toBe("UNKNOWN_ERROR");
      expect(response.error.message).toBe("An unknown error occurred");
    });
  });
});
