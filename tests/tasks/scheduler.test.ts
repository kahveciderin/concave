import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { z } from "zod";
import {
  createTaskScheduler,
  createTaskRegistry,
  TaskScheduler,
  TaskRegistry,
} from "@/tasks/scheduler";
import { defineTask } from "@/tasks/define";
import { createMemoryKV, KVAdapter } from "@/kv";

let kv: KVAdapter;
let scheduler: TaskScheduler;
let registry: TaskRegistry;

describe("TaskScheduler", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-scheduler");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    registry = createTaskRegistry();
    scheduler = createTaskScheduler(kv, registry);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("TaskRegistry", () => {
    it("should register and retrieve tasks", () => {
      const task = defineTask({
        name: "test-task",
        handler: async () => undefined,
      });

      registry.register(task);

      const retrieved = registry.get("test-task");
      expect(retrieved).toBe(task);
    });

    it("should return undefined for unregistered tasks", () => {
      expect(registry.get("nonexistent")).toBeUndefined();
    });

    it("should list all registered tasks", () => {
      const task1 = defineTask({ name: "task-1", handler: async () => undefined });
      const task2 = defineTask({ name: "task-2", handler: async () => undefined });
      const task3 = defineTask({ name: "task-3", handler: async () => undefined });

      registry.register(task1);
      registry.register(task2);
      registry.register(task3);

      const all = registry.getAll();
      expect(all).toHaveLength(3);
      expect(all.map((t) => t.name)).toContain("task-1");
      expect(all.map((t) => t.name)).toContain("task-2");
      expect(all.map((t) => t.name)).toContain("task-3");
    });

    it("should overwrite task with same name", () => {
      const task1 = defineTask({
        name: "duplicate",
        priority: 10,
        handler: async () => undefined,
      });

      const task2 = defineTask({
        name: "duplicate",
        priority: 90,
        handler: async () => undefined,
      });

      registry.register(task1);
      registry.register(task2);

      const retrieved = registry.get("duplicate");
      expect(retrieved?.priority).toBe(90);
    });
  });

  describe("enqueue", () => {
    it("should enqueue a task and return task ID", async () => {
      const task = defineTask({
        name: "enqueue-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, { foo: "bar" });

      expect(taskId).toBeDefined();
      expect(typeof taskId).toBe("string");

      const stored = await scheduler.getTask(taskId);
      expect(stored).not.toBeNull();
      expect(stored?.name).toBe("enqueue-test");
      expect(stored?.status).toBe("pending");
      expect(stored?.input).toEqual({ foo: "bar" });
    });

    it("should use task priority as default", async () => {
      const task = defineTask({
        name: "priority-test",
        priority: 75,
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, {});
      const stored = await scheduler.getTask(taskId);

      expect(stored?.priority).toBe(75);
    });

    it("should use default priority of 50 when not specified", async () => {
      const task = defineTask({
        name: "default-priority",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, {});
      const stored = await scheduler.getTask(taskId);

      expect(stored?.priority).toBe(50);
    });

    it("should set scheduledFor to now for immediate execution", async () => {
      const task = defineTask({
        name: "immediate-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const before = Date.now();
      const taskId = await scheduler.enqueue(task, {});
      const after = Date.now();

      const stored = await scheduler.getTask(taskId);

      expect(stored?.scheduledFor).toBeGreaterThanOrEqual(before);
      expect(stored?.scheduledFor).toBeLessThanOrEqual(after);
    });

    it("should use idempotency key from task definition", async () => {
      const task = defineTask({
        name: "idempotent-test",
        idempotencyKey: (input: { orderId: string }) => `order-${input.orderId}`,
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId1 = await scheduler.enqueue(task, { orderId: "123" });
      const taskId2 = await scheduler.enqueue(task, { orderId: "123" });

      expect(taskId1).toBe(taskId2);
    });

    it("should create new task for different idempotency keys", async () => {
      const task = defineTask({
        name: "idempotent-different",
        idempotencyKey: (input: { orderId: string }) => `order-${input.orderId}`,
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId1 = await scheduler.enqueue(task, { orderId: "123" });
      const taskId2 = await scheduler.enqueue(task, { orderId: "456" });

      expect(taskId1).not.toBe(taskId2);
    });

    it("should set default maxAttempts from retry config", async () => {
      const task = defineTask({
        name: "retry-config-test",
        retry: { maxAttempts: 5 },
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, {});
      const stored = await scheduler.getTask(taskId);

      expect(stored?.maxAttempts).toBe(5);
    });

    it("should use default maxAttempts of 3 when not specified", async () => {
      const task = defineTask({
        name: "default-retry",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, {});
      const stored = await scheduler.getTask(taskId);

      expect(stored?.maxAttempts).toBe(3);
    });
  });

  describe("schedule", () => {
    it("should schedule a task with delay", async () => {
      const task = defineTask({
        name: "delay-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const before = Date.now();
      const taskId = await scheduler.schedule(task, {}, { delay: 5000 });

      const stored = await scheduler.getTask(taskId);

      expect(stored?.status).toBe("scheduled");
      expect(stored?.scheduledFor).toBeGreaterThanOrEqual(before + 5000);
    });

    it("should schedule a task at specific time", async () => {
      const task = defineTask({
        name: "at-time-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const futureTime = new Date(Date.now() + 60000);
      const taskId = await scheduler.schedule(task, {}, { at: futureTime });

      const stored = await scheduler.getTask(taskId);

      expect(stored?.scheduledFor).toBe(futureTime.getTime());
    });

    it("should allow priority override at schedule time", async () => {
      const task = defineTask({
        name: "priority-override",
        priority: 50,
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.schedule(task, {}, { priority: 100 });
      const stored = await scheduler.getTask(taskId);

      expect(stored?.priority).toBe(100);
    });

    it("should support idempotency key in schedule options", async () => {
      const task = defineTask({
        name: "schedule-idempotency",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId1 = await scheduler.schedule(
        task,
        {},
        { delay: 1000, idempotencyKey: "unique-key-1" }
      );
      const taskId2 = await scheduler.schedule(
        task,
        {},
        { delay: 2000, idempotencyKey: "unique-key-1" }
      );

      expect(taskId1).toBe(taskId2);
    });

    it("should prefer options idempotency key over task definition", async () => {
      const task = defineTask({
        name: "idempotency-priority",
        idempotencyKey: (input: { id: string }) => `task-${input.id}`,
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId1 = await scheduler.schedule(
        task,
        { id: "1" },
        { idempotencyKey: "override-key" }
      );
      const taskId2 = await scheduler.schedule(
        task,
        { id: "2" },
        { idempotencyKey: "override-key" }
      );

      expect(taskId1).toBe(taskId2);
    });
  });

  describe("scheduleRecurring", () => {
    it("should schedule a recurring task with cron", async () => {
      const task = defineTask({
        name: "cron-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const scheduleId = await scheduler.scheduleRecurring(
        task,
        {},
        { cron: "0 * * * *" }
      );

      expect(scheduleId).toBeDefined();
      expect(typeof scheduleId).toBe("string");
    });

    it("should schedule a recurring task with interval", async () => {
      const task = defineTask({
        name: "interval-test",
        handler: async () => undefined,
      });
      registry.register(task);

      const scheduleId = await scheduler.scheduleRecurring(
        task,
        {},
        { interval: 60000 }
      );

      expect(scheduleId).toBeDefined();
    });
  });

  describe("cancel", () => {
    it("should cancel a pending task", async () => {
      const task = defineTask({
        name: "cancel-pending",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.enqueue(task, {});
      const cancelled = await scheduler.cancel(taskId);

      expect(cancelled).toBe(true);

      const stored = await scheduler.getTask(taskId);
      expect(stored).toBeNull();
    });

    it("should cancel a scheduled task", async () => {
      const task = defineTask({
        name: "cancel-scheduled",
        handler: async () => undefined,
      });
      registry.register(task);

      const taskId = await scheduler.schedule(task, {}, { delay: 60000 });
      const cancelled = await scheduler.cancel(taskId);

      expect(cancelled).toBe(true);

      const stored = await scheduler.getTask(taskId);
      expect(stored).toBeNull();
    });

    it("should return false for non-existent task", async () => {
      const cancelled = await scheduler.cancel("nonexistent-id");
      expect(cancelled).toBe(false);
    });
  });

  describe("getTask", () => {
    it("should return null for non-existent task", async () => {
      const task = await scheduler.getTask("nonexistent");
      expect(task).toBeNull();
    });

    it("should return complete task object", async () => {
      const taskDef = defineTask({
        name: "get-task-test",
        priority: 80,
        retry: { maxAttempts: 5 },
        handler: async () => undefined,
      });
      registry.register(taskDef);

      const taskId = await scheduler.enqueue(taskDef, { data: "test" });
      const task = await scheduler.getTask(taskId);

      expect(task).not.toBeNull();
      expect(task?.id).toBe(taskId);
      expect(task?.name).toBe("get-task-test");
      expect(task?.status).toBe("pending");
      expect(task?.priority).toBe(80);
      expect(task?.maxAttempts).toBe(5);
      expect(task?.attempt).toBe(0);
      expect(task?.input).toEqual({ data: "test" });
      expect(task?.createdAt).toBeDefined();
      expect(task?.scheduledFor).toBeDefined();
    });
  });

  describe("getTasks", () => {
    it("should filter by status", async () => {
      const task = defineTask({
        name: "status-filter",
        handler: async () => undefined,
      });
      registry.register(task);

      await scheduler.enqueue(task, { id: 1 });
      await scheduler.enqueue(task, { id: 2 });
      await scheduler.schedule(task, { id: 3 }, { delay: 60000 });

      const pending = await scheduler.getTasks({ status: "pending" });
      const scheduled = await scheduler.getTasks({ status: "scheduled" });

      expect(pending).toHaveLength(2);
      expect(scheduled).toHaveLength(1);
    });

    it("should filter by multiple statuses", async () => {
      const task = defineTask({
        name: "multi-status-filter",
        handler: async () => undefined,
      });
      registry.register(task);

      await scheduler.enqueue(task, { id: 1 });
      await scheduler.schedule(task, { id: 2 }, { delay: 60000 });

      const both = await scheduler.getTasks({ status: ["pending", "scheduled"] });
      expect(both).toHaveLength(2);
    });

    it("should filter by name", async () => {
      const task1 = defineTask({ name: "name-1", handler: async () => undefined });
      const task2 = defineTask({ name: "name-2", handler: async () => undefined });
      registry.register(task1);
      registry.register(task2);

      await scheduler.enqueue(task1, {});
      await scheduler.enqueue(task1, {});
      await scheduler.enqueue(task2, {});

      const filtered = await scheduler.getTasks({ name: "name-1" });
      expect(filtered).toHaveLength(2);
    });

    it("should filter by date range", async () => {
      const task = defineTask({
        name: "date-filter",
        handler: async () => undefined,
      });
      registry.register(task);

      const before = new Date();
      await scheduler.enqueue(task, { id: 1 });
      const middle = new Date();
      await scheduler.enqueue(task, { id: 2 });
      const after = new Date();

      const filtered = await scheduler.getTasks({
        createdAfter: middle,
        createdBefore: after,
      });

      expect(filtered.length).toBeGreaterThanOrEqual(1);
    });

    it("should limit results", async () => {
      const task = defineTask({
        name: "limit-test",
        handler: async () => undefined,
      });
      registry.register(task);

      for (let i = 0; i < 10; i++) {
        await scheduler.enqueue(task, { id: i });
      }

      const limited = await scheduler.getTasks({ limit: 5 });
      expect(limited).toHaveLength(5);
    });

    it("should offset results", async () => {
      const task = defineTask({
        name: "offset-test",
        handler: async () => undefined,
      });
      registry.register(task);

      for (let i = 0; i < 10; i++) {
        await scheduler.enqueue(task, { id: i });
      }

      const page1 = await scheduler.getTasks({ limit: 5, offset: 0 });
      const page2 = await scheduler.getTasks({ limit: 5, offset: 5 });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);

      const ids1 = page1.map((t) => t.id);
      const ids2 = page2.map((t) => t.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });
  });

  describe("getQueueDepth", () => {
    it("should return 0 for empty queue", async () => {
      const depth = await scheduler.getQueueDepth();
      expect(depth).toBe(0);
    });

    it("should count queued tasks", async () => {
      const task = defineTask({
        name: "depth-test",
        handler: async () => undefined,
      });
      registry.register(task);

      await scheduler.enqueue(task, { id: 1 });
      await scheduler.enqueue(task, { id: 2 });
      await scheduler.enqueue(task, { id: 3 });

      const depth = await scheduler.getQueueDepth();
      expect(depth).toBe(3);
    });
  });
});
