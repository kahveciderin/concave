import { describe, it, expect, beforeEach, beforeAll, afterAll, vi } from "vitest";
import {
  createTaskTriggerHooks,
  composeHooks,
  ResourceTaskConfig,
} from "@/tasks/integration";
import {
  createTaskScheduler,
  createTaskRegistry,
  initializeTasks,
  getTaskScheduler,
  TaskScheduler,
  TaskRegistry,
} from "@/tasks/scheduler";
import { defineTask } from "@/tasks/define";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";
import { ProcedureContext, LifecycleHooks } from "@/resource/types";

let kv: KVAdapter;
let scheduler: TaskScheduler;
let registry: TaskRegistry;

interface MockTableConfig {
  columns: Record<string, unknown>;
}

const createMockContext = (
  user?: { id: string }
): ProcedureContext<MockTableConfig> =>
  ({
    user,
    schema: { _: { name: "test-resource" } },
    db: {},
    req: {} as never,
    res: {} as never,
  }) as unknown as ProcedureContext<MockTableConfig>;

describe("Task Integration", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-integration");
    await kv.connect();
    setGlobalKV(kv);
    initializeTasks(kv);
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

  describe("createTaskTriggerHooks", () => {
    describe("onCreate", () => {
      it("should trigger tasks on create", async () => {
        const sendWelcomeTask = defineTask({
          name: "send-welcome",
          handler: async () => undefined,
        });
        registry.register(sendWelcomeTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [{ task: sendWelcomeTask }],
        });

        const ctx = createMockContext({ id: "user-1" });
        const createdData = { id: "item-1", name: "Test" };

        await hooks.onAfterCreate?.(ctx, createdData);

        const tasks = await scheduler.getTasks({ name: "send-welcome" });
        expect(tasks).toHaveLength(1);
      });

      it("should pass default input structure", async () => {
        const captureTask = defineTask({
          name: "capture-input",
          handler: async () => undefined,
        });
        registry.register(captureTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [{ task: captureTask }],
        });

        const ctx = createMockContext({ id: "user-1" });
        const createdData = { id: "item-1", name: "Test" };

        await hooks.onAfterCreate?.(ctx, createdData);

        const tasks = await scheduler.getTasks({ name: "capture-input" });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].input).toEqual({
          event: "create",
          resource: "test-resource",
          data: createdData,
          userId: "user-1",
        });
      });

      it("should use custom transform for input", async () => {
        const customTask = defineTask({
          name: "custom-transform",
          handler: async () => undefined,
        });
        registry.register(customTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [
            {
              task: customTask,
              transform: (data: { id: string; name: string }) => ({
                itemId: data.id,
                itemName: data.name,
              }),
            },
          ],
        });

        const ctx = createMockContext();
        await hooks.onAfterCreate?.(ctx, { id: "item-1", name: "Test" });

        const tasks = await scheduler.getTasks({ name: "custom-transform" });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].input).toEqual({ itemId: "item-1", itemName: "Test" });
      });

      it("should respect when condition", async () => {
        const conditionalTask = defineTask({
          name: "conditional-create",
          handler: async () => undefined,
        });
        registry.register(conditionalTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [
            {
              task: conditionalTask,
              when: (data: { type: string }) => data.type === "special",
            },
          ],
        });

        const ctx = createMockContext();

        await hooks.onAfterCreate?.(ctx, { id: "1", type: "normal" });
        let tasks = await scheduler.getTasks({ name: "conditional-create" });
        expect(tasks).toHaveLength(0);

        await hooks.onAfterCreate?.(ctx, { id: "2", type: "special" });
        tasks = await scheduler.getTasks({ name: "conditional-create" });
        expect(tasks).toHaveLength(1);
      });

      it("should schedule with delay", async () => {
        const delayedTask = defineTask({
          name: "delayed-create",
          handler: async () => undefined,
        });
        registry.register(delayedTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [{ task: delayedTask, delay: 5000 }],
        });

        const ctx = createMockContext();
        const before = Date.now();
        await hooks.onAfterCreate?.(ctx, { id: "1" });

        const tasks = await scheduler.getTasks({ name: "delayed-create" });
        expect(tasks).toHaveLength(1);
        expect(tasks[0].scheduledFor).toBeGreaterThanOrEqual(before + 5000);
      });

      it("should trigger multiple tasks", async () => {
        const task1 = defineTask({ name: "multi-1", handler: async () => undefined });
        const task2 = defineTask({ name: "multi-2", handler: async () => undefined });
        const task3 = defineTask({ name: "multi-3", handler: async () => undefined });
        registry.register(task1);
        registry.register(task2);
        registry.register(task3);

        const hooks = createTaskTriggerHooks(scheduler, {
          onCreate: [{ task: task1 }, { task: task2 }, { task: task3 }],
        });

        const ctx = createMockContext();
        await hooks.onAfterCreate?.(ctx, { id: "1" });

        const all = await scheduler.getTasks({});
        expect(all).toHaveLength(3);
      });
    });

    describe("onUpdate", () => {
      it("should trigger tasks on update", async () => {
        const updateTask = defineTask({
          name: "on-update",
          handler: async () => undefined,
        });
        registry.register(updateTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onUpdate: [{ task: updateTask }],
        });

        const ctx = createMockContext();
        await hooks.onAfterUpdate?.(ctx, { id: "1", name: "Updated" });

        const tasks = await scheduler.getTasks({ name: "on-update" });
        expect(tasks).toHaveLength(1);
      });

      it("should include update event in default input", async () => {
        const captureTask = defineTask({
          name: "capture-update",
          handler: async () => undefined,
        });
        registry.register(captureTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onUpdate: [{ task: captureTask }],
        });

        const ctx = createMockContext({ id: "user-1" });
        await hooks.onAfterUpdate?.(ctx, { id: "1", name: "Updated" });

        const tasks = await scheduler.getTasks({ name: "capture-update" });
        expect(tasks).toHaveLength(1);
        expect((tasks[0].input as { event: string }).event).toBe("update");
      });
    });

    describe("onDelete", () => {
      it("should trigger tasks on delete", async () => {
        const deleteTask = defineTask({
          name: "on-delete",
          handler: async () => undefined,
        });
        registry.register(deleteTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onDelete: [{ task: deleteTask }],
        });

        const ctx = createMockContext();
        await hooks.onAfterDelete?.(ctx, { id: "1", name: "Deleted" });

        const tasks = await scheduler.getTasks({ name: "on-delete" });
        expect(tasks).toHaveLength(1);
      });

      it("should include delete event in default input", async () => {
        const captureTask = defineTask({
          name: "capture-delete",
          handler: async () => undefined,
        });
        registry.register(captureTask);

        const hooks = createTaskTriggerHooks(scheduler, {
          onDelete: [{ task: captureTask }],
        });

        const ctx = createMockContext({ id: "user-1" });
        await hooks.onAfterDelete?.(ctx, { id: "1" });

        const tasks = await scheduler.getTasks({ name: "capture-delete" });
        expect(tasks).toHaveLength(1);
        expect((tasks[0].input as { event: string }).event).toBe("delete");
      });
    });

    describe("using global scheduler", () => {
      it("should use global scheduler when not provided", async () => {
        const globalTask = defineTask({
          name: "global-scheduler",
          handler: async () => undefined,
        });

        const globalRegistry = createTaskRegistry();
        globalRegistry.register(globalTask);

        const hooks = createTaskTriggerHooks({
          onCreate: [{ task: globalTask }],
        });

        const ctx = createMockContext();
        await hooks.onAfterCreate?.(ctx, { id: "1" });

        const globalScheduler = getTaskScheduler();
        const tasks = await globalScheduler.getTasks({ name: "global-scheduler" });
        expect(tasks.length).toBeGreaterThanOrEqual(1);
      });
    });
  });

  describe("composeHooks", () => {
    it("should compose multiple hooks", async () => {
      let hook1Called = false;
      let hook2Called = false;

      const hooks1: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {
          hook1Called = true;
        },
      };

      const hooks2: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {
          hook2Called = true;
        },
      };

      const composed = composeHooks(hooks1, hooks2);

      const ctx = createMockContext();
      await composed.onAfterCreate?.(ctx, { id: "1" });

      expect(hook1Called).toBe(true);
      expect(hook2Called).toBe(true);
    });

    it("should handle undefined hooks", async () => {
      const hooks1: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {},
      };

      const composed = composeHooks(hooks1, undefined, undefined);

      expect(composed.onAfterCreate).toBeDefined();
      expect(composed.onAfterUpdate).toBeUndefined();
    });

    it("should transform data in onBeforeCreate", async () => {
      const hooks1: LifecycleHooks<MockTableConfig> = {
        onBeforeCreate: async (ctx, data: { name: string }) => ({
          ...data,
          createdAt: new Date(),
        }),
      };

      const hooks2: LifecycleHooks<MockTableConfig> = {
        onBeforeCreate: async (ctx, data: { name: string; createdAt: Date }) => ({
          ...data,
          processed: true,
        }),
      };

      const composed = composeHooks(hooks1, hooks2);

      const ctx = createMockContext();
      const result = await composed.onBeforeCreate?.(ctx, { name: "Test" });

      expect(result).toHaveProperty("name", "Test");
      expect(result).toHaveProperty("createdAt");
      expect(result).toHaveProperty("processed", true);
    });

    it("should transform data in onBeforeUpdate", async () => {
      const hooks1: LifecycleHooks<MockTableConfig> = {
        onBeforeUpdate: async (ctx, data: { name: string }) => ({
          ...data,
          updatedAt: new Date(),
        }),
      };

      const composed = composeHooks(hooks1);

      const ctx = createMockContext();
      const result = await composed.onBeforeUpdate?.(ctx, { name: "Updated" });

      expect(result).toHaveProperty("name", "Updated");
      expect(result).toHaveProperty("updatedAt");
    });

    it("should call hooks in order", async () => {
      const order: number[] = [];

      const hooks1: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {
          order.push(1);
        },
      };

      const hooks2: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {
          order.push(2);
        },
      };

      const hooks3: LifecycleHooks<MockTableConfig> = {
        onAfterCreate: async () => {
          order.push(3);
        },
      };

      const composed = composeHooks(hooks1, hooks2, hooks3);

      const ctx = createMockContext();
      await composed.onAfterCreate?.(ctx, { id: "1" });

      expect(order).toEqual([1, 2, 3]);
    });

    it("should compose all lifecycle hooks", async () => {
      const calls: string[] = [];

      const hooks1: LifecycleHooks<MockTableConfig> = {
        onBeforeCreate: async () => {
          calls.push("before-create-1");
        },
        onAfterCreate: async () => {
          calls.push("after-create-1");
        },
        onBeforeUpdate: async () => {
          calls.push("before-update-1");
        },
        onAfterUpdate: async () => {
          calls.push("after-update-1");
        },
        onBeforeDelete: async () => {
          calls.push("before-delete-1");
        },
        onAfterDelete: async () => {
          calls.push("after-delete-1");
        },
      };

      const hooks2: LifecycleHooks<MockTableConfig> = {
        onBeforeCreate: async () => {
          calls.push("before-create-2");
        },
        onAfterCreate: async () => {
          calls.push("after-create-2");
        },
        onBeforeUpdate: async () => {
          calls.push("before-update-2");
        },
        onAfterUpdate: async () => {
          calls.push("after-update-2");
        },
        onBeforeDelete: async () => {
          calls.push("before-delete-2");
        },
        onAfterDelete: async () => {
          calls.push("after-delete-2");
        },
      };

      const composed = composeHooks(hooks1, hooks2);

      const ctx = createMockContext();

      await composed.onBeforeCreate?.(ctx, {});
      await composed.onAfterCreate?.(ctx, { id: "1" });
      await composed.onBeforeUpdate?.(ctx, {});
      await composed.onAfterUpdate?.(ctx, { id: "1" });
      await composed.onBeforeDelete?.(ctx, { id: "1" });
      await composed.onAfterDelete?.(ctx, { id: "1" });

      expect(calls).toContain("before-create-1");
      expect(calls).toContain("before-create-2");
      expect(calls).toContain("after-create-1");
      expect(calls).toContain("after-create-2");
      expect(calls).toContain("before-update-1");
      expect(calls).toContain("before-update-2");
      expect(calls).toContain("after-update-1");
      expect(calls).toContain("after-update-2");
      expect(calls).toContain("before-delete-1");
      expect(calls).toContain("before-delete-2");
      expect(calls).toContain("after-delete-1");
      expect(calls).toContain("after-delete-2");
    });

    it("should combine task hooks with custom hooks", async () => {
      const auditTask = defineTask({
        name: "audit-log",
        handler: async () => undefined,
      });
      registry.register(auditTask);

      let customHookCalled = false;

      const taskHooks = createTaskTriggerHooks(scheduler, {
        onCreate: [{ task: auditTask }],
      });

      const customHooks: LifecycleHooks<MockTableConfig> = {
        onBeforeCreate: async (ctx, data) => ({
          ...data,
          timestamp: Date.now(),
        }),
        onAfterCreate: async () => {
          customHookCalled = true;
        },
      };

      const composed = composeHooks(taskHooks, customHooks);

      const ctx = createMockContext();
      const transformed = await composed.onBeforeCreate?.(ctx, { name: "Test" });
      await composed.onAfterCreate?.(ctx, { id: "1" });

      expect(transformed).toHaveProperty("timestamp");
      expect(customHookCalled).toBe(true);

      const tasks = await scheduler.getTasks({ name: "audit-log" });
      expect(tasks).toHaveLength(1);
    });
  });

  describe("edge cases", () => {
    it("should handle empty config", async () => {
      const hooks = createTaskTriggerHooks(scheduler, {});

      expect(hooks.onAfterCreate).toBeUndefined();
      expect(hooks.onAfterUpdate).toBeUndefined();
      expect(hooks.onAfterDelete).toBeUndefined();
    });

    it("should handle null user in context", async () => {
      const task = defineTask({
        name: "null-user",
        handler: async () => undefined,
      });
      registry.register(task);

      const hooks = createTaskTriggerHooks(scheduler, {
        onCreate: [{ task }],
      });

      const ctx = createMockContext(undefined);
      await hooks.onAfterCreate?.(ctx, { id: "1" });

      const tasks = await scheduler.getTasks({ name: "null-user" });
      expect(tasks).toHaveLength(1);
      expect((tasks[0].input as { userId: unknown }).userId).toBeUndefined();
    });

    it("should handle complex transform function", async () => {
      const task = defineTask({
        name: "complex-transform",
        handler: async () => undefined,
      });
      registry.register(task);

      const hooks = createTaskTriggerHooks(scheduler, {
        onCreate: [
          {
            task,
            transform: (data: { id: string; nested?: { value: number } }) => ({
              processed: true,
              original: data,
              computed: (data.nested?.value ?? 0) * 2,
            }),
          },
        ],
      });

      const ctx = createMockContext();
      await hooks.onAfterCreate?.(ctx, { id: "1", nested: { value: 21 } });

      const tasks = await scheduler.getTasks({ name: "complex-transform" });
      expect(tasks).toHaveLength(1);
      expect(tasks[0].input).toEqual({
        processed: true,
        original: { id: "1", nested: { value: 21 } },
        computed: 42,
      });
    });

    it("should handle when function that throws", async () => {
      const task = defineTask({
        name: "when-throws",
        handler: async () => undefined,
      });
      registry.register(task);

      const hooks = createTaskTriggerHooks(scheduler, {
        onCreate: [
          {
            task,
            when: () => {
              throw new Error("When function error");
            },
          },
        ],
      });

      const ctx = createMockContext();

      await expect(
        hooks.onAfterCreate?.(ctx, { id: "1" })
      ).rejects.toThrow("When function error");
    });
  });
});
