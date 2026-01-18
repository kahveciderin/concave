# Relations & Joins

Concave supports defining relationships between resources and loading related data efficiently with batch loading to prevent N+1 queries.

## Relation Types

| Type | Description | Example |
|------|-------------|---------|
| `belongsTo` | Foreign key on this table | A post belongs to a user |
| `hasOne` | Foreign key on related table (one-to-one) | A user has one profile |
| `hasMany` | Foreign key on related table (one-to-many) | A user has many posts |
| `manyToMany` | Junction table | A post has many tags |

## Defining Relations

```typescript
import { useResource } from "@kahveciderin/concave";

app.use("/api/posts", useResource(postsTable, {
  db,
  id: postsTable.id,
  relations: {
    // Post belongs to author (user)
    author: {
      resource: "users",
      schema: usersTable,
      type: "belongsTo",
      foreignKey: postsTable.authorId,
      references: usersTable.id,
      defaultSelect: ["id", "name", "avatar"], // Limit fields returned
    },

    // Post has many comments
    comments: {
      resource: "comments",
      schema: commentsTable,
      type: "hasMany",
      foreignKey: commentsTable.postId,
      references: postsTable.id,
    },

    // Post belongs to category (optional)
    category: {
      resource: "categories",
      schema: categoriesTable,
      type: "belongsTo",
      foreignKey: postsTable.categoryId,
      references: categoriesTable.id,
    },

    // Post has many tags (many-to-many)
    tags: {
      resource: "tags",
      schema: tagsTable,
      type: "manyToMany",
      foreignKey: postsTable.id,
      references: tagsTable.id,
      through: {
        schema: postTagsTable,
        sourceKey: postTagsTable.postId,
        targetKey: postTagsTable.tagId,
      },
    },
  },
}));
```

## Including Relations in Queries

Use the `include` query parameter to load related data:

```bash
# Include single relation
GET /api/posts?include=author

# Include multiple relations
GET /api/posts?include=author,category,tags

# Nested includes (author with their profile)
GET /api/posts?include=author.profile

# Include with options
GET /api/posts?include=comments(limit:5;select:id,text,createdAt)
```

### Include Options

| Option | Description | Example |
|--------|-------------|---------|
| `limit` | Maximum items to load | `comments(limit:10)` |
| `select` | Fields to include | `author(select:id,name)` |
| `filter` | Filter related items | `comments(filter:status=="approved")` |

### Examples

```typescript
// Client-side
const posts = client.resource<Post>("/posts");

// Get posts with author
const result = await posts.list({
  include: "author"
});
// Returns: { items: [{ id: "1", title: "...", author: { id: "u1", name: "John" } }] }

// Get posts with comments (limited)
const result = await posts.list({
  include: "comments(limit:3)"
});

// Get single post with all relations
const post = await posts.get("post-1", {
  include: "author,category,tags"
});
```

## Relation Configuration

```typescript
interface RelationConfig {
  // Required
  resource: string;                // Resource name (for nested loading)
  schema: Table;                   // Drizzle table
  type: RelationType;              // "belongsTo" | "hasOne" | "hasMany" | "manyToMany"
  foreignKey: AnyColumn;           // Foreign key column
  references: AnyColumn;           // Referenced column

  // For manyToMany
  through?: {
    schema: Table;                 // Junction table
    sourceKey: AnyColumn;          // Column pointing to source
    targetKey: AnyColumn;          // Column pointing to target
  };

  // Optional
  defaultSelect?: string[];        // Default fields to load
  filterable?: boolean;            // Allow filtering on this relation
  subscribeToChanges?: boolean;    // Include in subscription events
}
```

## Include Configuration

Configure include behavior at the resource level:

```typescript
app.use("/api/posts", useResource(postsTable, {
  db,
  id: postsTable.id,
  relations: { /* ... */ },
  include: {
    maxDepth: 3,           // Maximum nesting depth (default: 3)
    defaultLimit: 100,     // Default limit for hasMany (default: none)
    allowNestedFilters: true,  // Allow filters on nested relations
  },
}));
```

## Subscriptions with Relations

Includes work with real-time subscriptions too:

```typescript
const subscription = posts.subscribe(
  { filter: 'status=="published"', include: "author,tags" },
  {
    onAdded: (post) => {
      console.log("New post by:", post.author.name);
      console.log("Tags:", post.tags.map(t => t.name).join(", "));
    },
    onChanged: (post) => {
      // Related data is included in change events
    },
  }
);
```

## Batch Loading

Concave automatically batches relation loading to prevent N+1 queries:

```typescript
// Instead of:
// SELECT * FROM posts WHERE ...
// SELECT * FROM users WHERE id = $1  (for each post)
// SELECT * FROM users WHERE id = $2
// ...

// Concave executes:
// SELECT * FROM posts WHERE ...
// SELECT * FROM users WHERE id IN ($1, $2, $3, ...)  (one query for all)
```

## Many-to-Many Example

```typescript
// Schema
const postsTable = sqliteTable("posts", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
});

const tagsTable = sqliteTable("tags", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

const postTagsTable = sqliteTable("postTags", {
  postId: text("postId").references(() => postsTable.id),
  tagId: text("tagId").references(() => tagsTable.id),
});

// Resource configuration
app.use("/api/posts", useResource(postsTable, {
  db,
  id: postsTable.id,
  relations: {
    tags: {
      resource: "tags",
      schema: tagsTable,
      type: "manyToMany",
      foreignKey: postsTable.id,
      references: tagsTable.id,
      through: {
        schema: postTagsTable,
        sourceKey: postTagsTable.postId,
        targetKey: postTagsTable.tagId,
      },
    },
  },
}));

// Query
// GET /api/posts?include=tags
// Returns: { items: [{ id: "1", title: "...", tags: [{ id: "t1", name: "TypeScript" }] }] }
```

## Nested Relations

Load deeply nested data:

```typescript
// Define relations
// posts -> author (user) -> profile
// posts -> comments -> author (user)

app.use("/api/users", useResource(usersTable, {
  db,
  id: usersTable.id,
  relations: {
    profile: {
      resource: "profiles",
      schema: profilesTable,
      type: "hasOne",
      foreignKey: profilesTable.userId,
      references: usersTable.id,
    },
  },
}));

// Query nested relations
// GET /api/posts?include=author.profile,comments.author
```

## Filtering on Relations

Filter parent records based on related data:

```typescript
// Posts that have a tag named "TypeScript"
GET /api/posts?filter=tags.name=="TypeScript"

// Posts by authors in a specific organization
GET /api/posts?filter=author.organizationId=="org-123"
```

Note: Filtering on relations requires `filterable: true` in the relation config and may use subqueries which can impact performance on large datasets.

## TypeScript Types

```typescript
import { RelationType, RelationConfig, IncludeSpec, IncludeConfig } from "@kahveciderin/concave";

// RelationType
type RelationType = "belongsTo" | "hasOne" | "hasMany" | "manyToMany";

// IncludeSpec (parsed from query string)
interface IncludeSpec {
  relation: string;
  select?: string[];
  filter?: string;
  limit?: number;
  nested?: IncludeSpec[];
}
```
