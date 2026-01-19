# Search Contracts

## Guarantees

### Search Endpoint
- **Automatic availability**: `/search` endpoint is available on all resources when a global search adapter is configured
- **Zero-config default**: All fields are searchable by default without explicit configuration
- **Query required**: Search endpoint requires a `q` parameter and returns 400 if missing
- **Graceful degradation**: Returns 501 if no search adapter configured (not an error in production)

### Auto-Indexing
- **Create → index**: New documents are indexed immediately after successful database insert
- **Update → re-index**: Modified documents are re-indexed after successful database update
- **Delete → remove**: Documents are removed from index after successful database delete
- **Index errors don't fail mutations**: If indexing fails, the database mutation still succeeds (logged as error)

### Field Configuration
- **Array fields**: When `fields` is an array, only those fields are searched
- **Weight support**: Field weights are passed to the search adapter for boosting
- **Searchable flag**: `searchable: false` excludes a field from search queries

### Filter Integration
- **Post-filter**: RSQL filters are applied after search results are returned
- **Full operator support**: All standard RSQL operators work with search results

## Non-Guarantees

### Search Behavior (What We Don't Promise)
- ❌ **Exact matching**: Search is fuzzy by default; exact match not guaranteed
- ❌ **Consistent scoring**: Search scores may vary between adapter implementations
- ❌ **Instant indexing**: Index updates may have slight delay (OpenSearch refresh)
- ❌ **Offline search**: Memory adapter data is lost on restart

### Data Consistency (What We Don't Promise)
- ❌ **Index-database sync**: Index may briefly be out of sync with database
- ❌ **Transactional indexing**: Index updates are not part of database transaction
- ❌ **Automatic reindexing**: Existing data is not automatically indexed on startup

### Performance (What We Don't Promise)
- ❌ **Bounded latency**: Search latency depends on adapter and index size
- ❌ **Unlimited results**: Results are capped at 100 per request

## Failure Modes

### No Search Adapter
- Endpoint returns 404 Not Found (search not available)
- Auto-indexing does nothing (silent)
- Resource CRUD operations work normally

### Index Error
- Index/delete errors are logged but don't fail mutations
- Search continues to work with potentially stale data
- No automatic retry of failed index operations

### Search Error
- Endpoint returns 500 with `SearchError` (RFC 7807 Problem Details format)
- Includes `index` name and `originalError` message in details
- RSQL filter errors return 400 with `ValidationError`

### Missing Query Parameter
- Endpoint returns 400 with `ValidationError`
- Message: "Missing query parameter 'q'"

## Test Coverage

- `tests/search/adapter.test.ts` - Global adapter registration
- `tests/search/memory-adapter.test.ts` - Memory adapter behavior
- `tests/search/endpoint.test.ts` - Search endpoint functionality
- `tests/search/auto-index.test.ts` - Auto-indexing hooks
