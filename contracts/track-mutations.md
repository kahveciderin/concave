# Mutation Tracking Contracts

## Guarantees

### Automatic Tracking in Procedures
- **ctx.db is tracked**: When using `useResource`, the `ctx.db` provided to procedure handlers is automatically wrapped with tracking for the current resource
- **Double-wrapping prevention**: If the db passed to `useResource` is already tracked, it won't be wrapped again (checked via `isTrackedDb`)
- **Multi-table support**: For procedures that modify multiple tables, pass a pre-configured tracked db to `config.db`

### Changelog Recording
- **Builder pattern completeness**: Every `insert()`, `update()`, `delete()` operation using the builder pattern records a changelog entry
- **Returning required for full tracking**: Mutations with `.returning()` capture the full object; without `.returning()`, only the ID is captured from input values
- **Previous state capture**: Updates and deletes capture `previousObject` via a pre-mutation SELECT (when `capturePreviousState` is true)

### Raw SQL Detection
- **Pattern matching**: INSERT, UPDATE, DELETE statements are detected via SQL string parsing
- **Table extraction**: Table name is extracted from the SQL and matched to registered tables
- **Partial tracking**: Raw SQL mutations record `objectId: "*"` (indicating unknown specific IDs)
- **Invalidate semantics**: Raw SQL mutations trigger `invalidate` events for subscribers

### Subscription Integration
- **Automatic push**: Mutations automatically push events to active subscriptions (when `pushToSubscriptions` is true)
- **Event type mapping**:
  - Insert → `added` event
  - Update → `changed` event (with filter scope tracking)
  - Delete → `removed` event
  - Raw SQL → `invalidate` event

### Transaction Handling
- **Transaction wrapping**: Wrapped transactions track all mutations within them
- **Same semantics**: Mutations in transactions behave identically to non-transactional mutations
- **No rollback tracking**: If a transaction rolls back, changelog entries are NOT removed (they were never written)

### Cache Invalidation
- **Table-level invalidation**: Any mutation to a table invalidates ALL cached queries for that table
- **Automatic clearing**: Cache invalidation happens after successful mutation, before returning
- **TTL support**: Cached queries respect configured TTL independently of mutation-based invalidation

## Non-Guarantees

### Tracking Completeness
- ❌ **Unregistered tables**: Operations on tables not in the registry are NOT tracked
- ❌ **Raw SQL specificity**: Raw SQL cannot identify specific affected IDs (always uses `objectId: "*"`)
- ❌ **Complex raw SQL parsing**: CTEs, subqueries, and complex SQL patterns may not have their mutation type or table correctly detected

### Cache Behavior
- ❌ **Cross-table invalidation**: Mutations only invalidate caches for the mutated table, not related tables
- ❌ **Query-level granularity**: We don't track which rows a query touches; entire table cache is invalidated
- ❌ **Key set cleanup**: Cache key tracking sets may not be cleaned up when cached data expires via TTL

### Ordering
- ❌ **Global ordering**: Mutations across different database connections are NOT globally ordered
- ❌ **Atomic changelog + data**: The mutation and changelog entry are NOT in a single atomic transaction

## Failure Modes

### Mutation Error
- Changelog entry is NOT recorded if the underlying mutation fails
- No partial state: either both mutation and changelog succeed, or neither does

### Cache Unavailable
- If global KV is not configured, caching is silently disabled
- Cache invalidation attempts are no-ops when KV is unavailable

### SQL Parsing Failure
- If raw SQL cannot be parsed for mutation type/table, no changelog entry is recorded
- The mutation still executes successfully
- No `invalidate` event is triggered

### Previous State Fetch Failure
- If pre-mutation SELECT fails, the mutation continues with `previousObject: undefined`
- Subscription events may have incomplete data

## Invariants

### Idempotent Tracking
- Wrapping an already-wrapped database is safe (the outer wrapper detects and passes through)

### State Consistency
- `hasConflictHandler` prevents false positive mutations on `onConflictDoNothing`
- Empty update/delete results (no rows affected) produce no changelog entries

### Tracking Control
- `withoutTracking` completely disables all tracking for the callback scope
- `skipTables` excludes specific tables from any tracking

## Test Coverage

- `tests/track-mutations.test.ts` - Core functionality
  - Insert tracking (single, batch, returning)
  - Update tracking (with previousObject)
  - Delete tracking (with previousObject)
  - Raw SQL detection (INSERT, UPDATE, DELETE, SELECT)
  - Transaction tracking
  - Configuration options (skipTables, withoutTracking, customResourceName, capturePreviousState)
  - Edge cases (onConflictDoNothing, empty update/delete)
- Query caching tests (same file)
  - Cache behavior (hit, invalidate on mutation)
  - Manual invalidation
  - Configuration (per-table settings, custom prefix)
