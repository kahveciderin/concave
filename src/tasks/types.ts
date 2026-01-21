import { z } from "zod";

export type TaskStatus =
  | "pending"
  | "scheduled"
  | "running"
  | "completed"
  | "failed"
  | "dead";

export interface RetryConfig {
  maxAttempts?: number;
  backoff?: "exponential" | "linear" | "fixed";
  initialDelayMs?: number;
  maxDelayMs?: number;
  retryOn?: (error: Error) => boolean;
}

export interface DebounceConfig {
  windowMs: number;
  key: (input: unknown) => string;
}

export interface TaskContext {
  taskId: string;
  attempt: number;
  scheduledAt: Date;
  startedAt: Date;
  workerId: string;
  signal: AbortSignal;
  db: unknown;
}

export interface TaskDefinition<TInput = unknown, TOutput = unknown> {
  name: string;
  input?: z.ZodSchema<TInput>;
  output?: z.ZodSchema<TOutput>;
  handler: (ctx: TaskContext, input: TInput) => Promise<TOutput>;
  retry?: RetryConfig;
  timeout?: number;
  priority?: number;
  maxConcurrency?: number;
  debounce?: DebounceConfig;
  idempotencyKey?: (input: TInput) => string;
}

export interface RecurringConfig {
  cron?: string;
  interval?: number;
  timezone?: string;
}

export interface Task<TInput = unknown> {
  id: string;
  name: string;
  input: TInput;
  status: TaskStatus;
  priority: number;
  createdAt: number;
  scheduledFor: number;
  startedAt?: number;
  completedAt?: number;
  workerId?: string;
  attempt: number;
  maxAttempts: number;
  lastError?: string;
  result?: unknown;
  idempotencyKey?: string;
  recurring?: RecurringConfig;
}

export interface ScheduleOptions {
  delay?: number;
  at?: Date;
  priority?: number;
  idempotencyKey?: string;
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[];
  name?: string | string[];
  createdAfter?: Date;
  createdBefore?: Date;
  limit?: number;
  offset?: number;
}

export interface DeadLetterEntry {
  taskId: string;
  task: Task;
  failedAt: number;
  reason: string;
  attempts: number;
}

export interface RecurringSchedule {
  id: string;
  taskName: string;
  input: unknown;
  cron?: string;
  interval?: number;
  timezone: string;
  enabled: boolean;
  lastRunAt?: number;
  nextRunAt: number;
  createdAt: number;
}

export interface WorkerStats {
  id: string;
  status: "running" | "paused" | "stopped";
  activeTasks: number;
  processedCount: number;
  failedCount: number;
  uptime: number;
}

export interface WorkerConfig {
  id?: string;
  concurrency?: number;
  pollIntervalMs?: number;
  taskTypes?: string[];
  lockTtlMs?: number;
  heartbeatMs?: number;
}
