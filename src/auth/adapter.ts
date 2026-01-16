import { Request, Router } from "express";
import {
  AuthAdapter,
  AuthCredentials,
  AuthResult,
  SessionData,
  SessionStore,
  InMemorySessionStore,
} from "./types";
import { UserContext } from "@/resource/types";

export abstract class BaseAuthAdapter implements AuthAdapter {
  abstract name: string;
  readonly sessionStore: SessionStore;
  protected sessionTtlMs: number;

  constructor(options: { sessionStore?: SessionStore; sessionTtlMs?: number } = {}) {
    this.sessionStore = options.sessionStore ?? new InMemorySessionStore();
    this.sessionTtlMs = options.sessionTtlMs ?? 24 * 60 * 60 * 1000;
  }

  extractCredentials(req: Request): AuthCredentials | null {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
      const sessionId = req.cookies?.session;
      if (sessionId) {
        return { type: "session", sessionId };
      }
      return null;
    }

    if (authHeader.startsWith("Bearer ")) {
      return { type: "bearer", token: authHeader.slice(7) };
    }

    if (authHeader.startsWith("Basic ")) {
      const base64 = authHeader.slice(6);
      const decoded = Buffer.from(base64, "base64").toString("utf-8");
      const [username, password] = decoded.split(":");
      return { type: "basic", username, password };
    }

    const apiKey = req.headers["x-api-key"];
    if (typeof apiKey === "string") {
      return { type: "apiKey", apiKey };
    }

    return null;
  }

  abstract validateCredentials(credentials: AuthCredentials): Promise<AuthResult>;

  async getSession(token: string): Promise<SessionData | null> {
    return this.sessionStore.get(token);
  }

  async invalidateSession(token: string): Promise<void> {
    await this.sessionStore.delete(token);
  }

  async createSession(
    userId: string,
    data?: Record<string, unknown>
  ): Promise<SessionData> {
    const sessionId = crypto.randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + this.sessionTtlMs);

    const session: SessionData = {
      id: sessionId,
      userId,
      createdAt: now,
      expiresAt,
      data,
    };

    await this.sessionStore.set(sessionId, session, this.sessionTtlMs);
    return session;
  }

  async refreshSession(sessionId: string): Promise<SessionData | null> {
    const session = await this.sessionStore.get(sessionId);
    if (!session) return null;

    const now = new Date();
    session.expiresAt = new Date(now.getTime() + this.sessionTtlMs);
    await this.sessionStore.set(sessionId, session, this.sessionTtlMs);

    return session;
  }

  abstract getRoutes(): Router;
}

export class CompositeAuthAdapter implements AuthAdapter {
  name = "composite";
  private adapters: AuthAdapter[];

  constructor(adapters: AuthAdapter[]) {
    this.adapters = adapters;
  }

  extractCredentials(req: Request): AuthCredentials | null {
    for (const adapter of this.adapters) {
      const credentials = adapter.extractCredentials(req);
      if (credentials) return credentials;
    }
    return null;
  }

  async validateCredentials(credentials: AuthCredentials): Promise<AuthResult> {
    for (const adapter of this.adapters) {
      try {
        const result = await adapter.validateCredentials(credentials);
        if (result.success) return result;
      } catch {
        continue;
      }
    }
    return { success: false, error: "Invalid credentials" };
  }

  async getSession(token: string): Promise<SessionData | null> {
    for (const adapter of this.adapters) {
      const session = await adapter.getSession(token);
      if (session) return session;
    }
    return null;
  }

  async invalidateSession(token: string): Promise<void> {
    await Promise.all(this.adapters.map((a) => a.invalidateSession(token)));
  }

  getRoutes(): Router {
    const router = Router();
    for (const adapter of this.adapters) {
      router.use(`/${adapter.name}`, adapter.getRoutes());
    }
    return router;
  }
}

export class NullAuthAdapter implements AuthAdapter {
  name = "null";

  extractCredentials(_req: Request): AuthCredentials | null {
    return null;
  }

  async validateCredentials(_credentials: AuthCredentials): Promise<AuthResult> {
    return { success: false, error: "No authentication configured" };
  }

  async getSession(_token: string): Promise<SessionData | null> {
    return null;
  }

  async invalidateSession(_token: string): Promise<void> {}

  getRoutes(): Router {
    return Router();
  }
}

export const createUserContext = (
  user: {
    id: string;
    email?: string | null;
    name?: string | null;
    image?: string | null;
    emailVerified?: Date | null;
    metadata?: Record<string, unknown>;
  },
  session: SessionData
): UserContext => ({
  id: user.id,
  email: user.email ?? null,
  name: user.name ?? null,
  image: user.image ?? null,
  emailVerified: user.emailVerified ?? null,
  sessionId: session.id,
  sessionExpiresAt: session.expiresAt,
  metadata: user.metadata,
});
