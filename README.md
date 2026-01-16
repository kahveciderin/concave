# Concave

A production-ready real-time API framework for Express.js and Drizzle ORM. Define your schema, get a complete REST API with subscriptions, authentication, background tasks, and an offline-first client.

## Features

### Core API
- **Automatic REST API** - Full CRUD endpoints from your Drizzle schema
- **Real-time Subscriptions** - SSE with changelog-based updates and reconnection
- **Relations & Joins** - Define relationships with efficient batch loading
- **RSQL Filtering** - Comprehensive query language (30+ operators)
- **Cursor Pagination** - Keyset pagination with multi-field ordering
- **Aggregations** - Group by, count, sum, avg, min, max
- **Batch Operations** - Bulk create, update, delete with limits

### Authentication
- **OIDC Provider** - Built-in OpenID Connect server with PKCE support
- **Federated Login** - Google, Microsoft, Okta, Auth0, Keycloak, custom
- **Session Auth** - Passport.js and Auth.js adapters
- **Authorization Scopes** - Row-level security with RSQL expressions

### Background Processing
- **Task Queue** - Distributed background jobs with Redis or in-memory
- **Retry Strategies** - Exponential, linear, or fixed backoff
- **Scheduling** - Delayed execution, cron expressions, recurring tasks
- **Dead Letter Queue** - Failed task management and retry

### Client Library
- **Type-safe Client** - Full TypeScript inference
- **React Hooks** - `useLiveList`, `useAuth` for real-time UI
- **Offline Support** - Optimistic updates, mutation queue, auto-sync
- **OIDC Integration** - PKCE flow, token refresh, 401 retry

### Developer Experience
- **Admin UI** - Built-in dashboard at `/__concave/ui`
- **OpenAPI Generation** - Auto-generated specs from resources
- **Middleware** - Observability, versioning, idempotency, rate limiting
- **TypeScript** - Full remote type inference from your schema

## Quick Start

### Installation

```bash
npm install @kahveciderin/concave drizzle-orm @libsql/client
```

### Define Your Schema

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  name: text("name").notNull(),
  email: text("email").notNull(),
  role: text("role").default("user"),
});
```

### Create Your API

```typescript
import express from "express";
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";
import { useResource } from "concave/resource";
import { usersTable } from "./schema";

const client = createClient({ url: "file:./data.db" });
const db = drizzle(client);

const app = express();
app.use(express.json());

app.use("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
}));

app.listen(3000);
```

### Generated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List with filtering, pagination |
| `GET` | `/api/users/:id` | Get single resource |
| `POST` | `/api/users` | Create resource |
| `PATCH` | `/api/users/:id` | Update resource (partial) |
| `PUT` | `/api/users/:id` | Replace resource |
| `DELETE` | `/api/users/:id` | Delete resource |
| `GET` | `/api/users/count` | Count with filtering |
| `GET` | `/api/users/aggregate` | Aggregations |
| `GET` | `/api/users/subscribe` | SSE subscription |
| `POST` | `/api/users/batch` | Batch create |
| `PATCH` | `/api/users/batch` | Batch update |
| `DELETE` | `/api/users/batch` | Batch delete |
| `POST` | `/api/users/rpc/:name` | RPC procedures |

## Client Library

```typescript
import { getOrCreateClient } from "concave/client";
import { useLiveList, useAuth } from "concave/client/react";

// Initialize client with OIDC auth
const client = getOrCreateClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
  offline: true,
});

// React component with live data
function TodoApp() {
  const { user, isAuthenticated, logout } = useAuth();
  const { items, status, mutate } = useLiveList<Todo>("/api/todos", {
    orderBy: "position",
  });

  if (!isAuthenticated) return <button onClick={() => client.auth.login()}>Sign In</button>;

  return (
    <div>
      <p>Welcome, {user?.name}!</p>
      <ul>
        {items.map(todo => (
          <li key={todo.id}>
            {todo.title}
            <button onClick={() => mutate.delete(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>
      <button onClick={() => mutate.create({ title: "New todo" })}>Add</button>
    </div>
  );
}
```

### Low-level API

```typescript
const users = client.resource<User>("/users");

// CRUD operations
const allUsers = await users.list({ filter: 'role=="admin"', limit: 10 });
const user = await users.get("123");
const newUser = await users.create({ name: "Alice", email: "alice@example.com" });
await users.update("123", { name: "Alice Smith" });
await users.delete("123");

// Real-time subscriptions
const subscription = users.subscribe(
  { filter: 'role=="admin"' },
  {
    onAdded: (user) => console.log("New admin:", user),
    onChanged: (user) => console.log("Updated:", user),
    onRemoved: (id) => console.log("Removed:", id),
  }
);
```

## Documentation

Comprehensive documentation is available in the [wiki](./wiki):

### Getting Started
- [Getting Started Guide](./wiki/getting-started.md) - Installation and quick start

### Core Concepts
- [Resources](./wiki/resources.md) - Resource configuration and endpoints
- [Filtering](./wiki/filtering.md) - RSQL filter syntax (30+ operators)
- [Pagination](./wiki/pagination.md) - Cursor-based pagination
- [Aggregations](./wiki/aggregations.md) - Group by and statistical queries
- [Relations](./wiki/relations.md) - Relationships and efficient batch loading

### Real-time
- [Subscriptions](./wiki/subscriptions.md) - SSE subscriptions and changelog

### Authentication & Security
- [Authentication](./wiki/authentication.md) - OIDC Provider, federated login, session auth
- [Secure Queries](./wiki/secure-queries.md) - Scope-enforced query builder

### Background Tasks
- [Tasks](./wiki/tasks.md) - Background job queue, scheduling, retries

### Client
- [Client Library](./wiki/client-library.md) - TypeScript client with React hooks
- [Offline Support](./wiki/offline-support.md) - Offline-first capabilities

### Advanced
- [Procedures & Hooks](./wiki/procedures.md) - RPC and lifecycle hooks
- [Middleware](./wiki/middleware.md) - Observability, versioning, idempotency
- [OpenAPI](./wiki/openapi.md) - OpenAPI spec generation
- [Admin UI](./wiki/admin-ui.md) - Built-in dashboard
- [Error Handling](./wiki/error-handling.md) - Error types and handling

## Configuration

```typescript
app.use("/api/posts", useResource(postsTable, {
  id: postsTable.id,
  db,

  // Batch operation limits
  batch: { create: 100, update: 100, delete: 100 },

  // Pagination settings
  pagination: { defaultLimit: 20, maxLimit: 100 },

  // Rate limiting
  rateLimit: { windowMs: 60000, maxRequests: 100 },

  // Authorization scopes
  auth: {
    public: { read: true },
    update: async (user) => rsql`authorId=="${user.id}"`,
    delete: async (user) => rsql`authorId=="${user.id}"`,
  },

  // Relations
  relations: {
    author: {
      resource: "users",
      schema: usersTable,
      type: "belongsTo",
      foreignKey: postsTable.authorId,
      references: usersTable.id,
    },
    comments: {
      resource: "comments",
      schema: commentsTable,
      type: "hasMany",
      foreignKey: commentsTable.postId,
      references: postsTable.id,
    },
  },

  // Lifecycle hooks
  hooks: {
    onBeforeCreate: async (ctx, data) => ({ ...data, createdAt: new Date() }),
  },

  // RPC procedures
  procedures: {
    publish: defineProcedure({
      input: z.object({ id: z.string() }),
      output: z.object({ success: z.boolean() }),
      handler: async (ctx, input) => {
        await db.update(postsTable).set({ published: true }).where(eq(postsTable.id, input.id));
        return { success: true };
      },
    }),
  },
}));
```

## OIDC Authentication

Built-in OpenID Connect provider with PKCE support:

```typescript
import { createOIDCProvider } from "concave";

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  tokens: {
    accessToken: { ttlSeconds: 3600 },
    refreshToken: { ttlSeconds: 30 * 24 * 3600, rotateOnUse: true },
  },
  clients: [{
    id: "web-app",
    name: "My Web App",
    redirectUris: ["https://myapp.com/callback"],
    grantTypes: ["authorization_code", "refresh_token"],
    tokenEndpointAuthMethod: "none", // Public client, PKCE required
  }],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => { /* ... */ },
      findUserById: async (id) => { /* ... */ },
    },
    federated: [
      oidcProviders.google({ clientId: "...", clientSecret: "..." }),
    ],
  },
});

app.use("/oidc", router);
app.use("/api", middleware, apiRoutes);
```

## Background Tasks

Distributed task queue with retries and scheduling:

```typescript
import { defineTask, initializeTasks, getTaskScheduler, startTaskWorkers } from "concave/tasks";
import { createKV } from "concave/kv";

const kv = await createKV({ type: "redis", redis: { url: "redis://localhost" } });
initializeTasks(kv);

const sendEmailTask = defineTask({
  name: "send-email",
  input: z.object({ to: z.string().email(), subject: z.string(), body: z.string() }),
  retry: { maxAttempts: 3, backoff: "exponential" },
  handler: async (ctx, input) => {
    await sendEmail(input.to, input.subject, input.body);
  },
});

getTaskRegistry().register(sendEmailTask);
await startTaskWorkers(kv, getTaskRegistry(), 3);

// Enqueue a task
await getTaskScheduler().enqueue(sendEmailTask, {
  to: "user@example.com",
  subject: "Welcome!",
  body: "Thanks for signing up.",
});

// Schedule recurring task
await getTaskScheduler().scheduleRecurring(dailyReportTask, {}, {
  cron: "0 6 * * *",
  timezone: "UTC",
});
```

## Query Parameters

| Parameter | Example | Description |
|-----------|---------|-------------|
| `filter` | `age>=18;role=="admin"` | RSQL filter expression |
| `select` | `id,name,email` | Field projection |
| `include` | `author,comments(limit:5)` | Related data to load |
| `cursor` | `eyJpZCI6MTB9` | Pagination cursor |
| `limit` | `20` | Page size |
| `orderBy` | `name:asc,age:desc` | Sort order |
| `totalCount` | `true` | Include total count |

## Filter Syntax

```bash
# Comparison
name=="John"              # Equals
age>=18                   # Greater than or equal
status!="deleted"         # Not equals

# Logical operators
age>=18;role=="admin"     # AND (semicolon)
role=="admin",role=="mod" # OR (comma)
(age>=18;verified==true),role=="admin"  # Grouping

# String operations
name=icontains="john"     # Case-insensitive contains
email=iendswith="@company.com"
title=istartswith="how to"

# Set and range
role=in=("admin","mod")   # In list
age=between=[18,65]       # Range (inclusive)

# Null and empty
deletedAt=isnull=true     # Is null
bio=isempty=false         # Has non-empty value

# See wiki/filtering.md for all 30+ operators
```

## Error Handling

All errors follow a consistent format:

```json
{
  "error": {
    "code": "NOT_FOUND",
    "message": "User with id '123' not found",
    "details": { "resource": "users", "id": "123" }
  }
}
```

Error codes include:
- `NOT_FOUND` (404) - Resource not found
- `VALIDATION_ERROR` (400) - Invalid input data
- `UNAUTHORIZED` (401) - Authentication required
- `FORBIDDEN` (403) - Insufficient permissions
- `RATE_LIMIT_EXCEEDED` (429) - Too many requests
- `BATCH_LIMIT_EXCEEDED` (400) - Batch size exceeded

## Testing

```bash
# Run all tests
npm test

# Run specific test file
npm test -- tests/integration/useResource.test.ts

# Run with coverage
npm test -- --coverage
```

## Requirements

- Node.js 18+
- TypeScript 5+
- Drizzle ORM
- Express.js 4+

## Support

- [Documentation](./wiki) - Comprehensive guides and API reference
