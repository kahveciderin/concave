import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import { createTaskStorage, TaskStorage } from "@/tasks/storage";
import { createTaskQueue, TaskQueue } from "@/tasks/queue";
import { createTaskLock, TaskLock } from "@/tasks/lock";
import { createMemoryKV, KVAdapter } from "@/kv";
import { Task, TaskStatus } from "@/tasks/types";

let kv: KVAdapter;
let storage: TaskStorage;
let queue: TaskQueue;
let lock: TaskLock;

const createTestTask = (overrides: Partial<Task> = {}): Task => ({
  id: crypto.randomUUID(),
  name: "test-task",
  input: { data: "test" },
  status: "pending",
  priority: 50,
  createdAt: Date.now(),
  scheduledFor: Date.now(),
  attempt: 0,
  maxAttempts: 3,
  ...overrides,
});

describe("Task Storage", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-storage");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    storage = createTaskStorage(kv);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("store and get", () => {
    it("should store and retrieve a task", async () => {
      const task = createTestTask({ name: "store-get-test" });

      await storage.store(task);
      const retrieved = await storage.get(task.id);

      expect(retrieved).not.toBeNull();
      expect(retrieved?.id).toBe(task.id);
      expect(retrieved?.name).toBe("store-get-test");
      expect(retrieved?.status).toBe("pending");
      expect(retrieved?.input).toEqual({ data: "test" });
    });

    it("should return null for non-existent task", async () => {
      const retrieved = await storage.get("nonexistent");
      expect(retrieved).toBeNull();
    });

    it("should store task with all optional fields", async () => {
      const task = createTestTask({
        startedAt: Date.now(),
        completedAt: Date.now() + 1000,
        workerId: "worker-1",
        lastError: "Test error",
        result: { success: true },
        idempotencyKey: "idem-key",
        recurring: { cron: "0 * * * *", timezone: "UTC" },
      });

      await storage.store(task);
      const retrieved = await storage.get(task.id);

      expect(retrieved?.startedAt).toBe(task.startedAt);
      expect(retrieved?.completedAt).toBe(task.completedAt);
      expect(retrieved?.workerId).toBe("worker-1");
      expect(retrieved?.lastError).toBe("Test error");
      expect(retrieved?.result).toEqual({ success: true });
      expect(retrieved?.idempotencyKey).toBe("idem-key");
      expect(retrieved?.recurring).toEqual({ cron: "0 * * * *", timezone: "UTC" });
    });

    it("should store complex input objects", async () => {
      const task = createTestTask({
        input: {
          nested: { deeply: { value: "test" } },
          array: [1, 2, { key: "value" }],
          nullValue: null,
          number: 42,
        },
      });

      await storage.store(task);
      const retrieved = await storage.get(task.id);

      expect(retrieved?.input).toEqual(task.input);
    });
  });

  describe("update", () => {
    it("should update task fields", async () => {
      const task = createTestTask();
      await storage.store(task);

      await storage.update(task.id, { status: "running", workerId: "worker-1" });

      const retrieved = await storage.get(task.id);
      expect(retrieved?.status).toBe("running");
      expect(retrieved?.workerId).toBe("worker-1");
    });

    it("should not fail for non-existent task", async () => {
      await expect(
        storage.update("nonexistent", { status: "running" })
      ).resolves.not.toThrow();
    });

    it("should preserve unchanged fields", async () => {
      const task = createTestTask({ name: "preserve-test", priority: 75 });
      await storage.store(task);

      await storage.update(task.id, { status: "running" });

      const retrieved = await storage.get(task.id);
      expect(retrieved?.name).toBe("preserve-test");
      expect(retrieved?.priority).toBe(75);
    });
  });

  describe("updateStatus", () => {
    it("should update status and maintain indexes", async () => {
      const task = createTestTask({ status: "pending" });
      await storage.store(task);

      await storage.updateStatus(task.id, "pending", "running");

      const retrieved = await storage.get(task.id);
      expect(retrieved?.status).toBe("running");

      const pending = await storage.query({ status: "pending" });
      const running = await storage.query({ status: "running" });

      expect(pending.find((t) => t.id === task.id)).toBeUndefined();
      expect(running.find((t) => t.id === task.id)).toBeDefined();
    });

    it("should apply additional updates with status change", async () => {
      const task = createTestTask({ status: "pending" });
      await storage.store(task);

      await storage.updateStatus(task.id, "pending", "running", {
        workerId: "worker-1",
        startedAt: Date.now(),
      });

      const retrieved = await storage.get(task.id);
      expect(retrieved?.status).toBe("running");
      expect(retrieved?.workerId).toBe("worker-1");
      expect(retrieved?.startedAt).toBeDefined();
    });
  });

  describe("delete", () => {
    it("should delete a task", async () => {
      const task = createTestTask();
      await storage.store(task);

      await storage.delete(task.id);

      const retrieved = await storage.get(task.id);
      expect(retrieved).toBeNull();
    });

    it("should remove from indexes", async () => {
      const task = createTestTask({ status: "pending", name: "delete-index-test" });
      await storage.store(task);

      await storage.delete(task.id);

      const byStatus = await storage.query({ status: "pending" });
      const byName = await storage.query({ name: "delete-index-test" });

      expect(byStatus.find((t) => t.id === task.id)).toBeUndefined();
      expect(byName.find((t) => t.id === task.id)).toBeUndefined();
    });

    it("should handle non-existent task", async () => {
      await expect(storage.delete("nonexistent")).resolves.not.toThrow();
    });

    it("should clean up idempotency key", async () => {
      const task = createTestTask({ idempotencyKey: "delete-idem-key" });
      await storage.store(task);

      await storage.delete(task.id);

      const found = await storage.findByIdempotencyKey("delete-idem-key");
      expect(found).toBeNull();
    });
  });

  describe("query", () => {
    it("should filter by single status", async () => {
      await storage.store(createTestTask({ id: "t1", status: "pending" }));
      await storage.store(createTestTask({ id: "t2", status: "running" }));
      await storage.store(createTestTask({ id: "t3", status: "pending" }));

      const results = await storage.query({ status: "pending" });

      expect(results).toHaveLength(2);
      expect(results.every((t) => t.status === "pending")).toBe(true);
    });

    it("should filter by multiple statuses", async () => {
      await storage.store(createTestTask({ id: "t1", status: "pending" }));
      await storage.store(createTestTask({ id: "t2", status: "running" }));
      await storage.store(createTestTask({ id: "t3", status: "completed" }));

      const results = await storage.query({ status: ["pending", "running"] });

      expect(results).toHaveLength(2);
    });

    it("should filter by name", async () => {
      await storage.store(createTestTask({ id: "t1", name: "task-a" }));
      await storage.store(createTestTask({ id: "t2", name: "task-b" }));
      await storage.store(createTestTask({ id: "t3", name: "task-a" }));

      const results = await storage.query({ name: "task-a" });

      expect(results).toHaveLength(2);
      expect(results.every((t) => t.name === "task-a")).toBe(true);
    });

    it("should filter by multiple names", async () => {
      await storage.store(createTestTask({ id: "t1", name: "task-a" }));
      await storage.store(createTestTask({ id: "t2", name: "task-b" }));
      await storage.store(createTestTask({ id: "t3", name: "task-c" }));

      const results = await storage.query({ name: ["task-a", "task-b"] });

      expect(results).toHaveLength(2);
    });

    it("should combine status and name filters", async () => {
      await storage.store(createTestTask({ id: "t1", name: "task-a", status: "pending" }));
      await storage.store(createTestTask({ id: "t2", name: "task-a", status: "running" }));
      await storage.store(createTestTask({ id: "t3", name: "task-b", status: "pending" }));

      const results = await storage.query({ status: "pending", name: "task-a" });

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("t1");
    });

    it("should filter by createdAfter", async () => {
      const now = Date.now();
      await storage.store(createTestTask({ id: "t1", createdAt: now - 1000 }));
      await storage.store(createTestTask({ id: "t2", createdAt: now }));
      await storage.store(createTestTask({ id: "t3", createdAt: now + 1000 }));

      const results = await storage.query({ createdAfter: new Date(now) });

      expect(results).toHaveLength(2);
    });

    it("should filter by createdBefore", async () => {
      const now = Date.now();
      await storage.store(createTestTask({ id: "t1", createdAt: now - 2000 }));
      await storage.store(createTestTask({ id: "t2", createdAt: now - 1000 }));
      await storage.store(createTestTask({ id: "t3", createdAt: now + 1000 }));

      const results = await storage.query({ createdBefore: new Date(now) });

      expect(results).toHaveLength(2);
    });

    it("should apply limit", async () => {
      for (let i = 0; i < 10; i++) {
        await storage.store(createTestTask({ id: `t${i}` }));
      }

      const results = await storage.query({ limit: 5 });

      expect(results).toHaveLength(5);
    });

    it("should apply offset", async () => {
      for (let i = 0; i < 10; i++) {
        await storage.store(createTestTask({ id: `t${i}`, createdAt: Date.now() + i }));
      }

      const page1 = await storage.query({ limit: 5, offset: 0 });
      const page2 = await storage.query({ limit: 5, offset: 5 });

      expect(page1).toHaveLength(5);
      expect(page2).toHaveLength(5);

      const ids1 = page1.map((t) => t.id);
      const ids2 = page2.map((t) => t.id);
      expect(ids1.some((id) => ids2.includes(id))).toBe(false);
    });

    it("should return all tasks when no filters", async () => {
      await storage.store(createTestTask({ id: "t1", status: "pending" }));
      await storage.store(createTestTask({ id: "t2", status: "running" }));
      await storage.store(createTestTask({ id: "t3", status: "completed" }));

      const results = await storage.query({});

      expect(results).toHaveLength(3);
    });

    it("should sort by createdAt descending", async () => {
      const now = Date.now();
      await storage.store(createTestTask({ id: "oldest", createdAt: now - 2000 }));
      await storage.store(createTestTask({ id: "middle", createdAt: now - 1000 }));
      await storage.store(createTestTask({ id: "newest", createdAt: now }));

      const results = await storage.query({});

      expect(results[0].id).toBe("newest");
      expect(results[1].id).toBe("middle");
      expect(results[2].id).toBe("oldest");
    });
  });

  describe("findByIdempotencyKey", () => {
    it("should find task by idempotency key", async () => {
      const task = createTestTask({ idempotencyKey: "unique-key-123" });
      await storage.store(task);

      const found = await storage.findByIdempotencyKey("unique-key-123");

      expect(found).not.toBeNull();
      expect(found?.id).toBe(task.id);
    });

    it("should return null for non-existent key", async () => {
      const found = await storage.findByIdempotencyKey("nonexistent-key");
      expect(found).toBeNull();
    });
  });

  describe("setIdempotencyKey", () => {
    it("should set idempotency key with TTL", async () => {
      const task = createTestTask();
      await storage.store(task);

      await storage.setIdempotencyKey("manual-key", task.id, 60000);

      const found = await storage.findByIdempotencyKey("manual-key");
      expect(found?.id).toBe(task.id);
    });
  });
});

describe("Task Queue", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-queue");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    storage = createTaskStorage(kv);
    queue = createTaskQueue(kv);
    lock = createTaskLock(kv);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("add and claimNext", () => {
    it("should add task to queue", async () => {
      const task = createTestTask();
      await storage.store(task);

      await queue.add(task.id, task.priority, task.scheduledFor);

      const depth = await queue.getQueueDepth();
      expect(depth).toBe(1);
    });

    it("should claim task from queue", async () => {
      const task = createTestTask();
      await storage.store(task);
      await queue.add(task.id, task.priority, task.scheduledFor);

      const claimed = await queue.claimNext("worker-1");

      expect(claimed).not.toBeNull();
      expect(claimed?.id).toBe(task.id);
    });

    it("should respect scheduled time", async () => {
      const futureTask = createTestTask({ scheduledFor: Date.now() + 60000 });
      await storage.store(futureTask);
      await queue.add(futureTask.id, futureTask.priority, futureTask.scheduledFor);

      const claimed = await queue.claimNext("worker-1");

      expect(claimed).toBeNull();
    });

    it("should return null for empty queue", async () => {
      const claimed = await queue.claimNext("worker-1");
      expect(claimed).toBeNull();
    });

    it("should process by priority", async () => {
      const lowPriority = createTestTask({ id: "low", priority: 25 });
      const highPriority = createTestTask({ id: "high", priority: 75 });
      const medPriority = createTestTask({ id: "med", priority: 50 });

      await storage.store(lowPriority);
      await storage.store(highPriority);
      await storage.store(medPriority);

      await queue.add(lowPriority.id, lowPriority.priority, lowPriority.scheduledFor);
      await queue.add(highPriority.id, highPriority.priority, highPriority.scheduledFor);
      await queue.add(medPriority.id, medPriority.priority, medPriority.scheduledFor);

      const first = await queue.claimNext("worker-1");

      expect(first?.id).toBe("low");
    });

    it("should filter by task types", async () => {
      const taskA = createTestTask({ id: "a", name: "type-a" });
      const taskB = createTestTask({ id: "b", name: "type-b" });

      await storage.store(taskA);
      await storage.store(taskB);
      await queue.add(taskA.id, taskA.priority, taskA.scheduledFor);
      await queue.add(taskB.id, taskB.priority, taskB.scheduledFor);

      const claimed = await queue.claimNext("worker-1", ["type-b"]);

      expect(claimed?.name).toBe("type-b");
    });
  });

  describe("remove", () => {
    it("should remove task from queue", async () => {
      const task = createTestTask();
      await storage.store(task);
      await queue.add(task.id, task.priority, task.scheduledFor);

      await queue.remove(task.id, task.priority);

      const depth = await queue.getQueueDepth();
      expect(depth).toBe(0);
    });
  });

  describe("getQueueDepth", () => {
    it("should return total depth across priority buckets", async () => {
      const tasks = [
        createTestTask({ id: "t1", priority: 10 }),
        createTestTask({ id: "t2", priority: 50 }),
        createTestTask({ id: "t3", priority: 90 }),
      ];

      for (const task of tasks) {
        await storage.store(task);
        await queue.add(task.id, task.priority, task.scheduledFor);
      }

      const depth = await queue.getQueueDepth();
      expect(depth).toBe(3);
    });

    it("should return depth for specific priority", async () => {
      const tasks = [
        createTestTask({ id: "t1", priority: 10 }),
        createTestTask({ id: "t2", priority: 10 }),
        createTestTask({ id: "t3", priority: 90 }),
      ];

      for (const task of tasks) {
        await storage.store(task);
        await queue.add(task.id, task.priority, task.scheduledFor);
      }

      const lowDepth = await queue.getQueueDepth(25);
      const highDepth = await queue.getQueueDepth(100);

      expect(lowDepth).toBe(2);
      expect(highDepth).toBe(1);
    });
  });

  describe("getScheduledTasks", () => {
    it("should return scheduled task IDs", async () => {
      for (let i = 0; i < 5; i++) {
        const task = createTestTask({ id: `t${i}` });
        await storage.store(task);
        await queue.add(task.id, task.priority, task.scheduledFor);
      }

      const scheduled = await queue.getScheduledTasks();

      expect(scheduled).toHaveLength(5);
    });

    it("should limit results", async () => {
      for (let i = 0; i < 10; i++) {
        const task = createTestTask({ id: `t${i}` });
        await storage.store(task);
        await queue.add(task.id, task.priority, task.scheduledFor);
      }

      const scheduled = await queue.getScheduledTasks(5);

      expect(scheduled).toHaveLength(5);
    });
  });
});

describe("Task Lock", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-lock");
    await kv.connect();
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  beforeEach(async () => {
    lock = createTaskLock(kv);

    const allKeys = await kv.keys("*");
    for (const key of allKeys) {
      await kv.del(key);
    }
  });

  describe("acquire", () => {
    it("should acquire lock", async () => {
      const acquired = await lock.acquire("task-1", "worker-1");
      expect(acquired).toBe(true);
    });

    it("should not acquire if already held by another worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const acquired = await lock.acquire("task-1", "worker-2");
      expect(acquired).toBe(false);
    });

    it("should allow same worker to re-acquire", async () => {
      await lock.acquire("task-1", "worker-1");
      const acquired = await lock.acquire("task-1", "worker-1");
      expect(acquired).toBe(true);
    });
  });

  describe("extend", () => {
    it("should extend lock held by worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const extended = await lock.extend("task-1", "worker-1");
      expect(extended).toBe(true);
    });

    it("should not extend lock held by another worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const extended = await lock.extend("task-1", "worker-2");
      expect(extended).toBe(false);
    });

    it("should not extend non-existent lock", async () => {
      const extended = await lock.extend("task-1", "worker-1");
      expect(extended).toBe(false);
    });
  });

  describe("release", () => {
    it("should release lock", async () => {
      await lock.acquire("task-1", "worker-1");
      const released = await lock.release("task-1", "worker-1");
      expect(released).toBe(true);

      const acquired = await lock.acquire("task-1", "worker-2");
      expect(acquired).toBe(true);
    });

    it("should not release lock held by another worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const released = await lock.release("task-1", "worker-2");
      expect(released).toBe(false);
    });
  });

  describe("isHeld", () => {
    it("should return true if lock is held by worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const held = await lock.isHeld("task-1", "worker-1");
      expect(held).toBe(true);
    });

    it("should return false if lock is not held", async () => {
      const held = await lock.isHeld("task-1", "worker-1");
      expect(held).toBe(false);
    });

    it("should return false if lock is held by another worker", async () => {
      await lock.acquire("task-1", "worker-1");
      const held = await lock.isHeld("task-1", "worker-2");
      expect(held).toBe(false);
    });
  });
});
