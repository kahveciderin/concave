# Secure Query Builder

The Secure Query Builder provides a type-safe way to build queries with automatic scope enforcement.

## Overview

When you define auth scopes on a resource, all queries automatically have the scope applied. The Secure Query Builder provides additional control for complex scenarios.

## Basic Usage

```typescript
import { createSecureQueryBuilder } from "@kahveciderin/concave/resource/secure-query";

const builder = createSecureQueryBuilder({
  db,
  table: postsTable,
  user: req.user,
  scope: await config.auth.read(req.user),
});

// All queries automatically include scope filter
const posts = await builder.findMany({
  where: eq(postsTable.published, true),
  orderBy: desc(postsTable.createdAt),
  limit: 10,
});
```

## API

### `findMany(options)`

Find multiple records with scope enforcement:

```typescript
const results = await builder.findMany({
  where: and(
    eq(postsTable.status, "active"),
    gt(postsTable.createdAt, "2024-01-01"),
  ),
  orderBy: [desc(postsTable.createdAt), asc(postsTable.id)],
  limit: 20,
  offset: 0,
});
```

### `findOne(options)`

Find a single record:

```typescript
const post = await builder.findOne({
  where: eq(postsTable.id, postId),
});

if (!post) {
  throw new NotFoundError("Post not found");
}
```

### `count(options)`

Count matching records:

```typescript
const { count } = await builder.count({
  where: eq(postsTable.status, "published"),
});
```

### `aggregate(options)`

Aggregation queries:

```typescript
const stats = await builder.aggregate({
  groupBy: [postsTable.category],
  select: {
    category: postsTable.category,
    count: count(),
    avgViews: avg(postsTable.views),
  },
});
```

## Scope Enforcement

The builder always applies the user's scope, preventing unauthorized data access:

```typescript
// Even if a user tries to query other users' data
const builder = createSecureQueryBuilder({
  scope: rsql`userId=="${user.id}"`,  // Only own posts
  // ...
});

// This query is safe - scope is automatically applied
const allPosts = await builder.findMany({
  where: eq(postsTable.status, "draft"),
});
// SQL: SELECT * FROM posts WHERE status = 'draft' AND userId = 'user123'
```

## Admin Bypass

For admin operations, you can bypass scope with logging:

```typescript
const builder = createSecureQueryBuilder({
  // ...
  bypassScope: true,
  bypassReason: "Admin data export",
});

// Logs: {"level":"warn","type":"admin_scope_bypass","reason":"Admin data export",...}
```

## Mutations

The builder also provides scope-aware mutations:

```typescript
// Update - only affects records within scope
await builder.updateMany({
  where: eq(postsTable.category, "draft"),
  set: { status: "published" },
});

// Delete - only affects records within scope
await builder.deleteMany({
  where: lt(postsTable.createdAt, "2023-01-01"),
});
```

## Type Safety

The builder is fully typed based on your Drizzle schema:

```typescript
// TypeScript knows the shape of results
const posts = await builder.findMany({});
posts[0].title;  // string
posts[0].createdAt;  // string | null

// Type errors for invalid fields
posts[0].nonExistentField;  // Error!
```

## Related

- [Authentication](./authentication.md) - Auth scopes configuration
- [Resources](./resources.md) - Resource setup
- [Filtering](./filtering.md) - Filter expressions
