# Client Library

The Concave client library provides a type-safe way to interact with your API.

## Installation

The client is included with the main package:

```typescript
import { createClient } from "concave/client";
```

## Quick Start

```typescript
import { createClient } from "concave/client";

// Create client
const client = createClient({
  baseUrl: "http://localhost:3000",
});

// Get resource
const users = client.resource<User>("/users");

// List users
const { items, nextCursor } = await users.list({
  filter: 'status=="active"',
  limit: 20,
});

// Get single user
const user = await users.get("user-123");

// Create user
const newUser = await users.create({
  email: "john@example.com",
  name: "John Doe",
});

// Update user
const updated = await users.update("user-123", {
  name: "John Updated",
});

// Delete user
await users.delete("user-123");
```

## Authentication

```typescript
// Set auth token
client.setAuthToken("your-jwt-token");

// Clear auth token
client.clearAuthToken();
```

## Pagination

```typescript
// First page
const page1 = await users.list({ limit: 20 });

// Next page
if (page1.hasMore) {
  const page2 = await users.list({
    limit: 20,
    cursor: page1.nextCursor,
  });
}

// With total count
const result = await users.list({
  limit: 20,
  totalCount: true,
});
console.log(`Total: ${result.totalCount}`);
```

## Filtering

```typescript
// Simple filter
const active = await users.list({
  filter: 'status=="active"',
});

// Complex filter
const result = await users.list({
  filter: '(age=gt=18;status=="active"),(role=="admin")',
});
```

## Projections

```typescript
// Select specific fields
const result = await users.list({
  select: ["id", "name", "email"],
});
```

## Aggregations

```typescript
const stats = await users.aggregate({
  groupBy: ["role"],
  count: true,
  avg: ["age"],
});

// Result:
// {
//   groups: [
//     { key: { role: "admin" }, count: 5, avg: { age: 35 } },
//     { key: { role: "user" }, count: 100, avg: { age: 28 } },
//   ]
// }
```

## Subscriptions

```typescript
const subscription = users.subscribe(
  { filter: 'status=="active"' },
  {
    onAdded: (user) => {
      console.log("New user:", user);
    },
    onChanged: (user) => {
      console.log("Updated:", user);
    },
    onRemoved: (id) => {
      console.log("Removed:", id);
    },
    onInvalidate: (reason) => {
      console.log("Need to refetch:", reason);
    },
    onError: (error) => {
      console.error("Error:", error);
    },
  }
);

// Access current items
console.log(subscription.items);

// Check connection status
console.log(subscription.state.isConnected);

// Cleanup
subscription.unsubscribe();
```

## Batch Operations

```typescript
// Batch create
const created = await users.batchCreate([
  { email: "user1@example.com" },
  { email: "user2@example.com" },
]);

// Batch update
const { count } = await users.batchUpdate(
  'status=="pending"',
  { status: "active" }
);

// Batch delete
const { count } = await users.batchDelete('status=="deleted"');
```

## RPC Procedures

```typescript
const result = await users.rpc<
  { newEmail: string },
  { success: boolean }
>("changeEmail", { newEmail: "new@example.com" });
```

## Offline Support

```typescript
import { LocalStorageOfflineStorage } from "concave/client";

const client = createClient({
  baseUrl: "http://localhost:3000",
  offline: {
    enabled: true,
    storage: new LocalStorageOfflineStorage(),
    maxRetries: 3,
  },
});

// Mutations are queued when offline
await users.create(
  { name: "John" },
  { optimistic: true }  // Returns immediately with temp ID
);

// Mutations sync automatically when online
```

## Error Handling

```typescript
import { TransportError } from "concave/client";

try {
  await users.get("nonexistent");
} catch (error) {
  if (error instanceof TransportError) {
    if (error.isNotFound()) {
      console.log("User not found");
    } else if (error.isUnauthorized()) {
      console.log("Please login");
    } else if (error.isRateLimited()) {
      console.log("Too many requests");
    }
  }
}
```
