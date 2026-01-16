# Subscriptions

Concave provides real-time subscriptions via Server-Sent Events (SSE).

## Quick Start with React

The easiest way to use subscriptions is with the `useLiveList` hook:

```typescript
import { getOrCreateClient } from "concave/client";
import { useLiveList } from "concave/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
});

function UserList() {
  const { items, status, statusLabel, mutate } = useLiveList<User>(
    "/api/users",
    { filter: 'status=="active"' }
  );

  // items automatically updates in real-time
  // status: "loading" | "live" | "reconnecting" | "offline" | "error"

  return (
    <div>
      <div>Status: {statusLabel}</div>
      <ul>
        {items.map(user => (
          <li key={user.id}>{user.name}</li>
        ))}
      </ul>
    </div>
  );
}
```

## Server Setup

Subscriptions are automatically available at `/subscribe`:

```bash
curl -N "http://localhost:3000/users/subscribe"
```

## Low-Level Client API

For non-React usage or more control:

```typescript
import { getOrCreateClient } from "concave/client";

const client = getOrCreateClient({ baseUrl: "http://localhost:3000" });
const users = client.resource<User>("/users");

const subscription = users.subscribe(
  { filter: 'status=="active"' },
  {
    onAdded: (user, meta) => {
      console.log("Added:", user);
      // meta.optimisticId available if this was from an optimistic create
    },
    onChanged: (user) => console.log("Changed:", user),
    onRemoved: (id) => console.log("Removed:", id),
    onConnected: (seq) => console.log("Connected at sequence:", seq),
    onDisconnected: () => console.log("Disconnected"),
    onInvalidate: () => console.log("Cache invalidated"),
    onError: (error) => console.error("Error:", error),
  }
);

// Reconnect after disconnect
subscription.reconnect();

// Resume from a specific sequence
subscription.resumeFrom(lastSeq);

// Cleanup
subscription.unsubscribe();
```

## Event Types

### `existing`
Sent for each existing item when first subscribing:
```json
{
  "type": "existing",
  "seq": 1,
  "object": { "id": "1", "name": "John" }
}
```

### `added`
Sent when a new item is created that matches the filter:
```json
{
  "type": "added",
  "seq": 2,
  "object": { "id": "2", "name": "Jane" }
}
```

### `changed`
Sent when an item is updated:
```json
{
  "type": "changed",
  "seq": 3,
  "object": { "id": "1", "name": "John Updated" }
}
```

### `removed`
Sent when an item is deleted or no longer matches the filter:
```json
{
  "type": "removed",
  "seq": 4,
  "objectId": "1"
}
```

### `invalidate`
Sent when the client needs to refetch all data:
```json
{
  "type": "invalidate",
  "seq": 5,
  "reason": "Sequence gap - please refetch"
}
```

## Changelog-Based Subscriptions

Concave uses a changelog-based approach for reliable subscriptions:

1. Every mutation is recorded with a sequence number
2. Clients track their last received sequence
3. On reconnection, clients can resume from their last sequence
4. If too many changes occurred, an invalidate event is sent

### Reconnection

```typescript
const subscription = users.subscribe({
  resumeFrom: lastSeq,  // Resume from last known sequence
});
```

## Filter Updates

When an item is updated and moves in/out of the filter:

- **Enters filter**: Client receives an `added` event
- **Stays in filter**: Client receives a `changed` event
- **Leaves filter**: Client receives a `removed` event

## Authentication

Subscriptions respect auth scopes. If a user's auth expires:

```json
{
  "type": "invalidate",
  "reason": "Authentication expired"
}
```

## Connection Management

The subscription manager handles:
- Automatic reconnection with exponential backoff
- Heartbeat to detect connection issues
- Cleanup on page unload
