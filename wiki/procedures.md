# Procedures

Procedures allow you to define custom RPC endpoints and lifecycle hooks.

## RPC Procedures

Define custom endpoints on your resource:

```typescript
import { defineProcedure } from "@kahveciderin/concave/resource";
import { z } from "zod";

useResource(postsTable, {
  id: postsTable.id,
  procedures: {
    publish: defineProcedure({
      input: z.object({
        id: z.string(),
        scheduledAt: z.string().datetime().optional(),
      }),
      output: z.object({
        success: z.boolean(),
        publishedAt: z.string().datetime(),
      }),
      writeEffects: [{ type: "update", resource: "posts" }],
      handler: async (ctx, input) => {
        if (!ctx.user) {
          throw new Error("Not authenticated");
        }

        const publishedAt = input.scheduledAt ?? new Date().toISOString();

        await db.update(postsTable)
          .set({
            published: true,
            publishedAt: new Date(publishedAt)
          })
          .where(eq(postsTable.id, input.id));

        return { success: true, publishedAt };
      },
    }),
  },
});
```

Usage:

```bash
POST /posts/rpc/publish
{ "id": "post-123" }
```

## Lifecycle Hooks

Execute code before/after CRUD operations:

```typescript
useResource(postsTable, {
  id: postsTable.id,
  hooks: {
    // Before create - modify data or throw to cancel
    onBeforeCreate: async (ctx, data) => {
      return {
        ...data,
        authorId: ctx.user?.id,
        createdAt: new Date(),
      };
    },

    // After create - side effects
    onAfterCreate: async (ctx, created) => {
      await sendNotification("New post created");
      await indexForSearch(created);
    },

    // Before update - validate or modify
    onBeforeUpdate: async (ctx, id, data) => {
      return {
        ...data,
        updatedAt: new Date(),
      };
    },

    // After update
    onAfterUpdate: async (ctx, updated) => {
      await reindexForSearch(updated);
    },

    // Before delete - validation
    onBeforeDelete: async (ctx, id) => {
      const post = await db.query.posts.findFirst({ where: eq(posts.id, id) });
      if (post?.protected) {
        throw new Error("Cannot delete protected post");
      }
    },

    // After delete - cleanup
    onAfterDelete: async (ctx, deleted) => {
      await removeFromSearch(deleted.id);
      await cleanupComments(deleted.id);
    },
  },
});
```

## Composing Hooks

Combine multiple hook sets:

```typescript
import { composeHooks, createTimestampHooks } from "@kahveciderin/concave/resource";

const auditHooks = {
  onAfterCreate: async (ctx, created) => {
    await logAudit("create", ctx.user?.id, created.id);
  },
  onAfterUpdate: async (ctx, updated) => {
    await logAudit("update", ctx.user?.id, updated.id);
  },
  onAfterDelete: async (ctx, deleted) => {
    await logAudit("delete", ctx.user?.id, deleted.id);
  },
};

useResource(postsTable, {
  id: postsTable.id,
  hooks: composeHooks(
    createTimestampHooks(),  // Adds createdAt/updatedAt
    auditHooks,              // Adds audit logging
    {                        // Custom hooks
      onBeforeCreate: async (ctx, data) => {
        return { ...data, slug: slugify(data.title) };
      },
    }
  ),
});
```

## Procedure Context

The context object provides:

```typescript
interface ProcedureContext {
  db: Database;           // Database instance
  schema: Table;          // Drizzle table schema
  user: UserContext | null;  // Authenticated user
  req: Request;           // Express request
}
```

## Write Effects

Declare what resources a procedure modifies for subscription updates:

```typescript
defineProcedure({
  writeEffects: [
    { type: "create", resource: "posts" },
    { type: "update", resource: "users", ids: ["user-123"] },
    { type: "delete", resource: "comments" },
  ],
  handler: async (ctx, input) => {
    // ...
  },
});
```
