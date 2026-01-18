# Middleware

Concave provides several middleware components for observability, versioning, and request handling.

## Observability

Track request metrics and performance:

```typescript
import { createObservabilityMiddleware, createMetricsCollector } from "@kahveciderin/concave/middleware/observability";

const metrics = createMetricsCollector({
  maxMetrics: 1000,
  slowThresholdMs: 500,
  onMetrics: (m) => console.log("Metric:", m),
});

app.use(createObservabilityMiddleware({
  collector: metrics,
  includeHeaders: ["x-request-id"],
}));

// Later: access metrics
const recent = metrics.getRecent(10);
const slow = metrics.getSlow(1000);
const byPath = metrics.getByPath("/api/users");
```

### Metrics Collector API

| Method | Description |
|--------|-------------|
| `record(metrics)` | Record a request metric |
| `getRecent(count)` | Get the N most recent metrics |
| `getByPath(path)` | Get metrics for a specific path |
| `getSlow(thresholdMs)` | Get requests slower than threshold |
| `getRequestDuration(requestId)` | Get duration for a request ID |
| `reset()` | Clear all metrics |

## Versioning

API version management with client compatibility:

```typescript
import { createVersionMiddleware, wrapWithVersion, checkMinimumVersion, CONCAVE_VERSION } from "@kahveciderin/concave/middleware/versioning";

// Add version headers to responses
app.use(createVersionMiddleware({
  headerName: "X-Concave-Version",
}));

// Wrap response data with version info
const response = wrapWithVersion({ users: [] });
// { data: { users: [] }, version: "1.0.0", timestamp: "..." }

// Check client version compatibility
const result = checkMinimumVersion("0.9.0", "1.0.0");
// { compatible: true, clientVersion: { major: 0, minor: 9, patch: 0 }, ... }
```

## Idempotency

Prevent duplicate requests with idempotency keys:

```typescript
import { createIdempotencyMiddleware } from "@kahveciderin/concave/middleware/idempotency";

app.use(createIdempotencyMiddleware({
  headerName: "Idempotency-Key",
  ttlMs: 86400000, // 24 hours
  store: myKVStore, // Optional custom store
}));
```

When a request includes an `Idempotency-Key` header, the middleware:
1. Checks if the key has been seen before
2. If yes, returns the cached response
3. If no, processes the request and caches the response

## ETag Support

Optimistic concurrency control with ETags:

```typescript
import { generateETag, parseIfMatch, checkETagMatch } from "@kahveciderin/concave/resource/etag";

// Generate ETag from resource
const etag = generateETag({ id: 1, name: "Test", updatedAt: "2024-01-01" });

// Check If-Match header
const clientETag = parseIfMatch(req.headers["if-match"]);
const matches = checkETagMatch(etag, clientETag);

if (!matches) {
  res.status(412).json({ error: "Precondition failed" });
}
```

Resources automatically include ETag headers in responses. Use `If-Match` header on updates:

```bash
# Get resource with ETag
GET /posts/1
# Response: ETag: "abc123"

# Update with ETag
PATCH /posts/1
If-Match: "abc123"
Content-Type: application/json
{ "title": "Updated" }
```

## Rate Limiting

Per-resource rate limiting:

```typescript
import { createRateLimitMiddleware } from "@kahveciderin/concave/middleware/rateLimit";

app.use(createRateLimitMiddleware({
  windowMs: 60000,    // 1 minute window
  maxRequests: 100,   // Max 100 requests
  keyGenerator: (req) => req.user?.id || req.ip,
}));
```

## Related

- [Resources](./resources.md) - Core resource configuration
- [Error Handling](./error-handling.md) - Error responses and types
