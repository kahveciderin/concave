import { KVAdapter } from "@/kv/types";
import {
  Task,
  TaskContext,
  TaskDefinition,
  WorkerConfig,
  WorkerStats,
} from "./types";
import { createTaskLock } from "./lock";
import { createTaskQueue } from "./queue";
import { createTaskStorage } from "./storage";
import { createDeadLetterQueue } from "./dlq";
import { calculateBackoff, shouldRetry } from "./retry";
import { TaskRegistry } from "./scheduler";

const WORKERS_KEY = "concave:tasks:workers";
const NOTIFY_CHANNEL = "concave:tasks:notify";

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export interface TaskWorker {
  start(): Promise<void>;
  stop(): Promise<void>;
  pause(): void;
  resume(): void;
  getStats(): WorkerStats;
}

export const createTaskWorker = (
  kv: KVAdapter,
  registry: TaskRegistry,
  config: WorkerConfig = {}
): TaskWorker => {
  const workerId = config.id ?? `worker-${crypto.randomUUID().slice(0, 8)}`;
  const concurrency = config.concurrency ?? 5;
  const pollInterval = config.pollIntervalMs ?? 1000;
  const lockTtl = Math.ceil((config.lockTtlMs ?? 30000) / 1000);
  const heartbeatInterval = config.heartbeatMs ?? 10000;

  const lock = createTaskLock(kv);
  const queue = createTaskQueue(kv);
  const storage = createTaskStorage(kv);

  let running = false;
  let paused = false;
  let processedCount = 0;
  let failedCount = 0;
  const startTime = Date.now();
  const activeTasks = new Map<string, AbortController>();

  const requeue = async (task: Task): Promise<string> => {
    await storage.store(task);
    await queue.add(task.id, task.priority, task.scheduledFor);
    return task.id;
  };

  const dlq = createDeadLetterQueue(kv, requeue);

  const handleTaskError = async (
    task: Task,
    error: Error,
    definition: TaskDefinition
  ): Promise<void> => {
    const nextAttempt = task.attempt + 1;
    const retryConfig = definition.retry ?? {};

    if (shouldRetry(error, nextAttempt, task.maxAttempts, retryConfig)) {
      const backoff = calculateBackoff(nextAttempt, retryConfig);
      const scheduledFor = Date.now() + backoff;

      await storage.updateStatus(task.id, "running", "scheduled", {
        attempt: nextAttempt,
        scheduledFor,
        lastError: error.message,
        workerId: undefined,
      });

      await queue.add(task.id, task.priority, scheduledFor);
    } else {
      await dlq.add(task, error.message);
      failedCount++;
    }
  };

  const processTask = async (task: Task): Promise<void> => {
    const definition = registry.get(task.name);
    if (!definition) {
      await dlq.add(task, `Unknown task type: ${task.name}`);
      failedCount++;
      return;
    }

    const controller = new AbortController();
    activeTasks.set(task.id, controller);

    const heartbeat = setInterval(async () => {
      const extended = await lock.extend(task.id, workerId, lockTtl);
      if (!extended) {
        controller.abort();
      }
    }, heartbeatInterval);

    try {
      await storage.updateStatus(task.id, task.status, "running", {
        workerId,
        startedAt: Date.now(),
      });

      const ctx: TaskContext = {
        taskId: task.id,
        attempt: task.attempt + 1,
        scheduledAt: new Date(task.scheduledFor),
        startedAt: new Date(),
        workerId,
        signal: controller.signal,
      };

      const timeoutMs = definition.timeout ?? 30000;
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Task timeout")), timeoutMs)
      );

      const result = await Promise.race([
        definition.handler(ctx, task.input),
        timeoutPromise,
      ]);

      await storage.updateStatus(task.id, "running", "completed", {
        result,
        completedAt: Date.now(),
      });

      processedCount++;
    } catch (error) {
      if (controller.signal.aborted) {
        await storage.updateStatus(task.id, "running", "scheduled", {
          lastError: "Worker lost lock",
          workerId: undefined,
        });
        await queue.add(task.id, task.priority, Date.now());
      } else {
        await handleTaskError(task, error as Error, definition);
      }
    } finally {
      clearInterval(heartbeat);
      activeTasks.delete(task.id);
      await lock.release(task.id, workerId);
    }
  };

  const poll = async (): Promise<void> => {
    while (running && !paused) {
      if (activeTasks.size >= concurrency) {
        await sleep(100);
        continue;
      }

      const task = await queue.claimNext(workerId, config.taskTypes);
      if (task) {
        processTask(task).catch((err) =>
          console.error(`Task ${task.id} error:`, err)
        );
      } else {
        await sleep(pollInterval);
      }
    }
  };

  return {
    async start(): Promise<void> {
      running = true;

      await kv.sadd(WORKERS_KEY, workerId);

      try {
        await kv.subscribe(NOTIFY_CHANNEL, () => {
          // Wake up if needed - the poll loop handles this
        });
      } catch {
        // Pub/sub might not be available in memory mode
      }

      poll();
    },

    async stop(): Promise<void> {
      running = false;

      for (const [taskId, controller] of activeTasks) {
        controller.abort();
        await lock.release(taskId, workerId);
      }

      try {
        await kv.unsubscribe(NOTIFY_CHANNEL);
      } catch {
        // Ignore
      }

      await kv.srem(WORKERS_KEY, workerId);
    },

    pause(): void {
      paused = true;
    },

    resume(): void {
      paused = false;
    },

    getStats(): WorkerStats {
      return {
        id: workerId,
        status: running ? (paused ? "paused" : "running") : "stopped",
        activeTasks: activeTasks.size,
        processedCount,
        failedCount,
        uptime: Date.now() - startTime,
      };
    },
  };
};

export const startTaskWorkers = async (
  kv: KVAdapter,
  registry: TaskRegistry,
  count: number = 1,
  config: Omit<WorkerConfig, "id"> = {}
): Promise<TaskWorker[]> => {
  const workers: TaskWorker[] = [];

  for (let i = 0; i < count; i++) {
    const worker = createTaskWorker(kv, registry, {
      ...config,
      id: `worker-${i}-${crypto.randomUUID().slice(0, 8)}`,
    });
    await worker.start();
    workers.push(worker);
  }

  return workers;
};
