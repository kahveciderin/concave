# Client Library

The Concave client library provides a type-safe, real-time client for interacting with your Concave API. It includes React hooks, offline support, optimistic updates, and live subscriptions.

## Installation

The client is included with the main package:

```typescript
import { createClient, getOrCreateClient } from "@kahveciderin/concave/client";
import { useLiveList, useAuth } from "@kahveciderin/concave/client/react";
```

## Quick Start

### Basic Setup

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { useLiveList, useAuth } from "@kahveciderin/concave/client/react";

// Initialize client (HMR-safe)
const client = getOrCreateClient({
  baseUrl: "http://localhost:3000",
  credentials: "include",
  offline: true,
});

// Use in React components
function TodoApp() {
  const { items, status, mutate } = useLiveList<Todo>("/api/todos", {
    orderBy: "position",
  });

  return (
    <ul>
      {items.map((todo) => (
        <li key={todo.id}>
          {todo.title}
          <button onClick={() => mutate.delete(todo.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

## Client Configuration

### createClient

Creates a new client instance:

```typescript
import { createClient } from "@kahveciderin/concave/client";

const client = createClient({
  baseUrl: "http://localhost:3000",
  credentials: "include",
  headers: { "X-Custom-Header": "value" },
  timeout: 30000,
  offline: true,
  onError: (error) => console.error("Sync error:", error),
  onSyncComplete: () => console.log("Sync complete"),
  authCheckUrl: "/api/auth/me",
});
```

### getOrCreateClient (Recommended)

For HMR-safe initialization in development, use `getOrCreateClient`. It returns the existing client if one was already created:

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";

// Safe to call multiple times - returns same instance
const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});
```

### Configuration Options

| Option | Type | Description |
|--------|------|-------------|
| `baseUrl` | `string` | Base URL of your API server |
| `credentials` | `RequestCredentials` | Fetch credentials mode (`"include"`, `"same-origin"`, `"omit"`) |
| `headers` | `Record<string, string>` | Default headers for all requests |
| `timeout` | `number` | Request timeout in milliseconds |
| `offline` | `boolean \| OfflineConfig` | Enable offline support (see below) |
| `onError` | `(error: Error) => void` | Called when a mutation fails to sync |
| `onSyncComplete` | `() => void` | Called when offline sync completes |
| `authCheckUrl` | `string` | URL for auth status check (default: `/api/auth/me`) |

### Offline Configuration

Pass `true` for sensible defaults, or an object for fine-grained control:

```typescript
// Simple - uses LocalStorage with defaults
const client = createClient({
  baseUrl: "/api",
  offline: true,
});

// Advanced configuration
const client = createClient({
  baseUrl: "/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("my-app"),
    maxRetries: 5,
    retryDelay: 2000,
    onIdRemapped: (optimisticId, serverId) => {
      console.log(`ID changed: ${optimisticId} -> ${serverId}`);
    },
  },
});
```

## Client Methods

### resource

Creates a typed resource client for a specific endpoint:

```typescript
interface Todo {
  id: string;
  title: string;
  completed: boolean;
}

const todos = client.resource<Todo>("/api/todos");
```

### setAuthToken / clearAuthToken

Manage JWT authentication:

```typescript
// Set bearer token
client.setAuthToken("your-jwt-token");

// Clear token (e.g., on logout)
client.clearAuthToken();
```

### setAuthErrorHandler

Set a global handler for authentication errors (401 responses):

```typescript
client.setAuthErrorHandler(() => {
  // Redirect to login or clear auth state
  window.location.href = "/login";
});
```

### getPendingCount

Get the number of mutations waiting to sync:

```typescript
const count = await client.getPendingCount();
console.log(`${count} changes pending sync`);
```

### checkAuth

Check authentication status:

```typescript
const { user } = await client.checkAuth();
if (user) {
  console.log("Logged in as:", user);
} else {
  console.log("Not authenticated");
}
```

## Resource Operations

### List

```typescript
const todos = client.resource<Todo>("/api/todos");

// Basic list
const { items, hasMore, nextCursor } = await todos.list();

// With options
const result = await todos.list({
  filter: 'completed==false',
  orderBy: "createdAt:desc",
  limit: 20,
  cursor: nextCursor,
  select: ["id", "title"],
  totalCount: true,
});
```

### Get

```typescript
const todo = await todos.get("todo-123");

// With projections
const todo = await todos.get("todo-123", {
  select: ["id", "title"],
});
```

### Create

```typescript
const newTodo = await todos.create({
  title: "Buy groceries",
  completed: false,
});

// With optimistic update (for offline support)
const newTodo = await todos.create(
  { title: "Buy groceries" },
  { optimisticId: "temp-123" }
);
```

### Update

```typescript
const updated = await todos.update("todo-123", {
  completed: true,
});
```

### Delete

```typescript
await todos.delete("todo-123");
```

### Batch Operations

```typescript
// Batch create
const created = await todos.batchCreate([
  { title: "Task 1" },
  { title: "Task 2" },
]);

// Batch update by filter
const { count } = await todos.batchUpdate(
  'completed==false',
  { completed: true }
);

// Batch delete by filter
const { count } = await todos.batchDelete('completed==true');
```

### Aggregations

```typescript
const stats = await todos.aggregate({
  groupBy: ["completed"],
  count: true,
});
// { groups: [{ key: { completed: true }, count: 5 }, ...] }
```

### RPC Procedures

```typescript
const result = await todos.rpc<
  { ids: string[] },
  { archived: number }
>("archive", { ids: ["1", "2", "3"] });
```

## Type-Safe Query Builder

The `query()` method returns a fluent, chainable query builder with full TypeScript type inference. Types are automatically narrowed based on selected fields.

### Basic Projections

```typescript
interface User {
  id: string;
  name: string;
  email: string;
  age: number;
  avatar: string;
  role: 'admin' | 'user';
}

const users = client.resource<User>('/api/users');

// Returns Pick<User, 'id' | 'name'>[]
const { items } = await users
  .query()
  .select('id', 'name')
  .list();

// TypeScript knows items have only id and name
items[0].id;    // ✓ OK
items[0].name;  // ✓ OK
items[0].email; // ✗ Type error - not selected
```

### Filtered Queries

```typescript
// Combine select with filters and sorting
const activeUsers = await users
  .query()
  .select('id', 'name', 'email')
  .filter('age>=18')
  .filter('role=="user"')  // Filters are AND-ed together
  .orderBy('name:asc')
  .limit(10)
  .list();
```

### Single Item Operations

```typescript
// Get single with projection
const user = await users
  .query()
  .select('id', 'name')
  .get('user-123');
// Type: { id: string; name: string }

// Get first matching item (or null)
const newest = await users
  .query()
  .select('id', 'name', 'email')
  .orderBy('createdAt:desc')
  .first();
// Type: { id: string; name: string; email: string } | null
```

### Counting

```typescript
// Count with filter
const adultCount = await users
  .query()
  .filter('age>=18')
  .count();
// Type: number
```

### Type-Safe Aggregations

The query builder provides fully typed aggregation results:

```typescript
// Group by with count
const roleStats = await users
  .query()
  .groupBy('role')
  .withCount()
  .aggregate();
// Type: { groups: { key: { role: string }; count: number }[] }

// Multiple aggregation functions
const stats = await users
  .query()
  .groupBy('role')
  .withCount()
  .avg('age')      // Only numeric fields allowed
  .sum('score')    // Only numeric fields allowed
  .min('name')     // Comparable fields (string, number, date)
  .max('createdAt')
  .aggregate();
// Type includes: key, count, avg: { age: number }, sum: { score: number }, min: { name: string }, max: { createdAt: string }

// Filtered aggregation
const activeStats = await users
  .query()
  .filter('status=="active"')
  .groupBy('department')
  .withCount()
  .avg('salary')
  .aggregate();
```

### Immutable Chaining

The query builder is immutable - each method returns a new builder:

```typescript
const baseQuery = users.query().filter('age>=18');

// These create separate queries
const admins = baseQuery.filter('role=="admin"');
const regularUsers = baseQuery.filter('role=="user"');

// Original baseQuery is unchanged
```

### With React Hooks

Use projections with `useLiveList` for type-safe real-time lists:

```typescript
import { useLiveList } from "@kahveciderin/concave/client/react";

function UserList() {
  // Type parameter specifies selected fields
  const { items, status, mutate } = useLiveList<User, 'id' | 'name' | 'avatar'>(
    '/api/users',
    { select: ['id', 'name', 'avatar'] }
  );
  // items type: { id: string; name: string; avatar: string }[]

  return (
    <ul>
      {items.map(user => (
        <li key={user.id}>
          <img src={user.avatar} alt={user.name} />
          {user.name}
        </li>
      ))}
    </ul>
  );
}
```

### Query Builder Methods

| Method | Description |
|--------|-------------|
| `select(...fields)` | Select specific fields (narrows return type) |
| `filter(filter)` | Add filter condition (AND with previous) |
| `where(filter)` | Alias for `filter()` |
| `orderBy(orderBy)` | Set sort order |
| `limit(n)` | Limit results |
| `cursor(cursor)` | Set pagination cursor |
| `include(include)` | Include relations |
| `withTotalCount()` | Request total count in response |
| `groupBy(...fields)` | Group by fields for aggregation |
| `withCount()` | Include count in aggregation |
| `sum(...fields)` | Sum numeric fields |
| `avg(...fields)` | Average numeric fields |
| `min(...fields)` | Minimum of comparable fields |
| `max(...fields)` | Maximum of comparable fields |
| `list()` | Execute and return paginated response |
| `get(id)` | Get single item by ID |
| `first()` | Get first item or null |
| `count()` | Get count of matching items |
| `aggregate()` | Execute aggregation query |

### Generated Field Metadata Types

When using the type generator (`pnpm example:typegen`), field metadata types are automatically generated:

```typescript
// Generated types
export type UserFields = 'id' | 'name' | 'email' | 'age' | 'role';
export type UserNumericFields = 'age' | 'score';
export type UserComparableFields = 'id' | 'name' | 'email' | 'age' | 'createdAt';
export type UserStringFields = 'id' | 'name' | 'email' | 'role';
```

These can be used for type-safe field references in your application.

## React Hooks

### useLiveList

The primary hook for real-time lists with optimistic updates:

```typescript
import { useLiveList } from "@kahveciderin/concave/client/react";

function TodoList() {
  const {
    items,           // T[] - current items
    status,          // "loading" | "live" | "reconnecting" | "offline" | "error"
    statusLabel,     // Human-readable status string
    error,           // Error | null
    pendingCount,    // Number of pending mutations
    isLoading,       // true while initially loading
    isLive,          // true when connected and receiving updates
    isOffline,       // true when offline
    isReconnecting,  // true when reconnecting
    mutate,          // { create, update, delete } - optimistic mutations
    refresh,         // () => Promise<void> - force refresh
  } = useLiveList<Todo>("/api/todos", {
    filter: 'userId=="123"',
    orderBy: "position",
    limit: 100,
    include: "category,tags",        // Include related data
    subscriptionMode: "strict",      // Control how updates are handled (see below)
    enabled: true,                   // Set to false to disable the query
  });

  // Create with optimistic update
  const addTodo = () => {
    mutate.create({ title: "New todo", completed: false });
  };

  // Update with optimistic update
  const toggleTodo = (id: string, completed: boolean) => {
    mutate.update(id, { completed: !completed });
  };

  // Delete with optimistic update
  const removeTodo = (id: string) => {
    mutate.delete(id);
  };

  return (
    <div>
      <div>Status: {statusLabel}</div>
      {items.map((todo) => (
        <div key={todo.id}>
          <input
            type="checkbox"
            checked={todo.completed}
            onChange={() => toggleTodo(todo.id, todo.completed)}
          />
          {todo.title}
          <button onClick={() => removeTodo(todo.id)}>Delete</button>
        </div>
      ))}
      <button onClick={addTodo}>Add Todo</button>
    </div>
  );
}
```

#### Using with ResourceClient

You can also pass a ResourceClient directly instead of a path:

```typescript
const todosRepo = client.resource<Todo>("/api/todos");

// Later in a component
const { items } = useLiveList(todosRepo, { orderBy: "position" });
```

#### Pagination with Load More

When using `limit`, the hook supports paginated loading:

```typescript
const {
  items,
  hasMore,        // true if more items available
  totalCount,     // total count if requested
  isLoadingMore,  // true while loading more
  loadMore,       // () => Promise<void> - load next page
} = useLiveList<Todo>("/api/todos", {
  limit: 20,
  orderBy: "createdAt:desc",
});

return (
  <div>
    {items.map(todo => <TodoItem key={todo.id} todo={todo} />)}
    {hasMore && (
      <button onClick={loadMore} disabled={isLoadingMore}>
        {isLoadingMore ? "Loading..." : "Load More"}
      </button>
    )}
    {totalCount && <p>Showing {items.length} of {totalCount}</p>}
  </div>
);
```

#### Subscription Modes for Paginated Lists

When paginating, control how real-time updates are handled with `subscriptionMode`:

| Mode | Behavior | Use Case |
|------|----------|----------|
| `strict` (default with `limit`) | Only show your own creates, updates to cached items | Admin tables, data grids |
| `sorted` | New items appear in sort order | Collaborative lists |
| `append` | New items appear at end | Chat logs, activity feeds |
| `prepend` | New items appear at start | Notifications, news feeds |
| `live` (default without `limit`) | All updates shown | Real-time dashboards |

```typescript
// Chat-style: new messages at the end
const { items } = useLiveList<Message>("/api/messages", {
  limit: 50,
  subscriptionMode: "append",
  orderBy: "createdAt:asc",
});

// Notifications: newest at top
const { items } = useLiveList<Notification>("/api/notifications", {
  limit: 20,
  subscriptionMode: "prepend",
  orderBy: "createdAt:desc",
});
```

#### Relations and Optimistic Updates

When using `include` with relations, the optimistic update behavior is:

1. **Changing a foreign key** (e.g., `categoryId`): The stale relation is cleared immediately
2. **Server confirms**: The new relation data is populated from the server response
3. **For instant UX**: Look up relations from locally cached data

```typescript
// Include relations
const { items: todos } = useLiveList<TodoWithCategory>("/api/todos", {
  include: "category",
});

// Also fetch categories separately
const { items: categories } = useLiveList<Category>("/api/categories");

// In your component, handle optimistic updates gracefully
function TodoItem({ todo }) {
  // Use included relation, or look up from local cache
  const category = todo.category ?? categories.find(c => c.id === todo.categoryId);

  return (
    <div>
      {todo.title}
      {category && <Badge color={category.color}>{category.name}</Badge>}
    </div>
  );
}
```

### useAuth

Hook for authentication state management:

```typescript
import { useAuth } from "@kahveciderin/concave/client/react";

interface User {
  id: string;
  name: string;
  email: string;
}

function App() {
  const {
    user,             // TUser | null
    status,           // "loading" | "authenticated" | "unauthenticated"
    isAuthenticated,  // boolean
    isLoading,        // boolean
    logout,           // () => Promise<void>
    refetch,          // () => Promise<void>
  } = useAuth<User>();

  if (isLoading) {
    return <div>Loading...</div>;
  }

  if (!isAuthenticated) {
    return <LoginPage />;
  }

  return (
    <div>
      <p>Welcome, {user?.name}!</p>
      <button onClick={logout}>Sign out</button>
    </div>
  );
}
```

#### useAuth Options

```typescript
const { user } = useAuth<User>({
  checkUrl: "/api/auth/me",     // Custom auth check endpoint
  logoutUrl: "/api/auth/logout", // Custom logout endpoint
});
```

## Subscriptions (Low-Level)

For more control over real-time subscriptions, use the low-level subscription API:

```typescript
const todos = client.resource<Todo>("/api/todos");

const subscription = todos.subscribe(
  { filter: 'completed==false' },
  {
    onAdded: (todo, meta) => {
      console.log("New todo:", todo);
      // meta.optimisticId available if this was from an optimistic create
    },
    onChanged: (todo) => {
      console.log("Updated:", todo);
    },
    onRemoved: (id) => {
      console.log("Removed:", id);
    },
    onInvalidate: () => {
      console.log("Cache invalidated, refetch recommended");
    },
    onConnected: (seq) => {
      console.log("Connected at sequence:", seq);
    },
    onDisconnected: () => {
      console.log("Disconnected");
    },
    onError: (error) => {
      console.error("Subscription error:", error);
    },
  }
);

// Reconnect after disconnect
subscription.reconnect();

// Resume from a specific sequence number
subscription.resumeFrom(lastSeq);

// Cleanup
subscription.unsubscribe();
```

## Live Query Store

For non-React usage or custom integrations, use the LiveQuery store directly:

```typescript
import { createLiveQuery, statusLabel } from "@kahveciderin/concave/client";

const todos = client.resource<Todo>("/api/todos");

const liveQuery = createLiveQuery(todos, {
  filter: 'userId=="123"',
  orderBy: "position",
  limit: 100,
}, {
  onAuthError: () => redirectToLogin(),
  getPendingCount: () => client.getPendingCount(),
  onIdRemapped: (optimisticId, serverId) => {
    console.log(`ID changed: ${optimisticId} -> ${serverId}`);
  },
});

// Get current state (stable reference for useSyncExternalStore)
const state = liveQuery.getSnapshot();
console.log(state.items, state.status, state.error);

// Subscribe to changes
const unsubscribe = liveQuery.subscribe(() => {
  const newState = liveQuery.getSnapshot();
  render(newState);
});

// Optimistic mutations
liveQuery.mutate.create({ title: "New todo" });
liveQuery.mutate.update("123", { completed: true });
liveQuery.mutate.delete("123");

// Force refresh
await liveQuery.refresh();

// Get status label
const label = statusLabel(state.status, state.pendingCount);
// "Live", "Loading...", "Offline (3 pending)", etc.

// Cleanup
liveQuery.destroy();
```

## Type Generation

Generate TypeScript types from your API schema:

```typescript
import { generateTypes } from "@kahveciderin/concave/client";
import { writeFileSync } from "fs";

async function main() {
  const result = await generateTypes({
    serverUrl: "http://localhost:3000",
    output: "typescript",
    includeClient: true,
  });

  writeFileSync("./src/generated/api-types.ts", result.code);
  console.log(`Generated types for: ${result.schema.resources.map(r => r.name).join(", ")}`);
}

main();
```

### CLI Usage

```bash
npx concave typegen --server http://localhost:3000 --output ./src/generated/api-types.ts
```

### Generated Types

The typegen generates several useful types:

```typescript
// Generated api-types.ts includes:

// Resource types
export interface Todo { id: string; title: string; completed: boolean; ... }
export interface User { id: string; name: string; email: string; ... }

// Input/Update types
export type TodoInput = Omit<Todo, 'id'>;
export type TodoUpdate = Partial<TodoInput>;

// Field metadata types (for type-safe queries)
export type TodoFields = 'id' | 'title' | 'completed' | ...;
export type TodoNumericFields = 'position';
export type TodoStringFields = 'id' | 'title';

// Path constants
export const ResourcePaths = {
  todo: '/api/todos',
  user: '/api/users',
} as const;

// Typed client factory
export function createTypedClient(baseClient): TypedConcaveClient;
```

### Typed Client Factory

The generated `createTypedClient` function creates a fully typed client with resource accessors:

```typescript
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { createTypedClient } from "./generated/api-types";

// Create base client
const baseClient = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});

// Wrap with typed client
const client = createTypedClient(baseClient);

// Now use typed resources - no type parameters needed!
const todos = await client.resources.todos.list();  // todos: Todo[]
const users = await client.resources.users.list();  // users: User[]

// Type-safe query builder
const result = await client.resources.todos
  .query()
  .select('id', 'title')
  .filter('completed==false')
  .list();
// result.items type: { id: string; title: string }[]

// Type-safe aggregations
const stats = await client.resources.users
  .query()
  .groupBy('role')
  .withCount()
  .avg('age')
  .aggregate();
```

### Using with React Hooks

The typed resources work seamlessly with `useLiveList`:

```typescript
import { useLiveList } from "@kahveciderin/concave/client/react";
import { createTypedClient } from "./generated/api-types";

const client = createTypedClient(getOrCreateClient({ baseUrl: location.origin }));

function TodoList() {
  // Type is automatically inferred from client.resources.todos
  const { items, mutate } = useLiveList(
    client.resources.todos,
    { orderBy: 'position' }
  );
  // items type: Todo[]

  return (
    <ul>
      {items.map(todo => (
        <li key={todo.id}>
          {todo.title}
          <button onClick={() => mutate.delete(todo.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

## Error Handling

```typescript
import { TransportError } from "@kahveciderin/concave/client";

try {
  await todos.get("nonexistent");
} catch (error) {
  if (error instanceof TransportError) {
    if (error.isNotFound()) {
      console.log("Todo not found");
    } else if (error.isUnauthorized()) {
      console.log("Please login");
    } else if (error.isForbidden()) {
      console.log("Access denied");
    } else if (error.isRateLimited()) {
      console.log("Too many requests, retry after:", error.retryAfter);
    } else if (error.isValidationError()) {
      console.log("Validation failed:", error.details);
    }
  }
}
```

## Complete Example

Here's a complete example of a todo app with authentication, real-time updates, and offline support:

```typescript
// client.ts
import { getOrCreateClient } from "@kahveciderin/concave/client";

export const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});

// App.tsx
import { useEffect, useState } from "react";
import { useAuth, useLiveList } from "@kahveciderin/concave/client/react";
import { client } from "./client";

interface User {
  id: string;
  name: string;
}

interface Todo {
  id: string;
  title: string;
  completed: boolean;
  position: number;
}

export function App() {
  const { user, isLoading, isAuthenticated, logout } = useAuth<User>();

  // Set global auth error handler
  useEffect(() => {
    client.setAuthErrorHandler(logout);
  }, [logout]);

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <LoginForm />;

  return <TodoApp user={user!} onLogout={logout} />;
}

function TodoApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [newTodo, setNewTodo] = useState("");
  const { items: todos, status, statusLabel, mutate } = useLiveList<Todo>(
    "/api/todos",
    { orderBy: "position" }
  );

  const addTodo = () => {
    if (!newTodo.trim()) return;
    mutate.create({ title: newTodo.trim(), completed: false, position: todos.length });
    setNewTodo("");
  };

  return (
    <div>
      <header>
        <h1>Todos</h1>
        <span>Hi, {user.name}!</span>
        <button onClick={onLogout}>Sign out</button>
      </header>

      <input
        value={newTodo}
        onChange={(e) => setNewTodo(e.target.value)}
        onKeyDown={(e) => e.key === "Enter" && addTodo()}
        placeholder="What needs to be done?"
      />
      <button onClick={addTodo}>Add</button>

      <ul>
        {todos.map((todo) => (
          <li key={todo.id}>
            <input
              type="checkbox"
              checked={todo.completed}
              onChange={() => mutate.update(todo.id, { completed: !todo.completed })}
            />
            <span style={{ textDecoration: todo.completed ? "line-through" : "none" }}>
              {todo.title}
            </span>
            <button onClick={() => mutate.delete(todo.id)}>Delete</button>
          </li>
        ))}
      </ul>

      <footer>
        <span className={`status-${status}`} />
        {statusLabel}
      </footer>
    </div>
  );
}
```

## API Reference

### Types

```typescript
// Client configuration
interface SimplifiedClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  offline?: boolean | OfflineConfig;
  onError?: (error: Error) => void;
  onSyncComplete?: () => void;
  authCheckUrl?: string;
}

// Offline configuration
interface OfflineConfig {
  enabled: boolean;
  storage?: OfflineStorage;
  maxRetries?: number;
  retryDelay?: number;
  onIdRemapped?: (optimisticId: string, serverId: string) => void;
}

// Live query state
interface LiveQueryState<T> {
  items: T[];
  status: "loading" | "live" | "reconnecting" | "offline" | "error";
  error: Error | null;
  pendingCount: number;
  lastSeq: number;
}

// useLiveList options
interface UseLiveListOptions<T, K extends keyof T = keyof T> {
  filter?: string;
  orderBy?: string;
  limit?: number;
  include?: string;
  subscriptionMode?: "strict" | "sorted" | "append" | "prepend" | "live";
  enabled?: boolean;
  select?: K[];  // Type-safe field selection
}

// useLiveList result
interface UseLiveListResult<T> {
  items: T[];
  status: LiveStatus;
  statusLabel: string;
  error: Error | null;
  pendingCount: number;
  isLoading: boolean;
  isLive: boolean;
  isOffline: boolean;
  isReconnecting: boolean;
  hasMore: boolean;
  totalCount?: number;
  isLoadingMore: boolean;
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

// Mutation methods
interface LiveQueryMutations<T> {
  create: (data: Omit<T, "id">) => void;
  update: (id: string, data: Partial<T>) => void;
  delete: (id: string) => void;
}

// Query builder state
interface QueryBuilderState<T> {
  select?: (keyof T)[];
  filter?: string;
  orderBy?: string;
  limit?: number;
  cursor?: string;
  include?: string;
  totalCount?: boolean;
  groupBy?: (keyof T)[];
  count?: boolean;
  sum?: (keyof T)[];
  avg?: (keyof T)[];
  min?: (keyof T)[];
  max?: (keyof T)[];
}

// Utility types for type-safe queries
type NumericKeys<T> = { [K in keyof T]: T[K] extends number | null ? K : never }[keyof T];
type ComparableKeys<T> = { [K in keyof T]: T[K] extends number | string | Date | null ? K : never }[keyof T];

// Typed aggregation response
interface TypedAggregationResponse<T, GroupKeys, SumKeys, AvgKeys, MinKeys, MaxKeys, HasCount> {
  groups: Array<{
    key: GroupKeys extends never ? null : Pick<T, GroupKeys>;
    count?: HasCount extends true ? number : never;
    sum?: SumKeys extends never ? never : { [K in SumKeys]: number };
    avg?: AvgKeys extends never ? never : { [K in AvgKeys]: number };
    min?: MinKeys extends never ? never : { [K in MinKeys]: T[K] };
    max?: MaxKeys extends never ? never : { [K in MaxKeys]: T[K] };
  }>;
}
```
