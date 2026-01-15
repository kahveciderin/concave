import express from "express";
import cookieParser from "cookie-parser";
import config from "@/config/config";
import { useResource } from "./resource/hook";
import { usersTable } from "./db/schema";
import { errorMiddleware, notFoundHandler } from "./middleware/error";
import { createAuthMiddleware, requireAuth } from "./auth/middleware";
import { createPassportAdapter } from "./auth/adapters/passport";
import { rsql } from "./auth/rsql";
import { scopePatterns } from "./auth/scope";
import { defineProcedure, createTimestampHooks, composeHooks } from "./resource/procedures";
import { z } from "zod";
import { db } from "./db/db";
import { eq, count } from "drizzle-orm";

const app = express();

app.use(express.json());
app.use(cookieParser());

const authAdapter = createPassportAdapter({
  getUserById: async (id) => {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, parseInt(id, 10)))
      .limit(1);
    if (!user) return null;
    return { ...user, id: String(user.id) };
  },
  validatePassword: async (email, password) => {
    const [user] = await db
      .select()
      .from(usersTable)
      .where(eq(usersTable.email, email))
      .limit(1);
    if (user && password === "demo") {
      return { ...user, id: String(user.id) };
    }
    return null;
  },
});

app.use(createAuthMiddleware(authAdapter));
app.use("/auth", authAdapter.getRoutes());

app.use(
  "/users",
  useResource(usersTable, {
    id: usersTable.id,
    batch: {
      create: 50,
      update: 50,
      delete: 10,
    },
    pagination: {
      defaultLimit: 20,
      maxLimit: 100,
    },
    rateLimit: {
      windowMs: 60000,
      maxRequests: 100,
    },
    auth: {
      public: {
        read: true,
        subscribe: true,
      },
      update: async (user) => rsql`id=="${user.id}"`,
      delete: async (user) => rsql`id=="${user.id}"`,
      create: async (user) => rsql`*`,
    },
    customOperators: {
      "=contains=": {
        convert: (lhs, rhs) => {
          const { sql } = require("drizzle-orm");
          return sql`${lhs} LIKE '%' || ${rhs} || '%'`;
        },
        execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
      },
      "=startswith=": {
        convert: (lhs, rhs) => {
          const { sql } = require("drizzle-orm");
          return sql`${lhs} LIKE ${rhs} || '%'`;
        },
        execute: (lhs, rhs) => String(lhs).startsWith(String(rhs)),
      },
    },
    hooks: composeHooks(
      createTimestampHooks(),
      {
        onBeforeCreate: async (ctx, data) => {
          console.log(`Creating user: ${data.email}`);
          return data;
        },
        onAfterCreate: async (ctx, created) => {
          console.log(`User created: ${created.id}`);
        },
        onAfterDelete: async (ctx, deleted) => {
          console.log(`User deleted: ${deleted.id}`);
        },
      }
    ),
    procedures: {
      changeEmail: defineProcedure({
        input: z.object({
          newEmail: z.string().email(),
        }),
        output: z.object({
          success: z.boolean(),
          message: z.string(),
        }),
        writeEffects: [{ type: "update", resource: "users" }],
        handler: async (ctx, input) => {
          if (!ctx.user) {
            return { success: false, message: "Not authenticated" };
          }

          await db
            .update(usersTable)
            .set({ email: input.newEmail })
            .where(eq(usersTable.id, parseInt(ctx.user.id, 10)));

          return { success: true, message: "Email updated" };
        },
      }),
      getStats: defineProcedure({
        output: z.object({
          totalUsers: z.number(),
          activeToday: z.number(),
        }),
        handler: async () => {
          const [result] = await db
            .select({ total: count() })
            .from(usersTable);

          return {
            totalUsers: result?.total ?? 0,
            activeToday: 0,
          };
        },
      }),
    } as any,
  })
);

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.use(notFoundHandler);
app.use(errorMiddleware);

app.listen(config.port, () => {
  console.log(`
========================================
  Concave API Server
========================================
  Port: ${config.port}
  Environment: ${process.env.NODE_ENV ?? "development"}

  Endpoints:
  - GET    /health           Health check
  - GET    /users            List users (paginated)
  - GET    /users/:id        Get user
  - POST   /users            Create user
  - PATCH  /users/:id        Update user
  - PUT    /users/:id        Replace user
  - DELETE /users/:id        Delete user
  - GET    /users/count      Count users
  - GET    /users/aggregate  Aggregation queries
  - GET    /users/subscribe  SSE subscription
  - POST   /users/batch      Batch create
  - PATCH  /users/batch      Batch update
  - DELETE /users/batch      Batch delete
  - POST   /users/rpc/:name  RPC procedures

  Auth:
  - POST   /auth/login       Login
  - POST   /auth/logout      Logout
  - GET    /auth/session     Get session
========================================
  `);
});

process.on("SIGTERM", () => {
  console.log("SIGTERM received, shutting down...");
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("SIGINT received, shutting down...");
  process.exit(0);
});
