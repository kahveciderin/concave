# Error Handling

Concave provides consistent error handling across both server and client with typed errors and detailed error responses.

## Server-Side Errors

### Error Response Format

All errors follow a consistent JSON format:

```json
{
  "error": {
    "code": "ERROR_CODE",
    "message": "Human-readable error message",
    "details": { /* optional additional context */ }
  }
}
```

### Error Types

| Code | HTTP Status | Description |
|------|-------------|-------------|
| `NOT_FOUND` | 404 | Resource not found |
| `VALIDATION_ERROR` | 400 | Invalid input data |
| `UNAUTHORIZED` | 401 | Authentication required |
| `FORBIDDEN` | 403 | Insufficient permissions |
| `RATE_LIMIT_EXCEEDED` | 429 | Too many requests |
| `BATCH_LIMIT_EXCEEDED` | 400 | Batch size exceeded |
| `FILTER_PARSE_ERROR` | 400 | Invalid filter syntax |
| `CONFLICT` | 409 | Resource conflict |
| `INTERNAL_ERROR` | 500 | Server error |

### Built-in Error Classes

```typescript
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  BatchLimitError,
  FilterParseError,
  ConflictError,
  ResourceError,
} from "concave/resource";

// Throw in hooks or procedures
throw new NotFoundError("users", "123");
// -> 404: { error: { code: "NOT_FOUND", message: "users with id '123' not found" } }

throw new ValidationError("Email is required", { field: "email" });
// -> 400: { error: { code: "VALIDATION_ERROR", message: "Email is required", details: { field: "email" } } }

throw new ForbiddenError("Cannot delete admin users");
// -> 403: { error: { code: "FORBIDDEN", message: "Cannot delete admin users" } }
```

### Error Middleware

Add error handling middleware to your Express app:

```typescript
import { asyncHandler, formatErrorResponse } from "concave/middleware";

// After all routes
app.use((err, req, res, next) => {
  const status = err.statusCode || err.status || 500;
  const response = formatErrorResponse(err);
  res.status(status).json(response);
});
```

### Validation Errors

Validation errors from Zod include field-level details:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Validation failed",
    "details": [
      { "field": "email", "message": "Invalid email format" },
      { "field": "age", "message": "Expected number, received string" }
    ]
  }
}
```

## Client-Side Error Handling

### TransportError

The client throws `TransportError` for all HTTP errors:

```typescript
import { TransportError } from "concave/client";

try {
  await users.get("nonexistent");
} catch (error) {
  if (error instanceof TransportError) {
    console.log(error.status);   // 404
    console.log(error.code);     // "NOT_FOUND"
    console.log(error.message);  // "User with id 'nonexistent' not found"
    console.log(error.details);  // { resource: "users", id: "nonexistent" }
  }
}
```

### Status Check Methods

```typescript
try {
  await users.get("123");
} catch (error) {
  if (error instanceof TransportError) {
    if (error.isNotFound()) {
      // Handle 404
      showNotFoundPage();
    } else if (error.isUnauthorized()) {
      // Handle 401
      redirectToLogin();
    } else if (error.isForbidden()) {
      // Handle 403
      showPermissionDenied();
    } else if (error.isValidationError()) {
      // Handle 400
      showValidationErrors(error.details);
    } else if (error.isRateLimited()) {
      // Handle 429
      showRateLimitMessage();
    } else if (error.isServerError()) {
      // Handle 5xx
      showServerError();
    }
  }
}
```

### Handling Specific Operations

```typescript
// Create with validation handling
async function createUser(data: UserInput) {
  try {
    return await users.create(data);
  } catch (error) {
    if (error instanceof TransportError && error.isValidationError()) {
      // Extract field errors
      const fieldErrors = error.details as Array<{ field: string; message: string }>;
      return { success: false, errors: fieldErrors };
    }
    throw error;
  }
}

// Delete with not-found handling
async function deleteUser(id: string) {
  try {
    await users.delete(id);
    return true;
  } catch (error) {
    if (error instanceof TransportError && error.isNotFound()) {
      // Already deleted or never existed
      return true;
    }
    throw error;
  }
}
```

### Global Error Handler

```typescript
const client = createClient({
  baseUrl: "/api",
  onError: (error) => {
    // Called for offline mutation failures
    if (error instanceof TransportError) {
      if (error.isUnauthorized()) {
        // Token expired, refresh and retry
        refreshToken();
      } else if (error.isServerError()) {
        // Log to error tracking service
        errorTracker.capture(error);
      }
    }
  },
  onAuthError: () => {
    // Called specifically for 401 errors
    redirectToLogin();
  },
});
```

## Error Handling Patterns

### Retry with Backoff

```typescript
async function withRetry<T>(
  fn: () => Promise<T>,
  maxRetries = 3,
  delay = 1000
): Promise<T> {
  let lastError: Error;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error as Error;

      if (error instanceof TransportError) {
        // Don't retry client errors
        if (error.status < 500) throw error;
      }

      // Wait before retry
      await new Promise(r => setTimeout(r, delay * Math.pow(2, attempt)));
    }
  }

  throw lastError!;
}

// Usage
const user = await withRetry(() => users.get("123"));
```

### Form Validation

```typescript
interface FormState {
  values: Record<string, string>;
  errors: Record<string, string>;
  isSubmitting: boolean;
}

async function handleSubmit(state: FormState): Promise<FormState> {
  state.isSubmitting = true;
  state.errors = {};

  try {
    await users.create(state.values);
    return { ...state, isSubmitting: false };
  } catch (error) {
    if (error instanceof TransportError && error.isValidationError()) {
      const fieldErrors = error.details as Array<{ field: string; message: string }>;
      const errors: Record<string, string> = {};

      for (const { field, message } of fieldErrors) {
        errors[field] = message;
      }

      return { ...state, isSubmitting: false, errors };
    }
    throw error;
  }
}
```

### Error Boundary (React)

```typescript
function useResource<T>(resource: ResourceClient<T>) {
  const [data, setData] = useState<T[]>([]);
  const [error, setError] = useState<TransportError | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    resource.list()
      .then(result => {
        setData(result.items);
        setError(null);
      })
      .catch(err => {
        if (err instanceof TransportError) {
          setError(err);
        } else {
          throw err; // Let error boundary handle
        }
      })
      .finally(() => setLoading(false));
  }, [resource]);

  return { data, error, loading };
}
```

## Throwing Errors in Hooks

```typescript
app.use("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
  hooks: {
    onBeforeCreate: async (ctx, data) => {
      // Validate business rules
      if (data.role === "admin" && !ctx.user?.isAdmin) {
        throw new ForbiddenError("Only admins can create admin users");
      }

      // Check for duplicates
      const existing = await ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, data.email));

      if (existing.length > 0) {
        throw new ConflictError("Email already in use", { email: data.email });
      }

      return data;
    },

    onBeforeDelete: async (ctx, id) => {
      // Prevent self-deletion
      if (id === ctx.user?.id) {
        throw new ForbiddenError("Cannot delete your own account");
      }
    },
  },
}));
```

## Throwing Errors in Procedures

```typescript
procedures: {
  transferOwnership: {
    input: z.object({
      toUserId: z.string(),
    }),
    handler: async (ctx, input) => {
      const newOwner = await ctx.db
        .select()
        .from(usersTable)
        .where(eq(usersTable.id, input.toUserId));

      if (newOwner.length === 0) {
        throw new NotFoundError("users", input.toUserId);
      }

      if (newOwner[0].status !== "active") {
        throw new ValidationError("Cannot transfer to inactive user");
      }

      // Proceed with transfer
    },
  },
}
```

## Best Practices

1. **Use specific error types** - Don't throw generic errors
2. **Include details** - Provide context for debugging
3. **Handle all error types** - Don't let errors go unhandled
4. **Log server errors** - Track 5xx errors for investigation
5. **Show user-friendly messages** - Don't expose internal details
6. **Retry transient errors** - Network issues often resolve
7. **Validate early** - Catch errors before they reach the database
