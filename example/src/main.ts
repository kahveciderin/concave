import express from "express";
import cookieParser from "cookie-parser";
import { eq, count, desc, max } from "drizzle-orm";
import { randomUUID, createHash } from "crypto";
import path from "path";
import { fileURLToPath } from "url";

import {
  useResource,
  errorMiddleware,
  notFoundHandler,
  rsql,
  createMetricsCollector,
  observabilityMiddleware,
  createAdminUI,
  registerResource,
  createConcaveRouter,
  UnauthorizedError,
  ValidationError,
  changelog,
  initializeKV,
} from "concave";
import type { RegisteredResource } from "concave";

import config from "./config/config";
import { usersTable, todosTable } from "./db/schema";
import { db } from "./db/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Initialize in-memory KV store for subscriptions
await initializeKV({ type: "memory", prefix: "todo-app" });

const app = express();

const hashPassword = (password: string): string => {
  return createHash("sha256").update(password).digest("hex");
};

const metricsCollector = createMetricsCollector({
  maxMetrics: 1000,
  slowThresholdMs: 500,
});

app.use(express.json());
app.use(cookieParser());
app.use(observabilityMiddleware({ metrics: metricsCollector }));

// Session store (in-memory for demo, use Redis in production)
const sessions = new Map<string, { userId: string; expiresAt: Date }>();

// Auth middleware
app.use((req: any, res, next) => {
  const token = req.cookies?.session || req.headers.authorization?.replace("Bearer ", "");
  if (token && sessions.has(token)) {
    const session = sessions.get(token)!;
    if (session.expiresAt > new Date()) {
      req.user = { id: session.userId };
    } else {
      sessions.delete(token);
    }
  }
  next();
});

// Auth routes
app.post("/api/auth/signup", async (req, res, next) => {
  try {
    const { email, name, password } = req.body;
    if (!email || !name || !password) {
      throw new ValidationError("Email, name, and password are required");
    }

    const existing = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (existing.length > 0) {
      throw new ValidationError("Email already registered");
    }

    const id = randomUUID();
    const [user] = await db.insert(usersTable).values({
      id,
      email,
      name,
      passwordHash: hashPassword(password),
    }).returning();

    const sessionToken = randomUUID();
    sessions.set(sessionToken, { userId: id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });

    res.cookie("session", sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

app.post("/api/auth/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) {
      throw new ValidationError("Email and password are required");
    }

    const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
    if (!user || user.passwordHash !== hashPassword(password)) {
      throw new UnauthorizedError("Invalid email or password");
    }

    const sessionToken = randomUUID();
    sessions.set(sessionToken, { userId: user.id, expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) });

    res.cookie("session", sessionToken, { httpOnly: true, maxAge: 7 * 24 * 60 * 60 * 1000 });
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

app.post("/api/auth/logout", (req, res) => {
  const token = req.cookies?.session;
  if (token) sessions.delete(token);
  res.clearCookie("session");
  res.json({ success: true });
});

app.get("/api/auth/me", async (req: any, res, next) => {
  try {
    if (!req.user) {
      res.json({ user: null });
      return;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, req.user.id)).limit(1);
    if (!user) {
      res.json({ user: null });
      return;
    }
    res.json({ user: { id: user.id, email: user.email, name: user.name } });
  } catch (e) {
    next(e);
  }
});

// Todos resource
app.use(
  "/api/todos",
  useResource(todosTable, {
    id: todosTable.id,
    db,
    pagination: { defaultLimit: 100, maxLimit: 500 },
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => user ? rsql`*` : rsql``,
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
      subscribe: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "position", "createdAt", "updatedAt"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        const [maxPos] = await db.select({ max: max(todosTable.position) }).from(todosTable).where(eq(todosTable.userId, ctx.user.id));
        return {
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          position: (maxPos?.max ?? -1) + 1,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
      },
      onBeforeUpdate: async (_ctx, _id, data) => ({
        ...data,
        updatedAt: new Date(),
      }),
    },
  })
);

// Admin UI
app.use("/__concave", createAdminUI({
  title: "Todo App Admin",
  metricsCollector,
  changelog: {
    getCurrentSequence: () => changelog.getCurrentSequence(),
    getEntries: (fromSeq, limit) => changelog.getEntriesInRange(fromSeq, limit),
  },
  userManager: {
    listUsers: async (limit = 50, offset = 0) => {
      const [users, totalResult] = await Promise.all([
        db.select({ id: usersTable.id, email: usersTable.email, name: usersTable.name, createdAt: usersTable.createdAt })
          .from(usersTable).limit(limit).offset(offset).orderBy(desc(usersTable.createdAt)),
        db.select({ total: count() }).from(usersTable),
      ]);
      return { users, total: totalResult[0]?.total ?? 0 };
    },
    getUser: async (id) => {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, id)).limit(1);
      return user ?? null;
    },
    createUser: async (data) => {
      const [user] = await db.insert(usersTable).values({
        id: randomUUID(),
        email: data.email,
        name: data.name || "User",
        passwordHash: hashPassword("password123"),
      }).returning();
      return user;
    },
    updateUser: async (id, data) => {
      const [user] = await db.update(usersTable).set(data).where(eq(usersTable.id, id)).returning();
      return user;
    },
    deleteUser: async (id) => {
      await db.delete(usersTable).where(eq(usersTable.id, id));
    },
  },
  sessionManager: {
    listSessions: async () => Array.from(sessions.entries()).map(([token, s]) => ({
      sessionToken: token,
      userId: s.userId,
      expires: s.expiresAt,
      createdAt: new Date(s.expiresAt.getTime() - 7 * 24 * 60 * 60 * 1000),
    })),
    getSessionsByUser: async (userId) => Array.from(sessions.entries())
      .filter(([_, s]) => s.userId === userId)
      .map(([token, s]) => ({ sessionToken: token, userId: s.userId, expires: s.expiresAt })),
    createSession: async (userId, expiresIn = 86400000) => {
      const token = randomUUID();
      const expiresAt = new Date(Date.now() + expiresIn);
      sessions.set(token, { userId, expiresAt });
      return { token, expiresAt };
    },
    revokeSession: async (sessionId) => { sessions.delete(sessionId); },
    revokeAllUserSessions: async (userId) => {
      let count = 0;
      for (const [token, s] of sessions.entries()) {
        if (s.userId === userId) { sessions.delete(token); count++; }
      }
      return count;
    },
  },
}));

registerResource({
  path: "/api/todos",
  fields: ["id", "userId", "title", "completed", "position", "createdAt", "updatedAt"],
  capabilities: { enableCreate: true, enableUpdate: true, enableDelete: true, enableSubscriptions: true },
});

const registeredResources: RegisteredResource[] = [{
  name: "Todo",
  path: "/api/todos",
  schema: todosTable,
  capabilities: { enableCreate: true, enableUpdate: true, enableDelete: true, enableSubscribe: true },
}];
app.use("/__concave", createConcaveRouter(registeredResources));

// Serve static frontend
const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

// SPA fallback - serve index.html for all non-API routes
app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/__concave")) {
    return next();
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(notFoundHandler);
app.use(errorMiddleware);

app.listen(config.port, () => {
  console.log(`
========================================
  Todo App (powered by Concave)
========================================
  App:   http://localhost:${config.port}
  Admin: http://localhost:${config.port}/__concave/ui
========================================
  `);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
