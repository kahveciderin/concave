# Resources

Resources are the core of Concave. Each resource maps to a database table and automatically generates REST endpoints.

## Basic Usage

```typescript
import { useResource } from "@kahveciderin/concave/resource";
import { postsTable } from "./db/schema";
import { db } from "./db/db";

app.use("/posts", useResource(postsTable, {
  id: postsTable.id,
  db,
}));
```

## Configuration Options

### `id` (required)

The primary key column for the resource:

```typescript
{
  id: postsTable.id,
}
```

### `db` (required)

The Drizzle database instance:

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { createClient } from "@libsql/client";

const client = createClient({ url: "file:./data.db" });
const db = drizzle(client);

{
  db,
}
```

### `batch`

Limits for batch operations:

```typescript
{
  batch: {
    create: 50,   // Max items per batch create
    update: 50,   // Max items per batch update
    replace: 50,  // Max items per batch replace
    delete: 10,   // Max items per batch delete
  },
}
```

### `pagination`

Pagination settings:

```typescript
{
  pagination: {
    defaultLimit: 20,  // Default page size
    maxLimit: 100,     // Maximum page size
  },
}
```

### `rateLimit`

Rate limiting configuration:

```typescript
{
  rateLimit: {
    windowMs: 60000,    // Time window (1 minute)
    maxRequests: 100,   // Max requests per window
  },
}
```

### `auth`

Authentication and authorization scopes:

```typescript
{
  auth: {
    // Public access settings
    public: {
      read: true,
      subscribe: true,
    },

    // Scope functions return filter expressions
    read: async (user) => rsql`*`,
    create: async (user) => rsql`*`,
    update: async (user) => rsql`userId=="${user.id}"`,
    delete: async (user) => rsql`userId=="${user.id}"`,
    subscribe: async (user) => rsql`*`,
  },
}
```

### `capabilities`

Enable or disable specific operations:

```typescript
{
  capabilities: {
    enableCreate: true,      // Allow POST /
    enableUpdate: true,      // Allow PATCH /:id
    enableReplace: true,     // Allow PUT /:id
    enableDelete: true,      // Allow DELETE /:id
    enableBatchCreate: true, // Allow POST /batch
    enableBatchUpdate: true, // Allow PATCH /batch
    enableBatchDelete: true, // Allow DELETE /batch
    enableAggregations: true,// Allow GET /aggregate
    enableSubscriptions: true,// Allow GET /subscribe
  },
}
```

### `fields`

Field-level policies for read/write/filter/sort access:

```typescript
{
  fields: {
    readable: ["id", "name", "email", "createdAt"],  // Fields returned in responses
    writable: ["name", "email"],                      // Fields allowed in create/update
    filterable: ["name", "email", "createdAt"],       // Fields allowed in filters
    sortable: ["name", "createdAt"],                  // Fields allowed in orderBy
  },
}
```

### `customOperators`

Custom filter operators:

```typescript
{
  customOperators: {
    "=contains=": {
      convert: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
      execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
    },
  },
}
```

### `hooks`

Lifecycle hooks:

```typescript
{
  hooks: {
    onBeforeCreate: async (ctx, data) => {
      return { ...data, createdAt: new Date() };
    },
    onAfterCreate: async (ctx, created) => {
      console.log("Created:", created.id);
    },
    onBeforeUpdate: async (ctx, id, data) => {
      return { ...data, updatedAt: new Date() };
    },
    onAfterUpdate: async (ctx, updated) => {},
    onBeforeDelete: async (ctx, id) => {},
    onAfterDelete: async (ctx, deleted) => {},
  },
}
```

### `procedures`

RPC procedures:

```typescript
{
  procedures: {
    publish: defineProcedure({
      input: z.object({ id: z.string() }),
      output: z.object({ success: z.boolean() }),
      handler: async (ctx, input) => {
        // Use tracked db for automatic subscription updates
        await db.update(postsTable)
          .set({ published: true })
          .where(eq(postsTable.id, input.id))
          .returning();
        return { success: true };
      },
    }),
  },
}
```

For mutations inside procedures to automatically notify subscribers, use a database wrapped with `trackMutations`. See [Mutation Tracking](./track-mutations.md) for details.

## Generated Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List with pagination |
| GET | `/:id` | Get single item |
| POST | `/` | Create item |
| PATCH | `/:id` | Partial update |
| PUT | `/:id` | Full replace |
| DELETE | `/:id` | Delete item |
| GET | `/count` | Count items |
| GET | `/aggregate` | Aggregation queries |
| GET | `/subscribe` | SSE subscription |
| POST | `/batch` | Batch create |
| PATCH | `/batch` | Batch update |
| DELETE | `/batch` | Batch delete |
| POST | `/rpc/:name` | RPC procedures |

## Query Parameters

| Parameter | Description | Example |
|-----------|-------------|---------|
| `filter` | Filter expression | `status=="active"` |
| `select` | Field projection | `id,name,email` |
| `cursor` | Pagination cursor | `eyJpZCI6MTB9` |
| `limit` | Page size | `20` |
| `orderBy` | Sort order | `name:asc,age:desc` |
| `totalCount` | Include total count | `true` |

## Related

- [Filtering](./filtering.md) - Learn about filter syntax and custom operators
- [Pagination](./pagination.md) - Cursor-based pagination details
- [Aggregations](./aggregations.md) - Statistical queries and grouping
- [Subscriptions](./subscriptions.md) - Real-time event streaming
- [Procedures & Hooks](./procedures.md) - RPC and lifecycle hooks
- [Mutation Tracking](./track-mutations.md) - Automatic changelog and cache invalidation
- [Authentication](./authentication.md) - Auth setup and authorization scopes
