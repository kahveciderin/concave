import { describe, it, expect } from "vitest";
import { z } from "zod";
import { defineTask } from "@/tasks/define";

describe("defineTask", () => {
  it("should create a basic task definition", () => {
    const task = defineTask({
      name: "test-task",
      handler: async () => ({ success: true }),
    });

    expect(task.name).toBe("test-task");
    expect(task.handler).toBeDefined();
    expect(task.retry).toBeUndefined();
    expect(task.timeout).toBeUndefined();
    expect(task.priority).toBeUndefined();
  });

  it("should create a task with input/output schemas", () => {
    const task = defineTask({
      name: "typed-task",
      input: z.object({
        userId: z.string(),
        amount: z.number(),
      }),
      output: z.object({
        success: z.boolean(),
        transactionId: z.string().optional(),
      }),
      handler: async (ctx, input) => {
        return { success: true, transactionId: "tx-123" };
      },
    });

    expect(task.input).toBeDefined();
    expect(task.output).toBeDefined();
  });

  it("should create a task with retry configuration", () => {
    const task = defineTask({
      name: "retry-task",
      retry: {
        maxAttempts: 5,
        backoff: "exponential",
        initialDelayMs: 1000,
        maxDelayMs: 60000,
        retryOn: (error) => error.name !== "ValidationError",
      },
      handler: async () => undefined,
    });

    expect(task.retry?.maxAttempts).toBe(5);
    expect(task.retry?.backoff).toBe("exponential");
    expect(task.retry?.initialDelayMs).toBe(1000);
    expect(task.retry?.maxDelayMs).toBe(60000);
    expect(task.retry?.retryOn).toBeDefined();
  });

  it("should create a task with timeout", () => {
    const task = defineTask({
      name: "timeout-task",
      timeout: 30000,
      handler: async () => undefined,
    });

    expect(task.timeout).toBe(30000);
  });

  it("should create a task with priority", () => {
    const task = defineTask({
      name: "priority-task",
      priority: 100,
      handler: async () => undefined,
    });

    expect(task.priority).toBe(100);
  });

  it("should create a task with max concurrency", () => {
    const task = defineTask({
      name: "concurrent-task",
      maxConcurrency: 10,
      handler: async () => undefined,
    });

    expect(task.maxConcurrency).toBe(10);
  });

  it("should create a task with debounce configuration", () => {
    const task = defineTask({
      name: "debounce-task",
      debounce: {
        windowMs: 5000,
        key: (input: { userId: string }) => input.userId,
      },
      handler: async () => undefined,
    });

    expect(task.debounce?.windowMs).toBe(5000);
    expect(task.debounce?.key({ userId: "user-1" })).toBe("user-1");
  });

  it("should create a task with idempotency key function", () => {
    const task = defineTask({
      name: "idempotent-task",
      idempotencyKey: (input: { orderId: string }) => `order-${input.orderId}`,
      handler: async () => undefined,
    });

    expect(task.idempotencyKey?.({ orderId: "123" })).toBe("order-123");
  });

  it("should preserve handler with full context access", async () => {
    let capturedContext: unknown;

    const task = defineTask({
      name: "context-task",
      handler: async (ctx) => {
        capturedContext = ctx;
        return { done: true };
      },
    });

    const mockContext = {
      taskId: "task-1",
      attempt: 1,
      workerId: "worker-1",
      signal: new AbortController().signal,
      scheduledAt: new Date(),
      startedAt: new Date(),
    };

    await task.handler(mockContext, {});

    expect(capturedContext).toEqual(mockContext);
  });

  it("should allow task with all options combined", () => {
    const task = defineTask({
      name: "full-task",
      input: z.object({ data: z.string() }),
      output: z.object({ result: z.number() }),
      retry: {
        maxAttempts: 3,
        backoff: "linear",
        initialDelayMs: 500,
      },
      timeout: 10000,
      priority: 75,
      maxConcurrency: 5,
      debounce: {
        windowMs: 1000,
        key: (input) => (input as { data: string }).data,
      },
      idempotencyKey: (input) => `key-${(input as { data: string }).data}`,
      handler: async (ctx, input) => ({ result: input.data.length }),
    });

    expect(task.name).toBe("full-task");
    expect(task.input).toBeDefined();
    expect(task.output).toBeDefined();
    expect(task.retry?.maxAttempts).toBe(3);
    expect(task.timeout).toBe(10000);
    expect(task.priority).toBe(75);
    expect(task.maxConcurrency).toBe(5);
    expect(task.debounce).toBeDefined();
    expect(task.idempotencyKey).toBeDefined();
  });
});
