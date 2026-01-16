# Authentication

Concave provides a complete authentication system with standard routes, session management, and authorization scopes.

## Quick Setup

The `useAuth` function creates auth routes and middleware in one call:

```typescript
import express from "express";
import cookieParser from "cookie-parser";
import { createPassportAdapter, useAuth } from "concave";

const app = express();
app.use(express.json());
app.use(cookieParser());

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    return db.query.users.findFirst({ where: eq(users.id, id) });
  },
});

const { router, middleware } = useAuth({
  adapter: authAdapter,
  login: {
    validateCredentials: async (email, password) => {
      const user = await db.query.users.findFirst({ where: eq(users.email, email) });
      if (user && await bcrypt.compare(password, user.passwordHash)) {
        return { id: user.id, email: user.email, name: user.name };
      }
      return null;
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const id = crypto.randomUUID();
      const [user] = await db.insert(users).values({
        id,
        email,
        name,
        passwordHash: await bcrypt.hash(password, 10),
      }).returning();
      return { id: user.id, email: user.email, name: user.name };
    },
  },
});

// Mount auth routes at /api/auth
app.use("/api/auth", router);

// Add auth middleware to populate req.user
app.use(middleware);
```

This creates the following routes:

| Route | Method | Description |
|-------|--------|-------------|
| `/api/auth/me` | GET | Returns current user or `{ user: null }` |
| `/api/auth/login` | POST | Login with email/password |
| `/api/auth/signup` | POST | Create new account |
| `/api/auth/logout` | POST | Clear session |

## useAuth Options

```typescript
interface UseAuthOptions {
  // Required: auth adapter for session management
  adapter: AuthAdapter;

  // Optional: cookie configuration
  cookieName?: string;  // default: "session"
  cookieOptions?: {
    httpOnly?: boolean;   // default: true
    secure?: boolean;     // default: true in production
    sameSite?: "strict" | "lax" | "none";  // default: "lax"
    maxAge?: number;      // default: 7 days
  };

  // Optional: enable login route
  login?: {
    validateCredentials: (email: string, password: string) => Promise<AuthUser | null>;
  };

  // Optional: enable signup route
  signup?: {
    createUser: (data: { email: string; password: string; name?: string }) => Promise<AuthUser>;
    validateEmail?: (email: string) => boolean | Promise<boolean>;
    validatePassword?: (password: string) => boolean | Promise<boolean>;
  };

  // Optional: customize user serialization
  serializeUser?: (user: UserContext) => Record<string, unknown>;

  // Optional: lifecycle hooks
  onLogin?: (user: UserContext, req: Request) => void | Promise<void>;
  onLogout?: (user: UserContext | null, req: Request) => void | Promise<void>;
  onSignup?: (user: AuthUser, req: Request) => void | Promise<void>;
}
```

## Auth Adapters

### Passport Adapter

For custom username/password authentication:

```typescript
import { createPassportAdapter } from "concave";

const authAdapter = createPassportAdapter({
  // Required: lookup user by ID
  getUserById: async (id) => {
    const user = await db.query.users.findFirst({ where: eq(users.id, id) });
    return user ?? null;
  },

  // Optional: custom session store (default: in-memory)
  sessionStore: myRedisStore,

  // Optional: session TTL (default: 24 hours)
  sessionTtlMs: 7 * 24 * 60 * 60 * 1000,

  // Optional: API key validation
  validateApiKey: async (apiKey) => {
    const key = await db.query.apiKeys.findFirst({ where: eq(apiKeys.key, apiKey) });
    return key ? { userId: key.userId, scopes: key.scopes } : null;
  },
});
```

### Auth.js Adapter

For integration with Auth.js/NextAuth.js:

```typescript
import { createAuthJsAdapter } from "concave";

const authAdapter = createAuthJsAdapter({
  db,
  tables: {
    users: authUsersTable,
    sessions: authSessionsTable,
    accounts: authAccountsTable,  // optional
  },
});
```

## Authorization Scopes

Use the `rsql` template helper to define row-level access control:

```typescript
import { useResource, rsql } from "concave";

app.use("/api/posts", useResource(postsTable, {
  id: postsTable.id,
  db,
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

    // Subscription scope
    subscribe: async (user) => rsql`authorId=="${user.id}"`,
  },
}));
```

## Scope Patterns

Common patterns are available as presets:

```typescript
import { scopePatterns } from "concave";

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

Build scopes programmatically:

```typescript
import { rsql, eq, ne, gt, gte, lt, lte, inList, and, or } from "concave";

// Basic equality
const scope = eq("userId", user.id);

// Multiple conditions (AND)
const scope = and(
  eq("status", "active"),
  eq("organizationId", user.orgId)
);

// OR conditions
const scope = or(
  eq("userId", user.id),
  eq("public", true)
);

// Template syntax (same result)
const scope = rsql`userId=="${user.id}";status=="active"`;
```

## Middleware

Additional middleware helpers:

```typescript
import { requireAuth, requireRole, requirePermission } from "concave";

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

## Client-Side Authentication

### useAuth Hook

The `useAuth` hook provides authentication state in React:

```typescript
import { getOrCreateClient } from "concave/client";
import { useAuth } from "concave/client/react";

const client = getOrCreateClient({
  baseUrl: location.origin,
  credentials: "include",
});

interface User {
  id: string;
  name: string;
  email: string;
}

function App() {
  const { user, isAuthenticated, isLoading, logout } = useAuth<User>();

  // Set global auth error handler
  useEffect(() => {
    client.setAuthErrorHandler(logout);
  }, [logout]);

  if (isLoading) return <div>Loading...</div>;
  if (!isAuthenticated) return <LoginPage />;

  return (
    <div>
      <p>Welcome, {user?.name}!</p>
      <button onClick={logout}>Sign out</button>
    </div>
  );
}
```

### Login Form Example

```typescript
function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");

  const handleLogin = async (e: FormEvent) => {
    e.preventDefault();
    setError("");

    const response = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });

    if (response.ok) {
      window.location.reload();
    } else {
      const data = await response.json();
      setError(data.error?.message ?? "Login failed");
    }
  };

  return (
    <form onSubmit={handleLogin}>
      <input
        type="email"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="Email"
      />
      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Password"
      />
      {error && <p className="error">{error}</p>}
      <button type="submit">Login</button>
    </form>
  );
}
```

### JWT Authentication

For token-based auth instead of cookies:

```typescript
// Set bearer token after login
client.setAuthToken("your-jwt-token");

// Clear token on logout
client.clearAuthToken();
```

## API Endpoints

### GET /api/auth/me

Returns the current authenticated user or null.

**Response:**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "expiresAt": "2024-01-15T00:00:00.000Z"
}
```

Or when not authenticated:
```json
{
  "user": null
}
```

### POST /api/auth/login

Authenticates a user with email and password.

**Request:**
```json
{
  "email": "user@example.com",
  "password": "secret123"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_123",
    "email": "user@example.com",
    "name": "John Doe"
  },
  "sessionId": "sess_abc123"
}
```

### POST /api/auth/signup

Creates a new user account.

**Request:**
```json
{
  "email": "newuser@example.com",
  "password": "secret123",
  "name": "Jane Doe"
}
```

**Response:**
```json
{
  "user": {
    "id": "user_456",
    "email": "newuser@example.com",
    "name": "Jane Doe"
  }
}
```

### POST /api/auth/logout

Clears the session and logs out the user.

**Response:**
```json
{
  "success": true
}
```

## Advanced: Custom Routes

If you need more control, you can use the adapter's routes directly:

```typescript
import { createPassportAdapter, createAuthMiddleware } from "concave";

const authAdapter = createPassportAdapter({
  getUserById: async (id) => db.query.users.findFirst({ where: eq(users.id, id) }),
  validatePassword: async (email, password) => {
    // Custom validation logic
  },
});

// Use adapter's built-in routes
app.use("/auth", authAdapter.getRoutes());

// Or create custom routes
app.post("/custom-login", async (req, res) => {
  const { email, password } = req.body;
  // Custom login logic using adapter
  const session = await authAdapter.createSession(userId);
  res.cookie("session", session.id, { httpOnly: true });
  res.json({ success: true });
});
```

## Session Stores

### In-Memory (Default)

Good for development. Sessions are lost on server restart.

```typescript
import { InMemorySessionStore } from "concave";

const authAdapter = createPassportAdapter({
  sessionStore: new InMemorySessionStore(),
  // ...
});
```

### Redis

For production with multiple servers:

```typescript
import { createRedisSessionStore } from "your-redis-adapter";

const authAdapter = createPassportAdapter({
  sessionStore: createRedisSessionStore({
    url: process.env.REDIS_URL,
    prefix: "session:",
  }),
  // ...
});
```

The session store interface:

```typescript
interface SessionStore {
  get(sessionId: string): Promise<SessionData | null>;
  set(sessionId: string, data: SessionData, ttlMs: number): Promise<void>;
  delete(sessionId: string): Promise<void>;
  touch(sessionId: string, ttlMs: number): Promise<void>;
  getAll?(): Promise<SessionData[]>;  // Optional, for admin UI
}
```
