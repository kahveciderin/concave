import { ZodError } from "zod";

export class ResourceError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code: string,
    public details?: unknown
  ) {
    super(message);
    this.name = "ResourceError";
  }
}

export class NotFoundError extends ResourceError {
  constructor(resource: string, id: string) {
    super(`${resource} with id '${id}' not found`, 404, "NOT_FOUND", {
      resource,
      id,
    });
    this.name = "NotFoundError";
  }
}

export class ValidationError extends ResourceError {
  constructor(message: string, details?: unknown) {
    super(message, 400, "VALIDATION_ERROR", details);
    this.name = "ValidationError";
  }
}

export class RateLimitError extends ResourceError {
  constructor(retryAfter: number) {
    super("Rate limit exceeded", 429, "RATE_LIMIT_EXCEEDED", { retryAfter });
    this.name = "RateLimitError";
  }
}

export class UnauthorizedError extends ResourceError {
  constructor(message = "Unauthorized") {
    super(message, 401, "UNAUTHORIZED");
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends ResourceError {
  constructor(message = "Forbidden") {
    super(message, 403, "FORBIDDEN");
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends ResourceError {
  constructor(message: string, details?: unknown) {
    super(message, 409, "CONFLICT", details);
    this.name = "ConflictError";
  }
}

export class BatchLimitError extends ResourceError {
  constructor(operation: string, limit: number, requested: number) {
    super(
      `Batch ${operation} limit exceeded. Max ${limit} items allowed, got ${requested}.`,
      400,
      "BATCH_LIMIT_EXCEEDED",
      { operation, limit, requested }
    );
    this.name = "BatchLimitError";
  }
}

export class FilterParseError extends ResourceError {
  constructor(message: string, position?: number) {
    super(`Invalid filter expression: ${message}`, 400, "FILTER_PARSE_ERROR", {
      position,
    });
    this.name = "FilterParseError";
  }
}

export const formatZodError = (
  error: ZodError
): { field: string; message: string }[] => {
  return error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
};

export const formatErrorResponse = (
  error: unknown
): { error: { code: string; message: string; details?: unknown } } => {
  if (error instanceof ResourceError) {
    return {
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
      },
    };
  }

  if (error instanceof ZodError) {
    return {
      error: {
        code: "VALIDATION_ERROR",
        message: "Validation failed",
        details: formatZodError(error),
      },
    };
  }

  if (error instanceof Error) {
    return {
      error: {
        code: "INTERNAL_ERROR",
        message:
          process.env.NODE_ENV === "production"
            ? "Internal server error"
            : error.message,
      },
    };
  }

  return {
    error: {
      code: "UNKNOWN_ERROR",
      message: "An unknown error occurred",
    },
  };
};
