# Subscription Contracts

## Guarantees

### Event Delivery
- **At-least-once delivery**: Every mutation that matches a subscription's filter will generate at least one event
- **Event exclusivity**: A single mutation generates exactly one of: `added`, `changed`, `removed`, or `invalidate` per subscription (never multiple conflicting events)
- **Filter scope transitions**:
  - Item entering filter scope → `added`
  - Item leaving filter scope → `removed`
  - Item staying in scope + modified → `changed`
  - Item never in scope → no event

### Ordering
- **Per-connection ordering**: Events on a single connection are delivered in sequence number order
- **Monotonic sequences**: Sequence numbers always increase within a connection
- **No duplicate sequences**: Each sequence number appears at most once per connection

### Resume Semantics
- **Gap detection**: If client resumes from sequence N but server's oldest is N+k, server sends `invalidate`
- **Catchup delivery**: If gap is within retention window, missed events are sent in order
- **Fresh start**: Resume from sequence 0 sends all matching items as `existing` events

### Scope Changes
- **Immediate effect**: When user loses scope to an item, they receive `removed` immediately
- **Auth integration**: Scope changes (permission revocation) trigger appropriate events

## Non-Guarantees

### Ordering (What We Don't Promise)
- ❌ **Global ordering**: Events across different subscriptions are NOT globally ordered
- ❌ **Cross-resource ordering**: Events for different resources are NOT ordered relative to each other
- ❌ **Real-time delivery**: Network delays may cause events to arrive later than expected

### Delivery (What We Don't Promise)
- ❌ **Exactly-once delivery**: We guarantee at-least-once, not exactly-once
- ❌ **Bounded latency**: No SLA on event delivery time
- ❌ **Infinite retention**: Changelog has a max size; old events are pruned

### State (What We Don't Promise)
- ❌ **Snapshot consistency**: `existing` events represent a point-in-time snapshot; items may change during enumeration

## Failure Modes

### Network Disconnection
- Client receives `disconnected` callback
- On reconnect, client should resume from last sequence
- If gap too large, `invalidate` triggers full refetch

### Server Restart
- Active subscriptions are terminated
- Clients reconnect and resume normally
- Changelog persists across restarts (if configured)

### Changelog Overflow
- Oldest entries are pruned when max size reached
- Clients with stale sequences receive `invalidate`
- This is normal operation, not an error

## Test Coverage

- `tests/invariants/subscription-invariants.test.ts` - Core invariants
- `tests/subscription.test.ts` - Basic functionality
- `tests/subscription/backpressure.test.ts` - Load handling
- `tests/concurrency/subscribe-while-mutate.test.ts` - Concurrent operations
