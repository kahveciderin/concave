# Authentication

Concave supports pluggable authentication with adapters for Auth.js and Passport.js.

## Quick Setup

### Passport.js Adapter

```typescript
import { createPassportAdapter, createAuthMiddleware } from "concave/auth";

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    return db.query.users.findFirst({ where: eq(users.id, id) });
  },
  validatePassword: async (email, password) => {
    const user = await db.query.users.findFirst({
      where: eq(users.email, email)
    });
    if (user && await bcrypt.compare(password, user.passwordHash)) {
      return user;
    }
    return null;
  },
});

app.use(createAuthMiddleware(authAdapter));
app.use("/auth", authAdapter.getRoutes());
```

### Auth.js Adapter

```typescript
import { createAuthJsAdapter, createAuthMiddleware } from "concave/auth";

const authAdapter = createAuthJsAdapter({
  db,
  tables: {
    users: authUsersTable,
    sessions: authSessionsTable,
    accounts: authAccountsTable,
  },
});

app.use(createAuthMiddleware(authAdapter));
```

## Authorization Scopes

Use the `rsql` template helper to define scopes:

```typescript
import { rsql, eq, or } from "concave/auth";

useResource(postsTable, {
  id: postsTable.id,
  auth: {
    // Public read access
    public: { read: true },

    // Users can only update their own posts
    update: async (user) => rsql`authorId=="${user.id}"`,

    // Users can delete their own posts or be an admin
    delete: async (user) => {
      if (user.metadata?.role === "admin") {
        return rsql`*`;  // All posts
      }
      return rsql`authorId=="${user.id}"`;
    },
  },
});
```

## Scope Patterns

Common patterns are available:

```typescript
import { scopePatterns } from "concave/auth";

// Owner-only access
auth: scopePatterns.ownerOnly("userId"),

// Public read, owner write
auth: scopePatterns.publicReadOwnerWrite("userId"),

// Owner or admin access
auth: scopePatterns.ownerOrAdmin("userId", (user) => user.metadata?.role === "admin"),

// Organization-based access
auth: scopePatterns.orgBased("organizationId"),
```

## RSQL Helpers

```typescript
import { rsql, eq, ne, gt, gte, lt, lte, inList, and, or } from "concave/auth";

// Basic equality
const scope = eq("userId", user.id);

// Multiple conditions
const scope = and(
  eq("status", "active"),
  eq("organizationId", user.orgId)
);

// OR conditions
const scope = or(
  eq("userId", user.id),
  eq("public", true)
);

// Template syntax
const scope = rsql`userId=="${user.id}";status=="active"`;
```

## Middleware

```typescript
import { requireAuth, requireRole, requirePermission } from "concave/auth";

// Require authentication
app.get("/profile", requireAuth(), (req, res) => {
  res.json(req.user);
});

// Require specific role
app.get("/admin", requireRole("admin"), (req, res) => {
  res.json({ message: "Admin area" });
});

// Require specific permission
app.post("/posts", requirePermission("posts:create"), (req, res) => {
  // ...
});
```

## Session Management

```typescript
// Get session
GET /auth/session

// Login (Passport adapter)
POST /auth/login
{ "username": "user@example.com", "password": "secret" }

// Logout
POST /auth/logout
```
