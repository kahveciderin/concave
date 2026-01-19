# Search

Concave provides built-in search integration that automatically adds `/search` endpoints to resources when a search adapter is configured. By default, all fields are searchable with zero configuration required.

## Quick Start

```typescript
import express from "express";
import { useResource, setGlobalSearch, createOpenSearchAdapter } from "@kahveciderin/concave";

const app = express();

// Configure the global search adapter
setGlobalSearch(createOpenSearchAdapter({
  node: "http://localhost:9200",
}));

// Resources automatically get a /search endpoint
app.use("/api/todos", useResource(db, todos));

// GET /api/todos/search?q=important
// Returns: { items: [...], total: 10 }
```

## Search Adapters

### OpenSearch Adapter

For production use with OpenSearch or Elasticsearch:

```typescript
import { setGlobalSearch, createOpenSearchAdapter } from "@kahveciderin/concave";

setGlobalSearch(createOpenSearchAdapter({
  node: "http://localhost:9200",
  // Or multiple nodes:
  // node: ["http://node1:9200", "http://node2:9200"],
  auth: {
    username: "admin",
    password: "admin",
  },
  ssl: {
    rejectUnauthorized: false,
  },
  indexPrefix: "myapp_",  // Default: "concave_"
}));
```

The OpenSearch adapter:
- Uses `multi_match` queries with `best_fields` type
- Enables fuzzy matching with `AUTO` fuzziness
- Supports field boosting (weights)
- Refreshes after each index/delete operation

### Memory Adapter

For development and testing without external dependencies:

```typescript
import { setGlobalSearch, createMemorySearchAdapter } from "@kahveciderin/concave";

setGlobalSearch(createMemorySearchAdapter());
```

The memory adapter:
- Stores documents in memory
- Performs case-insensitive substring matching
- Supports all the same operations as OpenSearch
- Does not persist between restarts

## Search Endpoint

When search is enabled, resources get a `GET /search` endpoint:

```
GET /api/todos/search?q=important&filter=completed==false&limit=10&offset=0&highlight=true
```

### Query Parameters

| Parameter | Description | Default |
|-----------|-------------|---------|
| `q` | Search query (required) | - |
| `filter` | RSQL filter to apply to results | - |
| `limit` | Maximum results to return | 20 |
| `offset` | Number of results to skip | 0 |
| `highlight` | Include highlighted matches | false |

### Response Format

```json
{
  "items": [
    {
      "id": 1,
      "title": "Important Task",
      "description": "Do this first",
      "status": "active"
    }
  ],
  "total": 15,
  "highlights": {
    "1": {
      "title": ["<em>Important</em> Task"]
    }
  }
}
```

## Resource Configuration

### Enable/Disable Search

Search is enabled automatically when a global search adapter is configured. To explicitly control it:

```typescript
// Disable search for a resource
app.use("/api/todos", useResource(db, todos, {
  search: { enabled: false }
}));

// Explicitly enable (default when adapter is configured)
app.use("/api/todos", useResource(db, todos, {
  search: { enabled: true }
}));
```

### Custom Index Name

By default, the resource table name is used as the index name. Override it:

```typescript
app.use("/api/todos", useResource(db, todos, {
  search: {
    indexName: "custom_todos_index"
  }
}));
```

### Searchable Fields

By default, all fields are searchable. Restrict to specific fields:

```typescript
// Array syntax: only search these fields
app.use("/api/todos", useResource(db, todos, {
  search: {
    fields: ["title", "description"]
  }
}));

// Object syntax: configure weights and searchability
app.use("/api/todos", useResource(db, todos, {
  search: {
    fields: {
      title: { weight: 2.0 },           // Boost title matches
      description: { weight: 1.0 },     // Normal weight
      internalNotes: { searchable: false }  // Exclude from search
    }
  }
}));
```

### Auto-Indexing

By default, documents are automatically indexed when created, updated, or deleted. Disable this for manual control:

```typescript
app.use("/api/todos", useResource(db, todos, {
  search: {
    autoIndex: false  // Disable auto-indexing
  }
}));
```

## Manual Index Management

For manual index control or bulk operations:

```typescript
import { getGlobalSearch } from "@kahveciderin/concave";

const search = getGlobalSearch();

// Index a document
await search.index("todos", "123", {
  id: 123,
  title: "Important Task",
  description: "Do this first"
});

// Delete from index
await search.delete("todos", "123");

// Search directly
const results = await search.search("todos", {
  query: "important",
  fields: ["title", "description"],
  fieldWeights: { title: 2.0 },
  from: 0,
  size: 20,
  highlight: true
});

// Index management
await search.createIndex("todos", {
  properties: {
    title: { type: "text" },
    description: { type: "text" },
    status: { type: "keyword" }
  }
});

await search.deleteIndex("todos");
const exists = await search.indexExists("todos");
```

## RSQL Filter Integration

Search results can be further filtered using RSQL:

```
GET /api/todos/search?q=task&filter=status==active;priority>=5
```

The filter is applied after the search query, allowing you to combine full-text search with structured filtering. All standard RSQL operators are supported.

## API Reference

### Global Functions

#### `setGlobalSearch(adapter)`

Registers the global search adapter.

```typescript
setGlobalSearch(createOpenSearchAdapter({ node: "http://localhost:9200" }));
```

#### `getGlobalSearch()`

Returns the registered search adapter. Throws if none registered.

```typescript
const search = getGlobalSearch();
await search.index("items", "1", { title: "Hello" });
```

#### `hasGlobalSearch()`

Returns `true` if a search adapter is registered.

```typescript
if (hasGlobalSearch()) {
  // Search is available
}
```

#### `clearGlobalSearch()`

Removes the registered search adapter. Useful for testing.

```typescript
clearGlobalSearch();
```

### Adapters

#### `createOpenSearchAdapter(config)`

Creates an adapter for OpenSearch/Elasticsearch.

```typescript
interface OpenSearchConfig {
  node: string | string[];
  auth?: { username: string; password: string };
  ssl?: { rejectUnauthorized?: boolean; ca?: string };
  indexPrefix?: string;  // Default: "concave_"
}
```

#### `createMemorySearchAdapter()`

Creates an in-memory adapter for development/testing.

### SearchAdapter Interface

All adapters implement this interface:

```typescript
interface SearchAdapter {
  index(indexName: string, id: string, document: Record<string, unknown>): Promise<void>;
  delete(indexName: string, id: string): Promise<void>;
  search<T>(indexName: string, query: SearchQuery): Promise<SearchResult<T>>;
  createIndex(indexName: string, mappings: IndexMappings): Promise<void>;
  deleteIndex(indexName: string): Promise<void>;
  indexExists(indexName: string): Promise<boolean>;
}
```

### Configuration Types

```typescript
interface ResourceSearchConfig {
  enabled?: boolean;        // Default: true if adapter configured
  indexName?: string;       // Default: table name
  fields?: string[] | Record<string, SearchFieldConfig>;
  autoIndex?: boolean;      // Default: true
}

interface SearchFieldConfig {
  weight?: number;          // Boost factor (default: 1.0)
  searchable?: boolean;     // Default: true
  analyzer?: string;        // OpenSearch analyzer
}
```
