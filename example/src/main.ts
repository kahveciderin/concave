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
  createConcaveRouter,
  createPassportAdapter,
  useAuth,
  UnauthorizedError,
  ValidationError,
  changelog,
  initializeKV,
  createHealthEndpoints,
  getGlobalKV,
  usePublicEnv,
} from "@kahveciderin/concave";

import { env } from "./config/config";
import {
  usersTable,
  todosTable,
  categoriesTable,
  tagsTable,
  todoTagsTable,
} from "./db/schema";
import { db } from "./db/db";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

await initializeKV({ type: "memory", prefix: "todo-app" });

const app = express();

const hashPassword = (password: string): string => {
  return createHash("sha256").update(password).digest("hex");
};

const metricsCollector = createMetricsCollector({
  maxMetrics: 1000,
});

app.use(express.json());
app.use(cookieParser());
app.use(observabilityMiddleware({ metrics: metricsCollector }));

// Public environment variables endpoint
app.use("/api/env", usePublicEnv(env));

// Health endpoints for Kubernetes probes
app.use(
  createHealthEndpoints({
    version: "1.0.0",
    checks: {
      kv: getGlobalKV(),
    },
    thresholds: {
      eventLoopLagMs: 100,
      memoryPercent: 90,
    },
  })
);

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, id))
      .limit(1);
    return user ?? null;
  },
});

const { router: authRouter, middleware: authMiddleware } = useAuth({
  adapter: authAdapter,
  login: {
    validateCredentials: async (email, password) => {
      const [user] = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (!user || user.passwordHash !== hashPassword(password)) {
        return null;
      }
      return { id: user.id, email: user.email, name: user.name };
    },
  },
  signup: {
    createUser: async ({ email, password, name }) => {
      const existing = await db
        .select()
        .from(usersTable)
        .where(eq(usersTable.email, email))
        .limit(1);
      if (existing.length > 0) {
        throw new ValidationError("Email already registered");
      }

      const id = randomUUID();
      const [user] = await db
        .insert(usersTable)
        .values({
          id,
          email,
          name: name ?? "User",
          passwordHash: hashPassword(password),
        })
        .returning();

      return { id: user.id, email: user.email, name: user.name };
    },
    validateEmail: (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email),
    validatePassword: (password) => password.length >= 6,
  },
});

app.use("/api/auth", authRouter);
app.use(authMiddleware);

app.use(
  "/api/categories",
  useResource(categoriesTable, {
    id: categoriesTable.id,
    db,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "createdAt"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        return {
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          createdAt: new Date(),
        };
      },
    },
  })
);

app.use(
  "/api/tags",
  useResource(tagsTable, {
    id: tagsTable.id,
    db,
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "createdAt"],
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        return {
          ...data,
          id: randomUUID(),
          userId: ctx.user.id,
          createdAt: new Date(),
        };
      },
    },
  })
);

app.use(
  "/api/todos",
  useResource(todosTable, {
    id: todosTable.id,
    db,
    pagination: { defaultLimit: 100, maxLimit: 500 },
    auth: {
      read: async (user) => rsql`userId==${user?.id}`,
      create: async (user) => (user ? rsql`*` : rsql``),
      update: async (user) => rsql`userId==${user?.id}`,
      delete: async (user) => rsql`userId==${user?.id}`,
      subscribe: async (user) => rsql`userId==${user?.id}`,
    },
    generatedFields: ["id", "userId", "position", "createdAt", "updatedAt"],
    relations: {
      category: {
        resource: "categories",
        schema: categoriesTable,
        type: "belongsTo",
        foreignKey: todosTable.categoryId,
        references: categoriesTable.id,
      },
      tags: {
        resource: "tags",
        schema: tagsTable,
        type: "manyToMany",
        foreignKey: todosTable.id,
        references: tagsTable.id,
        through: {
          schema: todoTagsTable,
          sourceKey: todoTagsTable.todoId,
          targetKey: todoTagsTable.tagId,
        },
      },
    },
    hooks: {
      onBeforeCreate: async (ctx, data) => {
        if (!ctx.user) throw new UnauthorizedError("Must be logged in");
        const [maxPos] = await db
          .select({ max: max(todosTable.position) })
          .from(todosTable)
          .where(eq(todosTable.userId, ctx.user.id));
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

app.use(
  "/__concave",
  createAdminUI({
    title: "Todo App Admin",
    metricsCollector,
    changelog: {
      getCurrentSequence: () => changelog.getCurrentSequence(),
      getEntries: (fromSeq, limit) =>
        changelog.getEntriesInRange(fromSeq, limit),
    },
    // Security configuration - development mode allows unauthenticated access
    security: {
      mode:
        (process.env.NODE_ENV as "development" | "staging" | "production") ||
        "development",
      auth: {
        // In development, auth is disabled by default
        // In production, you'd set an API key: apiKey: process.env.ADMIN_API_KEY
        disabled: process.env.NODE_ENV !== "production",
      },
    },
    // Data explorer configuration
    dataExplorer: {
      enabled: true,
      readOnly: process.env.NODE_ENV === "production",
      excludeFields: {
        users: ["passwordHash"], // Hide password hashes
      },
      maxLimit: 100,
    },
    // KV inspector configuration
    kvInspector: {
      enabled: process.env.NODE_ENV !== "production",
      kv: getGlobalKV(),
      readOnly: process.env.NODE_ENV === "staging",
    },
    userManager: {
      listUsers: async (limit = 50, offset = 0) => {
        const [users, totalResult] = await Promise.all([
          db
            .select({
              id: usersTable.id,
              email: usersTable.email,
              name: usersTable.name,
              createdAt: usersTable.createdAt,
            })
            .from(usersTable)
            .limit(limit)
            .offset(offset)
            .orderBy(desc(usersTable.createdAt)),
          db.select({ total: count() }).from(usersTable),
        ]);
        return { users, total: totalResult[0]?.total ?? 0 };
      },
      getUser: async (id) => {
        const [user] = await db
          .select()
          .from(usersTable)
          .where(eq(usersTable.id, id))
          .limit(1);
        return user ?? null;
      },
      createUser: async (data) => {
        const [user] = await db
          .insert(usersTable)
          .values({
            id: randomUUID(),
            email: data.email,
            name: data.name || "User",
            passwordHash: hashPassword("password123"),
          })
          .returning();
        return user;
      },
      updateUser: async (id, data) => {
        const [user] = await db
          .update(usersTable)
          .set(data)
          .where(eq(usersTable.id, id))
          .returning();
        return user;
      },
      deleteUser: async (id) => {
        await db.delete(usersTable).where(eq(usersTable.id, id));
      },
    },
    sessionManager: {
      listSessions: async () => {
        const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
        return sessions.map((s) => ({
          sessionToken: s.id,
          userId: s.userId,
          expires: s.expiresAt,
          createdAt: s.createdAt,
        }));
      },
      getSessionsByUser: async (userId) => {
        const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
        return sessions
          .filter((s) => s.userId === userId)
          .map((s) => ({
            sessionToken: s.id,
            userId: s.userId,
            expires: s.expiresAt,
          }));
      },
      createSession: async (userId, expiresIn = 86400000) => {
        const session = await authAdapter.createSession(userId);
        return { token: session.id, expiresAt: session.expiresAt };
      },
      revokeSession: async (sessionId) => {
        await authAdapter.invalidateSession(sessionId);
      },
      revokeAllUserSessions: async (userId) => {
        const sessions = (await authAdapter.sessionStore.getAll?.()) ?? [];
        let revokedCount = 0;
        for (const s of sessions) {
          if (s.userId === userId) {
            await authAdapter.invalidateSession(s.id);
            revokedCount++;
          }
        }
        return revokedCount;
      },
    },
  })
);

// Auto-discover resources from schema registry (paths captured on first request)
app.use("/__concave", createConcaveRouter());

const publicDir = path.join(__dirname, "../public");
app.use(express.static(publicDir));

app.get("/{*splat}", (req, res, next) => {
  if (req.path.startsWith("/api") || req.path.startsWith("/__concave")) {
    return next();
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

app.use(notFoundHandler);
app.use(errorMiddleware);

app.listen(env.serverConfig.port, () => {
  console.log(`
=============================================
  Todo App (powered by Concave)
=============================================
  App:   http://localhost:${env.serverConfig.port}
  Admin: http://localhost:${env.serverConfig.port}/__concave/ui
=============================================
  `);
});

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
