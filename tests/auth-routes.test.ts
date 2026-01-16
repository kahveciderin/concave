import { describe, it, expect, beforeEach, vi } from "vitest";
import express, { Express, Request, Response, NextFunction } from "express";
import cookieParser from "cookie-parser";
import request from "supertest";
import { useAuth, AuthUser, UseAuthOptions } from "@/auth/routes";
import { createPassportAdapter, PassportAdapter } from "@/auth/adapters/passport";
import { InMemorySessionStore } from "@/auth/types";

const errorHandler = (err: any, _req: Request, res: Response, _next: NextFunction) => {
  const status = err.statusCode || err.status || 500;
  res.status(status).json({
    error: {
      message: err.message,
      code: err.code || "INTERNAL_ERROR",
    },
  });
};

describe("Auth Routes (useAuth)", () => {
  let app: Express;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let mockUsers: Map<string, AuthUser & { passwordHash: string }>;

  const createTestUser = (id: string, email: string, password: string, name: string) => ({
    id,
    email,
    name,
    passwordHash: password,
  });

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("user-1", createTestUser("user-1", "test@example.com", "password123", "Test User"));

    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const user = mockUsers.get(id);
        if (!user) return null;
        return { id: user.id, email: user.email, name: user.name, image: null };
      },
      sessionStore,
    });
  });

  describe("GET /me", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);
    });

    it("should return null when not authenticated", async () => {
      const res = await request(app).get("/api/auth/me");

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return user when authenticated via session cookie", async () => {
      const session = await authAdapter.createSession("user-1");

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${session.id}`);

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.id).toBe("user-1");
      expect(res.body.user.email).toBe("test@example.com");
      expect(res.body.expiresAt).toBeDefined();
    });

    it("should return null for expired session", async () => {
      const session = await authAdapter.createSession("user-1");
      await authAdapter.invalidateSession(session.id);

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${session.id}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return null for invalid session ID", async () => {
      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", "session=invalid-session-id");

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });

    it("should return null when user no longer exists", async () => {
      const session = await authAdapter.createSession("user-1");
      mockUsers.delete("user-1");

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${session.id}`);

      expect(res.status).toBe(200);
      expect(res.body.user).toBeNull();
    });
  });

  describe("POST /login", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        login: {
          validateCredentials: async (email, password) => {
            for (const user of mockUsers.values()) {
              if (user.email === email && user.passwordHash === password) {
                return { id: user.id, email: user.email, name: user.name };
              }
            }
            return null;
          },
        },
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);
    });

    it("should login with valid credentials and set session cookie", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com", password: "password123" });

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.id).toBe("user-1");
      expect(res.body.sessionId).toBeDefined();

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.startsWith("session="))).toBe(true);
    });

    it("should reject login with invalid email", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "wrong@example.com", password: "password123" });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain("Invalid");
    });

    it("should reject login with invalid password", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com", password: "wrongpassword" });

      expect(res.status).toBe(401);
      expect(res.body.error.message).toContain("Invalid");
    });

    it("should reject login with missing email", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ password: "password123" });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("required");
    });

    it("should reject login with missing password", async () => {
      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("required");
    });

    it("should allow authenticated request after login using session cookie", async () => {
      const loginRes = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com", password: "password123" });

      const sessionCookie = loginRes.headers["set-cookie"]
        .find((c: string) => c.startsWith("session="));

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).not.toBeNull();
      expect(meRes.body.user.id).toBe("user-1");
    });
  });

  describe("POST /signup", () => {
    let userIdCounter = 10;

    beforeEach(() => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        signup: {
          createUser: async ({ email, password, name }) => {
            const id = `user-${userIdCounter++}`;
            const newUser = createTestUser(id, email, password, name ?? "New User");
            mockUsers.set(id, newUser);
            return { id, email, name: name ?? "New User" };
          },
          validateEmail: (email) => email.includes("@"),
          validatePassword: (password) => password.length >= 6,
        },
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);
    });

    it("should create user and set session cookie", async () => {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: "new@example.com", password: "newpassword123", name: "New User" });

      expect(res.status).toBe(200);
      expect(res.body.user).not.toBeNull();
      expect(res.body.user.email).toBe("new@example.com");

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      expect(cookies.some((c: string) => c.startsWith("session="))).toBe(true);
    });

    it("should reject signup with invalid email", async () => {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: "invalidemail", password: "password123" });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("email");
    });

    it("should reject signup with weak password", async () => {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: "new@example.com", password: "123" });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("Password");
    });

    it("should reject signup with missing fields", async () => {
      const res = await request(app)
        .post("/api/auth/signup")
        .send({ email: "new@example.com" });

      expect(res.status).toBe(400);
      expect(res.body.error.message).toContain("required");
    });

    it("should allow authenticated request after signup using session cookie", async () => {
      const signupRes = await request(app)
        .post("/api/auth/signup")
        .send({ email: "new@example.com", password: "newpassword123", name: "New User" });

      const sessionCookie = signupRes.headers["set-cookie"]
        .find((c: string) => c.startsWith("session="));

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", sessionCookie);

      expect(meRes.status).toBe(200);
      expect(meRes.body.user).not.toBeNull();
      expect(meRes.body.user.email).toBe("new@example.com");
    });
  });

  describe("POST /logout", () => {
    beforeEach(() => {
      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);
    });

    it("should clear session and return success", async () => {
      const session = await authAdapter.createSession("user-1");

      const res = await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${session.id}`);

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);

      const cookies = res.headers["set-cookie"];
      expect(cookies).toBeDefined();
      const sessionCookie = cookies.find((c: string) => c.startsWith("session="));
      expect(sessionCookie).toMatch(/Expires=Thu, 01 Jan 1970|Max-Age=0/);
    });

    it("should invalidate session so subsequent requests fail", async () => {
      const session = await authAdapter.createSession("user-1");

      await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${session.id}`);

      const meRes = await request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${session.id}`);

      expect(meRes.body.user).toBeNull();
    });

    it("should succeed even when not authenticated", async () => {
      const res = await request(app)
        .post("/api/auth/logout");

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  describe("Lifecycle hooks", () => {
    it("should call onLogin hook after successful login", async () => {
      const onLogin = vi.fn();

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        login: {
          validateCredentials: async (email, password) => {
            const user = mockUsers.get("user-1");
            if (user && user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
            return null;
          },
        },
        onLogin,
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);

      await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com", password: "password123" });

      expect(onLogin).toHaveBeenCalledTimes(1);
      expect(onLogin.mock.calls[0][0].id).toBe("user-1");
    });

    it("should call onLogout hook after logout", async () => {
      const onLogout = vi.fn();

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        onLogout,
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);

      const session = await authAdapter.createSession("user-1");

      await request(app)
        .post("/api/auth/logout")
        .set("Cookie", `session=${session.id}`);

      expect(onLogout).toHaveBeenCalledTimes(1);
      expect(onLogout.mock.calls[0][0]?.id).toBe("user-1");
    });

    it("should call onSignup hook after successful signup", async () => {
      const onSignup = vi.fn();
      let userIdCounter = 20;

      const { router, middleware } = useAuth({
        adapter: authAdapter,
        signup: {
          createUser: async ({ email, password, name }) => {
            const id = `user-${userIdCounter++}`;
            mockUsers.set(id, createTestUser(id, email, password, name ?? "New User"));
            return { id, email, name: name ?? "New User" };
          },
        },
        onSignup,
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);

      await request(app)
        .post("/api/auth/signup")
        .send({ email: "hook@example.com", password: "password123", name: "Hook User" });

      expect(onSignup).toHaveBeenCalledTimes(1);
      expect(onSignup.mock.calls[0][0].email).toBe("hook@example.com");
    });
  });

  describe("Custom cookie configuration", () => {
    it("should use custom cookie name", async () => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        cookieName: "auth_session",
        login: {
          validateCredentials: async (email, password) => {
            const user = mockUsers.get("user-1");
            if (user && user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
            return null;
          },
        },
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);

      const res = await request(app)
        .post("/api/auth/login")
        .send({ email: "test@example.com", password: "password123" });

      const cookies = res.headers["set-cookie"];
      expect(cookies.some((c: string) => c.startsWith("auth_session="))).toBe(true);
    });
  });

  describe("Custom user serialization", () => {
    it("should use custom serializeUser function", async () => {
      const { router, middleware } = useAuth({
        adapter: authAdapter,
        serializeUser: (user) => ({
          userId: user.id,
          displayName: user.name,
        }),
      });
      app.use("/api/auth", router);
      app.use(middleware);
      app.use(errorHandler);

      const session = await authAdapter.createSession("user-1");

      const res = await request(app)
        .get("/api/auth/me")
        .set("Cookie", `session=${session.id}`);

      expect(res.body.user.userId).toBe("user-1");
      expect(res.body.user.displayName).toBe("Test User");
      expect(res.body.user.id).toBeUndefined();
    });
  });

  describe("Middleware integration", () => {
    it("should populate req.user on authenticated requests", async () => {
      let capturedUser: any = null;

      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.use("/api/auth", router);
      app.use(middleware);
      app.get("/test", (req, res) => {
        capturedUser = req.user;
        res.json({ hasUser: !!req.user });
      });
      app.use(errorHandler);

      const session = await authAdapter.createSession("user-1");

      await request(app)
        .get("/test")
        .set("Cookie", `session=${session.id}`);

      expect(capturedUser).not.toBeNull();
      expect(capturedUser.id).toBe("user-1");
    });

    it("should set req.user to null on unauthenticated requests", async () => {
      let capturedUser: any = "not-called";

      const { router, middleware } = useAuth({ adapter: authAdapter });
      app.use("/api/auth", router);
      app.use(middleware);
      app.get("/test", (req, res) => {
        capturedUser = req.user;
        res.json({ hasUser: !!req.user });
      });
      app.use(errorHandler);

      await request(app).get("/test");

      expect(capturedUser).toBeNull();
    });
  });
});

describe("PassportAdapter Credential Extraction", () => {
  let adapter: PassportAdapter;
  let sessionStore: InMemorySessionStore;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
    adapter = createPassportAdapter({
      getUserById: async () => null,
      sessionStore,
    });
  });

  const createMockRequest = (overrides: Partial<Request> = {}): Request => {
    return {
      headers: {},
      cookies: {},
      isAuthenticated: () => false,
      user: undefined,
      session: undefined,
      sessionID: undefined,
      ...overrides,
    } as unknown as Request;
  };

  describe("Session Cookie Extraction", () => {
    it("should extract credentials from 'session' cookie", () => {
      const req = createMockRequest({
        cookies: { session: "my-session-id" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("my-session-id");
    });

    it("should extract credentials from 'connect.sid' cookie with passport data", () => {
      const req = createMockRequest({
        cookies: { "connect.sid": "passport-session-id" },
        session: { passport: { user: "user-123" } },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("passport-session-id");
    });

    it("should prioritize passport isAuthenticated() over session cookie", () => {
      const req = createMockRequest({
        cookies: { session: "my-session-id" },
        isAuthenticated: () => true,
        user: { id: "passport-user" },
        session: { id: "passport-session-id" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("passport-session-id");
    });
  });

  describe("Bearer Token Extraction", () => {
    it("should extract credentials from Authorization Bearer header", () => {
      const req = createMockRequest({
        headers: { authorization: "Bearer my-jwt-token" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("bearer");
      expect(credentials?.token).toBe("my-jwt-token");
    });

    it("should not extract bearer when Authorization header has different scheme", () => {
      const req = createMockRequest({
        headers: { authorization: "Digest something" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).toBeNull();
    });
  });

  describe("Basic Auth Extraction", () => {
    it("should extract credentials from Authorization Basic header", () => {
      const encoded = Buffer.from("user:pass").toString("base64");
      const req = createMockRequest({
        headers: { authorization: `Basic ${encoded}` },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("basic");
      expect(credentials?.username).toBe("user");
      expect(credentials?.password).toBe("pass");
    });
  });

  describe("API Key Extraction", () => {
    it("should extract credentials from X-API-Key header", () => {
      const req = createMockRequest({
        headers: { "x-api-key": "my-api-key" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).not.toBeNull();
      expect(credentials?.type).toBe("apiKey");
      expect(credentials?.apiKey).toBe("my-api-key");
    });
  });

  describe("No Credentials", () => {
    it("should return null when no credentials present", () => {
      const req = createMockRequest();

      const credentials = adapter.extractCredentials(req);

      expect(credentials).toBeNull();
    });

    it("should return null for empty cookies and headers", () => {
      const req = createMockRequest({
        headers: {},
        cookies: {},
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials).toBeNull();
    });
  });

  describe("Priority Order", () => {
    it("should prioritize session cookie over bearer token", () => {
      const req = createMockRequest({
        cookies: { session: "session-id" },
        headers: { authorization: "Bearer jwt-token" },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials?.type).toBe("session");
      expect(credentials?.sessionId).toBe("session-id");
    });

    it("should prioritize bearer token over API key when no session", () => {
      const req = createMockRequest({
        headers: {
          authorization: "Bearer jwt-token",
          "x-api-key": "api-key",
        },
      });

      const credentials = adapter.extractCredentials(req);

      expect(credentials?.type).toBe("bearer");
      expect(credentials?.token).toBe("jwt-token");
    });
  });
});

describe("PassportAdapter Session Validation", () => {
  let adapter: PassportAdapter;
  let sessionStore: InMemorySessionStore;
  let mockUsers: Map<string, any>;

  beforeEach(() => {
    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("user-1", { id: "user-1", email: "test@example.com", name: "Test User" });

    adapter = createPassportAdapter({
      getUserById: async (id) => mockUsers.get(id) ?? null,
      sessionStore,
    });
  });

  it("should validate session credentials and return user context", async () => {
    const session = await adapter.createSession("user-1");

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(true);
    expect(result.user).not.toBeNull();
    expect(result.user?.id).toBe("user-1");
    expect(result.expiresAt).toBeDefined();
  });

  it("should reject invalid session ID", async () => {
    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: "non-existent-session",
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not found");
  });

  it("should reject session for deleted user", async () => {
    const session = await adapter.createSession("user-1");
    mockUsers.delete("user-1");

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("User not found");
  });

  it("should reject invalidated session", async () => {
    const session = await adapter.createSession("user-1");
    await adapter.invalidateSession(session.id);

    const result = await adapter.validateCredentials({
      type: "session",
      sessionId: session.id,
    });

    expect(result.success).toBe(false);
  });
});

describe("End-to-end Auth Flow", () => {
  let app: Express;
  let sessionStore: InMemorySessionStore;
  let authAdapter: PassportAdapter;
  let mockUsers: Map<string, any>;
  let userIdCounter = 100;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use(cookieParser());

    sessionStore = new InMemorySessionStore();
    mockUsers = new Map();
    mockUsers.set("existing-user", {
      id: "existing-user",
      email: "existing@example.com",
      name: "Existing User",
      passwordHash: "existing-password",
    });

    authAdapter = createPassportAdapter({
      getUserById: async (id) => {
        const user = mockUsers.get(id);
        if (!user) return null;
        return { id: user.id, email: user.email, name: user.name, image: null };
      },
      sessionStore,
    });

    const { router, middleware } = useAuth({
      adapter: authAdapter,
      login: {
        validateCredentials: async (email, password) => {
          for (const user of mockUsers.values()) {
            if (user.email === email && user.passwordHash === password) {
              return { id: user.id, email: user.email, name: user.name };
            }
          }
          return null;
        },
      },
      signup: {
        createUser: async ({ email, password, name }) => {
          const id = `user-${userIdCounter++}`;
          mockUsers.set(id, { id, email, name: name ?? "New User", passwordHash: password });
          return { id, email, name: name ?? "New User" };
        },
      },
    });

    app.use("/api/auth", router);
    app.use(middleware);

    app.get("/protected", (req, res) => {
      if (!req.user) {
        return res.status(401).json({ error: "Unauthorized" });
      }
      res.json({ message: "Protected content", user: req.user });
    });

    app.use(errorHandler);
  });

  it("should complete full signup -> access -> logout -> denied flow", async () => {
    const signupRes = await request(app)
      .post("/api/auth/signup")
      .send({ email: "e2e@example.com", password: "e2epassword", name: "E2E User" });

    expect(signupRes.status).toBe(200);
    const sessionCookie = signupRes.headers["set-cookie"]
      .find((c: string) => c.startsWith("session="));

    const protectedRes = await request(app)
      .get("/protected")
      .set("Cookie", sessionCookie);

    expect(protectedRes.status).toBe(200);
    expect(protectedRes.body.user.email).toBe("e2e@example.com");

    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", sessionCookie);

    const deniedRes = await request(app)
      .get("/protected")
      .set("Cookie", sessionCookie);

    expect(deniedRes.status).toBe(401);
  });

  it("should complete full login -> me -> logout -> me(null) flow", async () => {
    const loginRes = await request(app)
      .post("/api/auth/login")
      .send({ email: "existing@example.com", password: "existing-password" });

    expect(loginRes.status).toBe(200);
    expect(loginRes.body.user.id).toBe("existing-user");

    const sessionCookie = loginRes.headers["set-cookie"]
      .find((c: string) => c.startsWith("session="));

    const meRes = await request(app)
      .get("/api/auth/me")
      .set("Cookie", sessionCookie);

    expect(meRes.status).toBe(200);
    expect(meRes.body.user).not.toBeNull();
    expect(meRes.body.user.id).toBe("existing-user");

    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", sessionCookie);

    const meAfterLogoutRes = await request(app)
      .get("/api/auth/me")
      .set("Cookie", sessionCookie);

    expect(meAfterLogoutRes.status).toBe(200);
    expect(meAfterLogoutRes.body.user).toBeNull();
  });

  it("should handle multiple sessions for same user", async () => {
    const login1 = await request(app)
      .post("/api/auth/login")
      .send({ email: "existing@example.com", password: "existing-password" });

    const login2 = await request(app)
      .post("/api/auth/login")
      .send({ email: "existing@example.com", password: "existing-password" });

    const session1 = login1.headers["set-cookie"]
      .find((c: string) => c.startsWith("session="));
    const session2 = login2.headers["set-cookie"]
      .find((c: string) => c.startsWith("session="));

    const me1 = await request(app)
      .get("/api/auth/me")
      .set("Cookie", session1);

    const me2 = await request(app)
      .get("/api/auth/me")
      .set("Cookie", session2);

    expect(me1.body.user.id).toBe("existing-user");
    expect(me2.body.user.id).toBe("existing-user");

    await request(app)
      .post("/api/auth/logout")
      .set("Cookie", session1);

    const me1AfterLogout = await request(app)
      .get("/api/auth/me")
      .set("Cookie", session1);

    const me2AfterLogout = await request(app)
      .get("/api/auth/me")
      .set("Cookie", session2);

    expect(me1AfterLogout.body.user).toBeNull();
    expect(me2AfterLogout.body.user).not.toBeNull();
  });
});
