# Client Library

The Concave client library provides a type-safe, real-time client for interacting with your Concave API. It includes React hooks, offline support, optimistic updates, and live subscriptions.

## Installation

The client is included with the main package:

```typescript
import { createClient, getOrCreateClient } from "concave/client";
import { useLiveList, useAuth } from "concave/client/react";
```

## Quick Start

### Basic Setup

```typescript
import { getOrCreateClient } from "concave/client";
import { useLiveList, useAuth } from "concave/client/react";

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
import { createClient } from "concave/client";

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
import { getOrCreateClient } from "concave/client";

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

## React Hooks

### useLiveList

The primary hook for real-time lists with optimistic updates:

```typescript
import { useLiveList } from "concave/client/react";

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
    enabled: true,  // Set to false to disable the query
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

### useAuth

Hook for authentication state management:

```typescript
import { useAuth } from "concave/client/react";

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
import { createLiveQuery, statusLabel } from "concave/client";

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
import { generateTypes } from "concave/client";
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

## Error Handling

```typescript
import { TransportError } from "concave/client";

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
import { getOrCreateClient } from "concave/client";

export const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
  offline: true,
});

// App.tsx
import { useEffect, useState } from "react";
import { useAuth, useLiveList } from "concave/client/react";
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
interface UseLiveListOptions {
  filter?: string;
  orderBy?: string;
  limit?: number;
  enabled?: boolean;
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
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
}

// Mutation methods
interface LiveQueryMutations<T> {
  create: (data: Omit<T, "id">) => void;
  update: (id: string, data: Partial<T>) => void;
  delete: (id: string) => void;
}
```
