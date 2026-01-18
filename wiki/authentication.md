# Authentication

Concave provides a complete authentication system built on OpenID Connect (OIDC). The framework can act as its own OIDC Provider, giving you standard OAuth2/OIDC flows, JWT tokens, and compatibility with any OIDC client.

## OIDC Provider (Recommended)

The OIDC provider gives you a complete identity server with standard endpoints, PKCE support, and pluggable authentication backends.

### Quick Setup

```typescript
import express from "express";
import { createOIDCProvider } from "@kahveciderin/concave";

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  tokens: {
    accessToken: { ttlSeconds: 3600 },
    refreshToken: { ttlSeconds: 30 * 24 * 3600, rotateOnUse: true },
  },
  clients: [
    {
      id: "web-app",
      name: "My Web App",
      redirectUris: ["https://myapp.com/callback"],
      postLogoutRedirectUris: ["https://myapp.com"],
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      tokenEndpointAuthMethod: "none", // Public client, PKCE required
      scopes: ["openid", "profile", "email", "offline_access"],
    },
  ],
  backends: {
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => {
        const user = await db.query.users.findFirst({ where: eq(users.email, email) });
        if (user && await bcrypt.compare(password, user.passwordHash)) {
          return { id: user.id, email: user.email, name: user.name };
        }
        return null;
      },
      findUserById: async (id) => {
        const user = await db.query.users.findFirst({ where: eq(users.id, id) });
        return user ? { id: user.id, email: user.email, name: user.name } : null;
      },
    },
  },
});

// Mount OIDC routes at /oidc
app.use("/oidc", router);

// Protect API routes with the middleware
app.use("/api", middleware, apiRoutes);
```

### OIDC Endpoints

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/.well-known/openid-configuration` | GET | Discovery document |
| `/authorize` | GET | Authorization code flow with PKCE |
| `/token` | POST | Token exchange, refresh |
| `/userinfo` | GET/POST | User claims |
| `/jwks` | GET | Public keys for verification |
| `/logout` | GET | End session with redirect |
| `/login` | GET/POST | Login UI (customizable) |
| `/consent` | GET/POST | Consent UI |

### Provider Configuration

```typescript
interface OIDCProviderConfig {
  // Required: Your issuer URL (must be HTTPS in production)
  issuer: string;

  // Key configuration
  keys: {
    algorithm?: "RS256" | "ES256";  // default: RS256
    privateKey?: string | Buffer;    // Or auto-generate
    rotationIntervalMs?: number;
  };

  // Token lifetimes
  tokens?: {
    accessToken?: { ttlSeconds?: number };   // default: 3600
    idToken?: { ttlSeconds?: number };       // default: 3600
    refreshToken?: {
      enabled?: boolean;
      ttlSeconds?: number;    // default: 30 days
      rotateOnUse?: boolean;  // default: true
    };
  };

  // Registered clients
  clients: OIDCClient[];

  // Authentication backends
  backends: {
    emailPassword?: EmailPasswordBackendConfig;
    federated?: FederatedProvider[];
  };

  // Store configuration (default: in-memory)
  stores?: {
    type: "memory" | "redis";
    kv?: KVAdapter;  // For Redis stores
  };

  // UI customization
  ui?: {
    loginPath?: string;     // default: /login
    consentPath?: string;   // default: /consent
    templates?: {
      login?: string;       // Custom HTML template
      consent?: string;
      error?: string;
    };
  };

  // Lifecycle hooks
  hooks?: {
    onUserAuthenticated?: (user, method) => Promise<void>;
    onTokenIssued?: (userId, clientId, scopes) => Promise<void>;
    onConsentGranted?: (userId, clientId, scopes) => Promise<void>;
    getAccessTokenClaims?: (user, client, scopes) => Promise<Record<string, unknown>>;
  };
}
```

### Federated Identity (Social Login)

Add Google, Microsoft, or other OIDC providers:

```typescript
import { createOIDCProvider, oidcProviders } from "@kahveciderin/concave";

const { router, middleware } = createOIDCProvider({
  issuer: "https://auth.myapp.com",
  keys: { algorithm: "RS256" },
  clients: [/* ... */],
  backends: {
    // Email/password for direct login
    emailPassword: {
      enabled: true,
      validateUser: async (email, password) => { /* ... */ },
      findUserById: async (id) => { /* ... */ },
    },
    // Federated providers
    federated: [
      oidcProviders.google({
        clientId: process.env.GOOGLE_CLIENT_ID!,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      }),
      oidcProviders.microsoft({
        clientId: process.env.MS_CLIENT_ID!,
        clientSecret: process.env.MS_CLIENT_SECRET!,
        tenantId: "common", // or specific tenant
      }),
      oidcProviders.generic({
        name: "custom",
        clientId: "...",
        clientSecret: "...",
        issuer: "https://custom-idp.example.com",
        scopes: ["openid", "email", "profile"],
      }),
    ],
  },
});
```

Available provider helpers: `google`, `microsoft`, `okta`, `auth0`, `keycloak`, `generic`.

## Client-Side OIDC Authentication

The Concave client library handles OIDC flows automatically with PKCE, token refresh, and 401 retry.

### Basic Setup

```typescript
import { createClient } from "@kahveciderin/concave/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

// Login - redirects to OIDC provider
await client.auth.login();

// Handle callback (on /callback page)
await client.auth.handleCallback();

// Token is automatically included in all requests
const todos = client.resource<Todo>("/todos");
const items = await todos.list();

// Check auth state
if (client.auth.isAuthenticated()) {
  const user = client.auth.getUser();
  console.log("Logged in as:", user?.name);
}

// Logout
await client.auth.logout();
```

### Subscribe to Auth State

```typescript
const unsubscribe = client.auth.subscribe((state) => {
  console.log("Auth status:", state.status);
  console.log("User:", state.user);
  console.log("Is authenticated:", state.isAuthenticated);
});

// Cleanup
unsubscribe();
```

### React Integration

```typescript
import { useState, useEffect } from "react";
import { createClient, AuthState } from "@kahveciderin/concave/client";

const client = createClient({
  baseUrl: "https://api.myapp.com",
  auth: {
    issuer: "https://auth.myapp.com/oidc",
    clientId: "web-app",
    redirectUri: window.location.origin + "/callback",
  },
});

function useAuth() {
  const [state, setState] = useState<AuthState>(client.auth.getState());

  useEffect(() => {
    return client.auth.subscribe(setState);
  }, []);

  return {
    ...state,
    login: () => client.auth.login(),
    logout: () => client.auth.logout(),
  };
}

function App() {
  const { user, isAuthenticated, status, login, logout } = useAuth();

  if (status === "initializing") return <div>Loading...</div>;

  if (!isAuthenticated) {
    return <button onClick={login}>Sign In</button>;
  }

  return (
    <div>
      Welcome, {user?.name}!
      <button onClick={logout}>Sign Out</button>
    </div>
  );
}
```

### Callback Page

```typescript
// /callback page
function CallbackPage() {
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    client.auth.handleCallback()
      .then(() => {
        window.location.href = "/";
      })
      .catch((err) => {
        setError(err.message);
      });
  }, []);

  if (error) return <div>Error: {error}</div>;
  return <div>Completing sign in...</div>;
}
```

### Token Storage Options

```typescript
import {
  createClient,
  MemoryStorage,
  LocalStorageAdapter,
  SessionStorageAdapter,
} from "@kahveciderin/concave/client";

// Memory storage (default - most secure, tokens lost on refresh)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new MemoryStorage(),
  },
});

// Local storage (persists across tabs/sessions)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new LocalStorageAdapter("myapp_"),
  },
});

// Session storage (persists until tab close)
const client = createClient({
  baseUrl: "...",
  auth: {
    // ...
    storage: new SessionStorageAdapter("myapp_"),
  },
});
```

### Auth Configuration Options

```typescript
interface OIDCClientConfig {
  // Required
  issuer: string;           // OIDC provider URL
  clientId: string;         // Client ID
  redirectUri: string;      // Callback URL

  // Optional
  postLogoutRedirectUri?: string;  // Where to redirect after logout
  scopes?: string[];               // default: ["openid", "profile", "email"]
  autoRefresh?: boolean;           // default: true
  refreshBufferSeconds?: number;   // default: 60 (refresh 60s before expiry)
  storage?: TokenStorage;          // default: MemoryStorage
  flowType?: "redirect" | "popup"; // default: "redirect"
}
```

---

## Session-Based Authentication (Legacy)

For traditional session-based auth without OIDC, use the original `useAuth` function.

## Quick Setup

The `useAuth` function creates auth routes and middleware in one call:

```typescript
import express from "express";
import cookieParser from "cookie-parser";
import { createPassportAdapter, useAuth } from "@kahveciderin/concave";

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
import { createPassportAdapter } from "@kahveciderin/concave";

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
import { createAuthJsAdapter } from "@kahveciderin/concave";

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
import { useResource, rsql } from "@kahveciderin/concave";

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
import { scopePatterns } from "@kahveciderin/concave";

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
import { rsql, eq, ne, gt, gte, lt, lte, inList, and, or } from "@kahveciderin/concave";

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
import { requireAuth, requireRole, requirePermission } from "@kahveciderin/concave";

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
import { getOrCreateClient } from "@kahveciderin/concave/client";
import { useAuth } from "@kahveciderin/concave/client/react";

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
import { createPassportAdapter, createAuthMiddleware } from "@kahveciderin/concave";

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
import { InMemorySessionStore } from "@kahveciderin/concave";

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
