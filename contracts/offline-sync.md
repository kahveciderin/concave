# Offline Sync Contracts

## Guarantees

### Optimistic Updates
- **Immediate UI update**: Mutations are applied to local state immediately
- **Optimistic ID generation**: Created items get client-generated IDs until server confirms
- **ID remapping**: When server assigns real ID, all local references are updated

### Mutation Queue
- **Persistence**: Queued mutations survive page refresh (with persistent storage)
- **Ordering**: Mutations are synced in queue order (FIFO)
- **Deduplication**: Duplicate mutations (same idempotency key) are merged

### Sync Behavior
- **Automatic sync**: Mutations sync automatically when online
- **Retry with backoff**: Failed syncs retry with exponential backoff
- **Conflict detection**: Server conflicts are detected and reported

### ID Remapping
- **Recursive remapping**: All references to optimistic IDs in mutation data are remapped
- **Cross-resource support**: Foreign key references to optimistic IDs are remapped
- **Notification**: `onIdRemapped` callback fired when mapping established

### Reconnection
- **Pending state preservation**: Pending deletes/updates survive reconnection
- **No ghost items**: Deleted items don't reappear on reconnection
- **Pending updates applied**: Local updates applied to server state on reconnect

## Non-Guarantees

### Ordering (What We Don't Promise)
- ❌ **Server-side ordering**: Server may process mutations in different order than sent
- ❌ **Cross-client ordering**: Mutations from different clients are not globally ordered

### Consistency (What We Don't Promise)
- ❌ **Strong consistency**: Eventual consistency between client and server
- ❌ **Conflict resolution**: Automatic conflict resolution only with configured strategy

### Durability (What We Don't Promise)
- ❌ **Guaranteed persistence**: In-memory storage loses data on refresh
- ❌ **Unlimited queue**: Queue has max size; oldest mutations may be dropped

## Conflict Resolution Strategies

### Server Wins (Default)
- Conflict detected → discard client mutation
- Server state is authoritative
- Simple but may lose client work

### Client Wins
- Conflict detected → retry with client data
- May overwrite concurrent server changes
- Use for last-write-wins semantics

### Manual Resolution
- Conflict detected → call `onConflict` handler
- Application decides resolution
- Most flexible but requires implementation

## Failure Modes

### Network Failure During Sync
- Mutation stays in queue (status: failed)
- Retried on next sync attempt
- After max retries, mutation marked permanently failed

### Optimistic ID Never Confirmed
- Optimistic item remains in local state
- Referenced mutations may fail due to invalid ID
- `onMutationFailed` callback fired

### Conflict on Create
- Server rejects create (e.g., unique constraint)
- Client notified via `onConflict` or `onMutationFailed`
- Optimistic item remains until resolution

### Subscription Reconnect with Pending Mutations
- Server sends `existing` events with server IDs
- Client checks `pendingDeletes` and `pendingUpdates`
- Pending state is preserved until server confirmation

## Best Practices

### Idempotency Keys
- Always include idempotency keys for create/update operations
- Use deterministic keys (e.g., `${resource}-${optimisticId}-${timestamp}`)
- Keys are used for deduplication and replay safety

### Optimistic IDs
- Use recognizable prefix (e.g., `optimistic_`)
- Include timestamp and random component
- Never rely on optimistic IDs for persistence

### Conflict Handling
- Implement `onConflict` handler for important operations
- Log conflicts for debugging
- Consider user notification for manual resolution

## Test Coverage

- `tests/sync/offline-sync-edge-cases.test.ts` - Comprehensive sync scenarios
- `tests/client/offline.test.ts` - Basic offline functionality
- `tests/client/live-store.test.ts` - LiveQuery + offline integration
