import { eq, and, gt, lt } from "drizzle-orm";
import { SessionData, SessionStore } from "../types";
import { DrizzleDatabase } from "@/resource/types";

export interface SessionsTableColumns {
  id: unknown;
  userId: unknown;
  createdAt: unknown;
  expiresAt: unknown;
  data: unknown;
}

export interface DrizzleSessionStoreOptions {
  db: DrizzleDatabase;
  table: {
    id: unknown;
    userId: unknown;
    createdAt: unknown;
    expiresAt: unknown;
    data: unknown;
  } & Record<string, unknown>;
  cleanupIntervalMs?: number;
  onError?: (error: Error) => void;
}

export class DrizzleSessionStore implements SessionStore {
  private db: DrizzleDatabase;
  private table: DrizzleSessionStoreOptions["table"];
  private cleanupInterval?: ReturnType<typeof setInterval>;
  private onError?: (error: Error) => void;

  constructor(options: DrizzleSessionStoreOptions) {
    this.db = options.db;
    this.table = options.table;
    this.onError = options.onError;

    if (options.cleanupIntervalMs) {
      this.cleanupInterval = setInterval(
        () => this.cleanup(),
        options.cleanupIntervalMs
      );
    }
  }

  async get(sessionId: string): Promise<SessionData | null> {
    try {
      const results = await this.db
        .select()
        .from(this.table as never)
        .where(
          and(
            eq(this.table.id as never, sessionId),
            gt(this.table.expiresAt as never, new Date())
          )
        )
        .limit(1);

      if (results.length === 0) return null;

      const row = results[0] as Record<string, unknown>;
      return {
        id: row.id as string,
        userId: row.userId as string,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt as string | number),
        expiresAt:
          row.expiresAt instanceof Date
            ? row.expiresAt
            : new Date(row.expiresAt as string | number),
        data: row.data
          ? typeof row.data === "string"
            ? JSON.parse(row.data)
            : (row.data as Record<string, unknown>)
          : undefined,
      };
    } catch (error) {
      this.onError?.(error as Error);
      return null;
    }
  }

  async set(
    sessionId: string,
    session: SessionData,
    _ttlMs: number
  ): Promise<void> {
    try {
      const existing = await this.db
        .select({ id: this.table.id as never })
        .from(this.table as never)
        .where(eq(this.table.id as never, sessionId))
        .limit(1);

      const dataValue = session.data ? JSON.stringify(session.data) : null;

      if (existing.length > 0) {
        await this.db
          .update(this.table as never)
          .set({
            userId: session.userId,
            expiresAt: session.expiresAt,
            data: dataValue,
          } as never)
          .where(eq(this.table.id as never, sessionId));
      } else {
        await this.db.insert(this.table as never).values({
          id: session.id,
          userId: session.userId,
          createdAt: session.createdAt,
          expiresAt: session.expiresAt,
          data: dataValue,
        } as never);
      }
    } catch (error) {
      this.onError?.(error as Error);
      throw error;
    }
  }

  async delete(sessionId: string): Promise<void> {
    try {
      await this.db
        .delete(this.table as never)
        .where(eq(this.table.id as never, sessionId));
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async touch(sessionId: string, ttlMs: number): Promise<void> {
    try {
      await this.db
        .update(this.table as never)
        .set({ expiresAt: new Date(Date.now() + ttlMs) } as never)
        .where(eq(this.table.id as never, sessionId));
    } catch (error) {
      this.onError?.(error as Error);
    }
  }

  async getAll(): Promise<SessionData[]> {
    try {
      const rows = (await this.db
        .select()
        .from(this.table as never)
        .where(gt(this.table.expiresAt as never, new Date()))) as Record<
        string,
        unknown
      >[];

      return rows.map((row) => ({
        id: row.id as string,
        userId: row.userId as string,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt as string | number),
        expiresAt:
          row.expiresAt instanceof Date
            ? row.expiresAt
            : new Date(row.expiresAt as string | number),
        data: row.data
          ? typeof row.data === "string"
            ? JSON.parse(row.data)
            : (row.data as Record<string, unknown>)
          : undefined,
      }));
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async getByUser(userId: string): Promise<SessionData[]> {
    try {
      const rows = (await this.db
        .select()
        .from(this.table as never)
        .where(
          and(
            eq(this.table.userId as never, userId),
            gt(this.table.expiresAt as never, new Date())
          )
        )) as Record<string, unknown>[];

      return rows.map((row) => ({
        id: row.id as string,
        userId: row.userId as string,
        createdAt:
          row.createdAt instanceof Date
            ? row.createdAt
            : new Date(row.createdAt as string | number),
        expiresAt:
          row.expiresAt instanceof Date
            ? row.expiresAt
            : new Date(row.expiresAt as string | number),
        data: row.data
          ? typeof row.data === "string"
            ? JSON.parse(row.data)
            : (row.data as Record<string, unknown>)
          : undefined,
      }));
    } catch (error) {
      this.onError?.(error as Error);
      return [];
    }
  }

  async deleteByUser(userId: string): Promise<number> {
    try {
      const result = await this.db
        .delete(this.table as never)
        .where(eq(this.table.userId as never, userId));

      return (result as { changes?: number }).changes ?? 0;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }

  async cleanup(): Promise<number> {
    try {
      const result = await this.db
        .delete(this.table as never)
        .where(lt(this.table.expiresAt as never, new Date()));

      return (result as { changes?: number }).changes ?? 0;
    } catch (error) {
      this.onError?.(error as Error);
      return 0;
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
  }
}

export const createDrizzleSessionStore = (
  options: DrizzleSessionStoreOptions
): DrizzleSessionStore => {
  return new DrizzleSessionStore(options);
};
