# OpenAPI Generation

Concave can automatically generate OpenAPI 3.0 specifications from your resource definitions.

## Basic Usage

```typescript
import { generateOpenAPISpec, serveOpenAPISpec } from "concave/openapi";

// Generate spec from resources
const spec = generateOpenAPISpec({
  info: {
    title: "My API",
    version: "1.0.0",
    description: "A Concave-powered API",
  },
  servers: [{ url: "https://api.example.com" }],
  resources: {
    "/posts": { schema: postsTable, config: postsConfig },
    "/users": { schema: usersTable, config: usersConfig },
  },
});

// Serve OpenAPI spec
app.use("/openapi.json", serveOpenAPISpec(spec));
```

## Generated Endpoints

For each resource, the following endpoints are documented:

| Endpoint | Description |
|----------|-------------|
| `GET /` | List items with pagination |
| `GET /:id` | Get single item |
| `POST /` | Create item |
| `PATCH /:id` | Partial update |
| `PUT /:id` | Full replace |
| `DELETE /:id` | Delete item |
| `GET /count` | Count items |
| `GET /aggregate` | Aggregation queries |
| `POST /batch` | Batch create |
| `PATCH /batch` | Batch update |
| `DELETE /batch` | Batch delete |

## Schema Generation

Schemas are automatically derived from Drizzle table definitions:

```typescript
// Drizzle schema
const postsTable = sqliteTable("posts", {
  id: integer("id").primaryKey(),
  title: text("title").notNull(),
  content: text("content"),
  published: integer("published", { mode: "boolean" }),
  createdAt: text("createdAt"),
});

// Generated OpenAPI schema
{
  "Post": {
    "type": "object",
    "required": ["id", "title"],
    "properties": {
      "id": { "type": "integer" },
      "title": { "type": "string" },
      "content": { "type": "string", "nullable": true },
      "published": { "type": "boolean" },
      "createdAt": { "type": "string" }
    }
  }
}
```

## Query Parameter Documentation

All standard query parameters are documented:

```yaml
parameters:
  - name: filter
    in: query
    schema:
      type: string
    description: Filter expression (e.g., status=="active")
  - name: select
    in: query
    schema:
      type: string
    description: Comma-separated field names to include
  - name: orderBy
    in: query
    schema:
      type: string
    description: Sort order (e.g., name:asc,createdAt:desc)
  - name: cursor
    in: query
    schema:
      type: string
    description: Pagination cursor
  - name: limit
    in: query
    schema:
      type: integer
    description: Maximum items to return
```

## Response Documentation

Standard response schemas are included:

- **List Response**: `{ items: [...], nextCursor, hasMore, totalCount }`
- **Count Response**: `{ count: number }`
- **Aggregate Response**: `{ groups: [...] }`
- **Error Response**: RFC 7807 Problem Details format

## Security Schemes

If authentication is configured, security schemes are generated:

```typescript
generateOpenAPISpec({
  // ...
  securitySchemes: {
    bearerAuth: {
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    },
    apiKey: {
      type: "apiKey",
      in: "header",
      name: "X-API-Key",
    },
  },
});
```

## Swagger UI Integration

Serve Swagger UI alongside your API:

```typescript
import swaggerUi from "swagger-ui-express";

app.use("/docs", swaggerUi.serve, swaggerUi.setup(spec));
```

## Related

- [Resources](./resources.md) - Resource configuration
- [Filtering](./filtering.md) - Filter syntax
- [Pagination](./pagination.md) - Pagination details
