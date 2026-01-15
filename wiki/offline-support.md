# Offline Support

Concave's client library supports offline-first applications with optimistic updates, mutation queueing, and automatic synchronization.

## Overview

When your application goes offline:
1. Read operations fail (or use cached data)
2. Write operations with `optimistic: true` are queued locally
3. Queued mutations sync automatically when online

## Setup

### Basic Configuration

```typescript
import { createClient } from "concave/client";

const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: {
    enabled: true,
    maxRetries: 3,        // Max sync retry attempts
    retryDelay: 1000,     // Initial retry delay (ms)
  },
  onError: (error) => {
    console.error("Sync error:", error);
  },
});
```

### Custom Storage

By default, offline mutations are stored in memory. For persistence across page reloads, use LocalStorage:

```typescript
import { createClient, LocalStorageOfflineStorage } from "concave/client";

const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("my-app-offline"),
  },
});
```

Or implement your own storage (e.g., IndexedDB):

```typescript
import { OfflineStorage, OfflineMutation } from "concave/client";

class IndexedDBStorage implements OfflineStorage {
  async getMutations(): Promise<OfflineMutation[]> { /* ... */ }
  async addMutation(mutation: OfflineMutation): Promise<void> { /* ... */ }
  async updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void> { /* ... */ }
  async removeMutation(id: string): Promise<void> { /* ... */ }
  async clear(): Promise<void> { /* ... */ }
}
```

## Optimistic Updates

Enable optimistic updates by passing `{ optimistic: true }`:

```typescript
const users = client.resource<User>("/users");

// Create - returns immediately with temporary ID
const newUser = await users.create(
  { name: "Alice", email: "alice@example.com" },
  { optimistic: true }
);
console.log(newUser.id); // "optimistic_1704067200000"

// Update - returns immediately with optimistic data
const updated = await users.update(
  "123",
  { name: "Alice Smith" },
  { optimistic: true }
);

// Delete - returns immediately
await users.delete("123", { optimistic: true });
```

## Mutation Queue

### Viewing Pending Mutations

```typescript
const pending = await client.offline?.getPendingMutations();
console.log(pending);
// [
//   { id: "abc", type: "create", resource: "/users", data: {...}, status: "pending" },
//   { id: "def", type: "update", resource: "/users", data: {...}, status: "failed", retryCount: 1 }
// ]
```

### Manual Sync

```typescript
// Trigger sync manually
await client.offline?.syncPendingMutations();
```

### Clear Queue

```typescript
// Clear all pending mutations (use with caution!)
await client.offline?.clearMutations();
```

## Mutation Lifecycle

Each mutation goes through these states:

| State | Description |
|-------|-------------|
| `pending` | Waiting to be synced |
| `processing` | Currently being synced |
| `failed` | Sync failed, will retry |

## Error Handling

Handle sync errors through callbacks:

```typescript
const client = createClient({
  baseUrl: "http://localhost:3000/api",
  offline: {
    enabled: true,
  },
  onError: (error) => {
    // Called when a mutation fails to sync
    console.error("Sync failed:", error);

    // Show user notification
    toast.error("Failed to sync changes. Will retry...");
  },
});
```

For more granular control, use the OfflineManager directly:

```typescript
import { createOfflineManager, InMemoryOfflineStorage } from "concave/client";

const offlineManager = createOfflineManager({
  config: {
    enabled: true,
    maxRetries: 5,
    storage: new InMemoryOfflineStorage(),
  },
  onMutationSync: async (mutation) => {
    // Called for each mutation being synced
    // Implement your sync logic here
    console.log("Syncing:", mutation);
  },
  onMutationFailed: (mutation, error) => {
    // Called when a mutation fails
    console.error("Failed:", mutation, error);
  },
  onSyncComplete: () => {
    // Called when sync cycle completes
    console.log("Sync complete");
  },
});
```

## Offline Detection

```typescript
// Check current online status
const isOnline = client.offline?.getIsOnline();

// The client automatically listens to browser online/offline events
// and syncs when coming back online
```

## Example: Offline-First Todo App

```typescript
const client = createClient({
  baseUrl: "/api",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage("todos"),
  },
});

const todos = client.resource<Todo>("/todos");

// UI state
let localTodos: Todo[] = [];

// Load initial data
async function loadTodos() {
  try {
    const result = await todos.list();
    localTodos = result.items;
  } catch (error) {
    // Use cached data if offline
    console.log("Using cached data");
  }
  renderTodos();
}

// Add todo (works offline)
async function addTodo(text: string) {
  const todo = await todos.create(
    { text, completed: false },
    { optimistic: true }
  );

  // Add to local state immediately
  localTodos.push(todo);
  renderTodos();
}

// Toggle completion (works offline)
async function toggleTodo(id: string) {
  const todo = localTodos.find(t => t.id === id);
  if (!todo) return;

  const updated = await todos.update(
    id,
    { completed: !todo.completed },
    { optimistic: true }
  );

  // Update local state immediately
  const index = localTodos.findIndex(t => t.id === id);
  localTodos[index] = { ...todo, ...updated };
  renderTodos();
}

// Delete todo (works offline)
async function deleteTodo(id: string) {
  await todos.delete(id, { optimistic: true });

  // Remove from local state immediately
  localTodos = localTodos.filter(t => t.id !== id);
  renderTodos();
}
```

## Conflict Resolution

When syncing optimistic mutations, conflicts may occur if the server state has changed. Handle conflicts in your sync logic:

```typescript
const offlineManager = createOfflineManager({
  config: { enabled: true },
  onMutationSync: async (mutation) => {
    try {
      if (mutation.type === "update") {
        // Fetch current server state
        const current = await resource.get(mutation.objectId!);

        // Check for conflicts
        if (current.updatedAt > mutation.timestamp) {
          // Server has newer data - handle conflict
          // Option 1: Server wins
          return;

          // Option 2: Client wins
          // Continue with update

          // Option 3: Merge
          // Merge changes and update
        }

        await resource.update(mutation.objectId!, mutation.data);
      }
      // ... handle other mutation types
    } catch (error) {
      throw error; // Will trigger retry
    }
  },
});
```

## Best Practices

1. **Use optimistic updates for UX** - Users see immediate feedback
2. **Show sync status** - Indicate when mutations are pending
3. **Handle conflicts gracefully** - Don't lose user data
4. **Persist mutations** - Use LocalStorage or IndexedDB for reliability
5. **Set reasonable retry limits** - Avoid infinite retry loops
6. **Provide manual retry** - Let users trigger sync manually
7. **Clear old mutations** - Clean up completed/failed mutations periodically

## Limitations

- Read operations require network (consider caching separately)
- Batch operations are not queued (single-item operations only)
- Subscription events are lost while offline
- Optimistic IDs are temporary and change after sync
