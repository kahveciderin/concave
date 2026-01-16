# Getting Started with Concave

Concave is a real-time API framework for Express.js that provides automatic CRUD endpoints, subscriptions, authentication, and more.

## Installation

```bash
npm install concave drizzle-orm @libsql/client zod uuid
```

## Quick Start

### 1. Define Your Schema

```typescript
// src/db/schema.ts
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const usersTable = sqliteTable("users", {
  id: integer("id").primaryKey({ autoIncrement: true }),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  role: text("role").default("user"),
  createdAt: integer("createdAt", { mode: "timestamp" }),
});
```

### 2. Set Up Database

```typescript
// src/db/db.ts
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./data.db" });
export const db = drizzle(client);
```

### 3. Create Your API

```typescript
// src/main.ts
import express from "express";
import { useResource } from "concave/resource";
import { usersTable } from "./db/schema";
import { db } from "./db/db";

const app = express();
app.use(express.json());

app.use("/api/users", useResource(usersTable, {
  id: usersTable.id,
  db,
}));

app.listen(3000, () => {
  console.log("Server running on http://localhost:3000");
});
```

That's it! You now have a full REST API with:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/users` | List users (paginated, filtered) |
| `GET` | `/api/users/:id` | Get single user |
| `POST` | `/api/users` | Create user |
| `PATCH` | `/api/users/:id` | Update user (partial) |
| `PUT` | `/api/users/:id` | Replace user |
| `DELETE` | `/api/users/:id` | Delete user |
| `GET` | `/api/users/count` | Count users |
| `GET` | `/api/users/aggregate` | Aggregation queries |
| `GET` | `/api/users/subscribe` | SSE real-time subscription |
| `POST` | `/api/users/batch` | Batch create |
| `PATCH` | `/api/users/batch` | Batch update |
| `DELETE` | `/api/users/batch` | Batch delete |
| `POST` | `/api/users/rpc/:name` | RPC procedures |

## Configuration Options

```typescript
useResource(usersTable, {
  id: usersTable.id,

  // Batch operation limits
  batch: {
    create: 50,
    update: 50,
    delete: 10,
  },

  // Pagination settings
  pagination: {
    defaultLimit: 20,
    maxLimit: 100,
  },

  // Rate limiting
  rateLimit: {
    windowMs: 60000,
    maxRequests: 100,
  },

  // Authentication scopes
  auth: {
    public: { read: true },
    update: async (user) => rsql`userId=="${user.id}"`,
  },

  // Custom filter operators
  customOperators: { ... },

  // Lifecycle hooks
  hooks: { ... },

  // RPC procedures
  procedures: { ... },
});
```

## Next Steps

### Core Concepts
- [Resources](./resources.md) - Full resource configuration
- [Filtering](./filtering.md) - Query filter syntax
- [Pagination](./pagination.md) - Cursor-based pagination
- [Aggregations](./aggregations.md) - Statistical queries

### Real-time
- [Subscriptions](./subscriptions.md) - Real-time subscriptions

### Security
- [Authentication](./authentication.md) - Auth setup and scopes
- [Secure Queries](./secure-queries.md) - Scope-enforced query builder

### Advanced
- [Procedures & Hooks](./procedures.md) - RPC and lifecycle hooks
- [Client Library](./client-library.md) - TypeScript client
- [Offline Support](./offline-support.md) - Offline-first apps
- [Error Handling](./error-handling.md) - Error types and handling

### API Documentation
- [OpenAPI](./openapi.md) - OpenAPI spec generation
- [Middleware](./middleware.md) - Observability, versioning, rate limiting

### Development Tools
- [Admin UI](./admin-ui.md) - Built-in admin dashboard at /__concave/ui
