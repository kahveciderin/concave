# Admin UI

Concave includes a comprehensive admin dashboard for development and debugging at `/__concave/ui`. It provides a one-stop shop for monitoring, testing, and debugging your API.

## Setup

```typescript
import express from "express";
import { createAdminUI, registerResource } from "concave/ui";
import { createMetricsCollector, observabilityMiddleware } from "concave/middleware/observability";

const app = express();

// Create metrics collector
const metricsCollector = createMetricsCollector({
  maxMetrics: 1000,
  slowThresholdMs: 500,
});

// Add observability middleware to track requests
app.use(observabilityMiddleware({ metrics: metricsCollector }));

// Mount admin UI at /__concave
app.use("/__concave", createAdminUI({
  title: "My API Admin",
  metricsCollector,
  // Optional: changelog for replay debugging
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
  // Optional: subscription monitoring
  getActiveSubscriptions: () => subscriptionManager.getActive(),
}));

// Register resources for visibility in the admin panel
app.use("/posts", useResource(postsTable, { ... }));
registerResource({
  path: "/posts",
  fields: ["id", "title", "content", "authorId", "createdAt"],
  capabilities: { enableSubscriptions: true },
  auth: { public: { read: true } },
});
```

## Pages

The admin UI includes nine pages organized into three sections:

### Overview Section

#### Dashboard

The main dashboard provides a high-level overview of your API:

| Stat | Description |
|------|-------------|
| Resources | Number of registered resources |
| Requests | Total tracked requests |
| Avg Response | Average response time in milliseconds |
| Errors | Number of logged errors |
| Slow Queries | Requests exceeding the slow threshold |

Also displays:
- Recent requests with method, path, and response time
- Quick resource list with field counts and capabilities

#### Resources

Detailed view of all registered resources. Click any resource to expand and see:

- **Fields** - All available fields on the resource
- **Capabilities** - Enabled features (Create, Update, Delete, Subscriptions, Aggregations)
- **Auth Configuration** - Public access settings and scope requirements
- **RPC Procedures** - Available custom procedures
- **Endpoints** - Full endpoint reference table with methods and paths

#### Requests

Real-time request monitoring with filtering:

- **Method Filter** - Filter by GET, POST, PATCH, PUT, DELETE
- **Status Filter** - Show only success (2xx/3xx) or error (4xx/5xx) responses
- **Path Filter** - Search by path substring

Each request shows:
- HTTP method with color-coded badge
- Request path
- Status code (green for success, red for error)
- Duration with color coding (green < 100ms, yellow < 500ms, red > 500ms)
- Timestamp

Click any request to view full details including headers and body.

#### Errors

Error log showing recent API errors:

- Status code badge
- Request path
- Timestamp
- Error message
- Expandable stack trace (click to reveal)

### Tools Section

#### Filter Tester

Interactive filter expression testing and validation:

1. **Expression Input** - Enter any filter expression
2. **Parse Button** - Validates and parses the expression
3. **AST View** - Shows the parsed abstract syntax tree
4. **SQL Equivalent** - Displays the generated SQL WHERE clause
5. **Test Query** - Select a resource and execute the filter live

**Operator Reference Table:**

| Operator | Description | Example |
|----------|-------------|---------|
| `==` | Equals | `status=="active"` |
| `!=` | Not equals | `status!="deleted"` |
| `>` | Greater than | `age>18` |
| `>=` | Greater or equal | `age>=18` |
| `<` | Less than | `price<100` |
| `<=` | Less or equal | `price<=100` |
| `=in=` | In list | `role=in=("admin","user")` |
| `=out=` | Not in list | `status=out=("deleted")` |
| `%=` | LIKE pattern | `name%="John%"` |
| `=isnull=` | Is null check | `deletedAt=isnull=true` |
| `;` | AND combinator | `a==1;b==2` |
| `,` | OR combinator | `a==1,a==2` |
| `()` | Grouping | `(a==1;b==2),c==3` |

#### API Explorer

Interactive API testing without leaving the browser:

1. **Method Selector** - Choose HTTP method
2. **Resource Selector** - Quick-select registered resources
3. **Path Input** - Full URL path with query parameters
4. **Request Body** - JSON editor for POST/PATCH/PUT requests
5. **Response Viewer** - Formatted JSON response with status and timing

Example workflow:
```
Method: GET
Path: /users?filter=role=="admin"&limit=10
[Send]

Response: 200 (45ms)
{
  "data": [...],
  "pagination": { ... }
}
```

#### Subscriptions

SSE subscription monitor for debugging real-time features:

1. **Resource Selector** - Choose from resources with subscriptions enabled
2. **Filter Input** - Optional filter expression for the subscription
3. **Connect/Disconnect** - Manage the SSE connection
4. **Event Stream** - Live view of incoming events

Event types displayed:
- `existing` (blue) - Initial data on connection
- `added` (green) - New items matching filter
- `changed` (yellow) - Updated items
- `removed` (red) - Deleted items or items leaving filter scope

Each event shows:
- Event type badge
- ISO timestamp
- Full JSON payload

#### Changelog

Database mutation log viewer for subscription replay debugging:

**Stats:**
- Current Sequence - Latest changelog sequence number
- Entries Shown - Number of entries in view

**Entry Table:**
| Column | Description |
|--------|-------------|
| Seq | Sequence number |
| Type | create, update, or delete |
| Resource | Resource path |
| ID | Entity identifier |
| Time | Mutation timestamp |

Requires changelog configuration in `createAdminUI()`.

### Help Section

#### Error Docs

Local reference for all API error types. Click any error type to see:

- **Title** - Human-readable error name
- **Description** - What the error means
- **Solutions** - Actionable steps to resolve

Available error types:

| Type | Description |
|------|-------------|
| `not-found` | Resource doesn't exist |
| `validation-error` | Request body validation failed |
| `unauthorized` | Authentication required |
| `forbidden` | Insufficient permissions |
| `rate-limit-exceeded` | Too many requests |
| `batch-limit-exceeded` | Batch size exceeded |
| `filter-parse-error` | Invalid filter syntax |
| `conflict` | Resource state conflict |
| `precondition-failed` | ETag mismatch (optimistic concurrency) |
| `cursor-invalid` | Pagination cursor malformed or incompatible |
| `cursor-expired` | Pagination cursor expired |
| `idempotency-mismatch` | Idempotency key reused with different params |
| `unsupported-version` | Client version below minimum |
| `internal-error` | Server error |
| `unknown-error` | Unrecognized error |

These docs are served locally at `/__concave/problems/:type` and are referenced by the `type` field in RFC 7807 problem details responses. All API error responses now use relative URLs instead of external URLs.

## Configuration

```typescript
interface AdminUIConfig {
  // Custom page title (default: "Concave Admin")
  title?: string;

  // Base path for API URLs (default: "/__concave")
  basePath?: string;

  // Metrics collector for request tracking
  metricsCollector?: {
    getRecent: (count: number) => RequestMetric[];
    getSlow: (thresholdMs: number) => RequestMetric[];
  };

  // Changelog access for replay debugging
  changelog?: {
    getCurrentSequence: () => Promise<number>;
    getEntries: (fromSeq: number, limit: number) => Promise<ChangelogEntry[]>;
  };

  // Active subscription monitoring
  getActiveSubscriptions?: () => Subscription[];
}
```

### Full Example

```typescript
import { createAdminUI, registerResource } from "concave/ui";
import { createMetricsCollector, observabilityMiddleware } from "concave/middleware/observability";
import { createChangelog } from "concave/resource/changelog";

const metricsCollector = createMetricsCollector({
  maxMetrics: 1000,
  slowThresholdMs: 500,
});

const changelog = createChangelog({ maxEntries: 10000 });

app.use(observabilityMiddleware({ metrics: metricsCollector }));

app.use("/__concave", createAdminUI({
  title: "My API Admin",
  metricsCollector,
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
}));
```

## Registering Resources

Resources must be registered to appear in the admin panel:

```typescript
import { registerResource, unregisterResource, clearRegistry } from "concave/ui";

// Register a resource
registerResource({
  path: "/users",
  fields: ["id", "name", "email", "role", "createdAt", "updatedAt"],
  capabilities: {
    enableCreate: true,
    enableUpdate: true,
    enableDelete: true,
    enableSubscriptions: true,
    enableAggregations: true,
  },
  auth: {
    public: { read: true, subscribe: true },
    hasReadScope: true,
    hasUpdateScope: true,
    hasDeleteScope: true,
  },
  procedures: ["changeEmail", "resetPassword", "deactivate"],
});

// Unregister a specific resource
unregisterResource("/users");

// Clear all registered resources
clearRegistry();
```

### ResourceRegistry Interface

```typescript
interface ResourceRegistry {
  // API path (e.g., "/users")
  path: string;

  // Available fields
  fields: string[];

  // Feature flags
  capabilities?: {
    enableCreate?: boolean;
    enableUpdate?: boolean;
    enableDelete?: boolean;
    enableSubscriptions?: boolean;
    enableAggregations?: boolean;
  };

  // Auth configuration summary
  auth?: {
    public?: { read?: boolean; subscribe?: boolean };
    hasReadScope?: boolean;
    hasUpdateScope?: boolean;
    hasDeleteScope?: boolean;
  };

  // Available RPC procedures
  procedures?: string[];
}
```

## API Endpoints

The admin UI exposes these JSON API endpoints:

| Endpoint | Description |
|----------|-------------|
| `GET /__concave/api/resources` | List registered resources |
| `GET /__concave/api/metrics` | Request metrics and slow queries |
| `GET /__concave/api/requests` | Request log (up to 200) |
| `GET /__concave/api/errors` | Error log (up to 100) |
| `GET /__concave/api/changelog` | Changelog entries |
| `GET /__concave/api/subscriptions` | Active SSE subscriptions |
| `GET /__concave/problems/:type` | Error type documentation |

## Theming

### Dark Mode

Toggle between light and dark themes using the button in the header. Theme preference is persisted in localStorage under the key `concave-theme`.

### Design System

The UI uses CSS custom properties for consistent styling:

```css
:root {
  --bg-0: #ffffff;      /* Page background */
  --bg-1: #fafafa;      /* Card background */
  --bg-2: #f0f0f0;      /* Header background */
  --accent: #0066ff;    /* Primary accent color */
  --success: #00875a;   /* Success states */
  --warning: #b86e00;   /* Warning states */
  --error: #de350b;     /* Error states */
  --radius: 4px;        /* Border radius */
}
```

## Security

The admin UI is intended for development and staging environments. For production:

### Disable in Production

```typescript
if (process.env.NODE_ENV !== "production") {
  app.use("/__concave", createAdminUI({ ... }));
}
```

### Protect with Authentication

```typescript
import { requireAuth } from "concave/auth";

app.use("/__concave", requireAuth(), createAdminUI({ ... }));
```

### Restrict to Admin Users

```typescript
app.use("/__concave", (req, res, next) => {
  if (!req.user?.role === "admin") {
    return res.status(403).json({ error: "Admin access required" });
  }
  next();
}, createAdminUI({ ... }));
```

## Troubleshooting

### Resources Not Appearing

Ensure you call `registerResource()` after setting up the resource route:

```typescript
// Correct order
app.use("/users", useResource(usersTable, { ... }));
registerResource({ path: "/users", ... });
```

### Metrics Not Updating

Verify the observability middleware is added before your routes:

```typescript
// Correct order
app.use(observabilityMiddleware({ metrics: metricsCollector }));
app.use("/users", useResource(usersTable, { ... }));
```

### Changelog Shows "Not Configured"

Pass the changelog configuration to `createAdminUI()`:

```typescript
createAdminUI({
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (from, limit) => changelog.getEntries(from, limit),
  },
})
```

## Related

- [Resources](./resources.md) - Resource configuration
- [Middleware](./middleware.md) - Observability setup
- [Filtering](./filtering.md) - Filter syntax details
- [Subscriptions](./subscriptions.md) - Real-time subscriptions
- [Error Handling](./error-handling.md) - Error types and responses
