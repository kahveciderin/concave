# Mutation Tracking

Concave provides automatic mutation tracking via a Drizzle db wrapper that tracks all database mutations to the changelog system. This enables real-time subscriptions and query caching across both `useResource` endpoints and custom Express routes.

## Quick Start

```typescript
import { drizzle } from "drizzle-orm/libsql";
import { trackMutations } from "@kahveciderin/concave";
import * as schema from "./schema";

const baseDb = drizzle(/* your config */);

// Wrap the database with mutation tracking
export const db = trackMutations(baseDb, {
  todos: { table: schema.todosTable, id: schema.todosTable.id },
  users: { table: schema.usersTable, id: schema.usersTable.id },
});

// Now all mutations are automatically tracked!
const [todo] = await db.insert(todosTable).values({ title: "New todo" }).returning();
// ^ This insert is recorded in the changelog, subscriptions are notified
```

## How It Works

The `trackMutations` function wraps your Drizzle database instance with a Proxy that intercepts mutations:

1. **Builder Pattern** (full tracking): `db.insert()`, `db.update()`, `db.delete()` - captures `previousObject` for updates/deletes
2. **Raw SQL** (partial tracking): `db.run()`, `db.execute()` - detects mutations, records without `previousObject`, triggers `invalidate` for subscribers

### Tracking Levels

| Pattern | previousObject | Subscription Events |
|---------|----------------|---------------------|
| `db.insert(table).values(data).returning()` | N/A | `added` |
| `db.update(table).set(data).where(...).returning()` | Captured | `changed` |
| `db.delete(table).where(...)` | Captured | `removed` |
| `db.run(sql\`INSERT INTO...\`)` | No | `invalidate` |
| `db.run(sql\`UPDATE...\`)` | No | `invalidate` |
| `db.run(sql\`DELETE FROM...\`)` | No | `invalidate` |

## Configuration

```typescript
const trackedDb = trackMutations(db, tables, {
  // Called for builder pattern mutations (full tracking)
  onMutation: (entry) => {
    console.log("Mutation:", entry.type, entry.resource, entry.objectId);
  },

  // Called for raw SQL mutations (partial tracking)
  onRawSqlMutation: (resourceName, type) => {
    console.log("Raw SQL mutation:", type, "on", resourceName);
  },

  // Tables to skip tracking
  skipTables: ["audit_logs", "sessions"],

  // Track mutations inside transactions (default: true)
  trackTransactions: true,

  // Capture previousObject for updates/deletes (default: true)
  capturePreviousState: true,

  // Push to subscriptions automatically (default: true)
  pushToSubscriptions: true,

  // Enable query caching (see below)
  cache: { enabled: true, ttl: 60000 },
});
```

## Table Registration

Register tables with their ID column:

```typescript
const db = trackMutations(baseDb, {
  todos: {
    table: todosTable,
    id: todosTable.id,
    resourceName: "todos", // optional, defaults to table name
  },
  users: {
    table: usersTable,
    id: usersTable.id,
    resourceName: "api-users", // use custom resource name
  },
});
```

## Automatic Tracking in Procedures

When using `useResource`, the `ctx.db` provided to procedure handlers is automatically tracked for the current resource. You don't need to wrap it manually:

```typescript
app.use("/posts", useResource(postsTable, {
  id: postsTable.id,
  db,
  procedures: {
    publish: defineProcedure({
      handler: async (ctx, input) => {
        // ctx.db is automatically tracked - mutations push to subscribers
        const [updated] = await ctx.db.update(postsTable)
          .set({ published: true })
          .where(eq(postsTable.id, input.id))
          .returning();

        return { success: true, post: updated };
      },
    }),
  },
}));
```

If your procedure modifies multiple tables, pass a pre-configured tracked db to `config.db` instead (it won't be double-wrapped):

```typescript
const trackedDb = trackMutations(baseDb, {
  posts: { table: postsTable, id: postsTable.id },
  notifications: { table: notificationsTable, id: notificationsTable.id },
});

app.use("/posts", useResource(postsTable, {
  id: postsTable.id,
  db: trackedDb,  // Already tracked
  // ...
}));
```

## Using in Custom Express Routes

Mutations are automatically tracked when you use the wrapped database:

```typescript
app.post("/api/custom-action", async (req, res) => {
  // This insert is tracked and triggers subscription updates!
  const [todo] = await db
    .insert(todosTable)
    .values({ title: req.body.title, userId: req.user.id })
    .returning();

  res.json(todo);
});
```

## Disable Tracking Temporarily

Use `withoutTracking` for operations that shouldn't be tracked:

```typescript
await db.withoutTracking(async (db) => {
  // These operations are NOT tracked
  await db.insert(auditLogsTable).values({ action: "login" });
});
```

## Transaction Support

Mutations inside transactions are tracked:

```typescript
await db.transaction(async (tx) => {
  const [todo] = await tx.insert(todosTable).values({ title: "Todo" }).returning();
  await tx.update(usersTable).set({ todoCount: sql`todoCount + 1` }).where(eq(usersTable.id, userId));
  // Both mutations are tracked
});
```

## Raw SQL Detection

Raw SQL mutations via `db.run()` or `db.execute()` are detected by parsing the SQL string:

```typescript
// Detected as INSERT on "todos"
await db.run(sql`INSERT INTO todos (id, title) VALUES (${id}, ${title})`);

// Detected as UPDATE on "todos"
await db.run(sql`UPDATE todos SET archived = 1 WHERE created_at < ${date}`);

// Detected as DELETE on "todos"
await db.run(sql`DELETE FROM todos WHERE id = ${id}`);
```

Raw SQL mutations record a changelog entry with `objectId: "*"` and trigger `invalidate` events for subscribers.

## Query Caching

Enable query caching to automatically cache SELECT queries with invalidation on mutations:

```typescript
const db = trackMutations(baseDb, tables, {
  cache: {
    enabled: true,
    ttl: 60000, // Optional TTL in ms
    keyPrefix: "cache:", // Optional key prefix
    tables: {
      todos: { ttl: 30000 }, // Per-table TTL
      users: { enabled: false }, // Disable for specific table
    },
  },
});

// First query: hits database, caches result
const todos = await db.select().from(todosTable);

// Second query: returns cached result
const todosCached = await db.select().from(todosTable);

// Mutation invalidates cache
await db.insert(todosTable).values({ title: "New" }).returning();

// Next query: hits database again
const todosRefresh = await db.select().from(todosTable);
```

### Manual Cache Invalidation

```typescript
import { invalidateCache, invalidateAllCache } from "@kahveciderin/concave";

// Invalidate cache for specific resource
await invalidateCache("todos");

// Invalidate all cached queries
await invalidateAllCache();
```

## Changelog Entry Structure

Each mutation creates a changelog entry:

```typescript
interface ChangelogEntry {
  resource: string;        // Resource name (e.g., "todos")
  type: "create" | "update" | "delete";
  objectId: string;        // ID of the affected object (or "*" for raw SQL)
  object?: unknown;        // The new/updated object
  previousObject?: unknown; // The previous state (for updates/deletes)
  timestamp: number;       // Timestamp of the mutation
  seq: number;             // Sequence number
}
```

## Integration with useResource

When using both `trackMutations` and `useResource` on the same table, ensure you're not double-tracking mutations. The `useResource` hook handles its own changelog recording, so you may want to use `withoutTracking` for internal operations:

```typescript
// In your resource hooks
hooks: {
  onBeforeCreate: async (ctx, data) => {
    // Use withoutTracking if you need to make additional DB calls
    // that shouldn't be tracked separately
    return data;
  },
}
```

## Error Handling

If a mutation fails, no changelog entry is recorded:

```typescript
try {
  await db.insert(todosTable).values({ id: "duplicate" }).returning();
} catch (error) {
  // No changelog entry was recorded
  // Subscribers are NOT notified
}
```

## API Reference

### trackMutations

```typescript
function trackMutations<TDb extends DrizzleDatabase>(
  db: TDb,
  tables: Record<string, TableRegistration>,
  config?: TrackMutationsConfig
): TrackedDatabase<TDb>
```

### TableRegistration

```typescript
interface TableRegistration {
  table: Table<any>;     // Drizzle table schema
  id: AnyColumn;         // ID column
  resourceName?: string; // Optional override (defaults to table name)
}
```

### TrackMutationsConfig

```typescript
interface TrackMutationsConfig {
  onMutation?: (entry: ChangelogEntry) => void | Promise<void>;
  onRawSqlMutation?: (resourceName: string, type: "create" | "update" | "delete") => void | Promise<void>;
  skipTables?: string[];
  trackTransactions?: boolean;
  capturePreviousState?: boolean;
  pushToSubscriptions?: boolean;
  cache?: CacheConfig;
}
```

### CacheConfig

```typescript
interface CacheConfig {
  enabled: boolean;
  ttl?: number;
  keyPrefix?: string;
  tables?: {
    [tableName: string]: {
      ttl?: number;
      enabled?: boolean;
    };
  };
}
```

### TrackedDatabase

```typescript
interface TrackedDatabase<TDb> extends TDb {
  _trackingContext: TrackingContext;
  _originalDb: TDb;
  withoutTracking<T>(fn: (db: TDb) => Promise<T>): Promise<T>;
}
```
