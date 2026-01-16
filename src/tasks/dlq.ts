import { KVAdapter } from "@/kv/types";
import { Task, DeadLetterEntry } from "./types";
import { createTaskStorage } from "./storage";

const DEAD_LETTER_KEY = "concave:tasks:dead";
const DLQ_DATA_PREFIX = "concave:tasks:dead:data:";

const serializeDLQEntry = (entry: DeadLetterEntry): Record<string, string> => ({
  taskId: entry.taskId,
  task: JSON.stringify(entry.task),
  failedAt: String(entry.failedAt),
  reason: entry.reason,
  attempts: String(entry.attempts),
});

const deserializeDLQEntry = (data: Record<string, string>): DeadLetterEntry => ({
  taskId: data.taskId,
  task: JSON.parse(data.task),
  failedAt: parseInt(data.failedAt, 10),
  reason: data.reason,
  attempts: parseInt(data.attempts, 10),
});

export interface DeadLetterQueue {
  add(task: Task, reason: string): Promise<void>;
  list(limit?: number, offset?: number): Promise<DeadLetterEntry[]>;
  get(taskId: string): Promise<DeadLetterEntry | null>;
  retry(taskId: string): Promise<string | null>;
  retryAll(): Promise<number>;
  purge(olderThanMs?: number): Promise<number>;
  count(): Promise<number>;
}

export const createDeadLetterQueue = (
  kv: KVAdapter,
  requeue: (task: Task) => Promise<string>
): DeadLetterQueue => {
  const storage = createTaskStorage(kv);

  return {
    async add(task: Task, reason: string): Promise<void> {
      const entry: DeadLetterEntry = {
        taskId: task.id,
        task,
        failedAt: Date.now(),
        reason,
        attempts: task.attempt,
      };

      await storage.updateStatus(task.id, task.status, "dead", {
        lastError: reason,
        completedAt: Date.now(),
      });

      await kv.zadd(DEAD_LETTER_KEY, entry.failedAt, task.id);
      await kv.hmset(
        `${DLQ_DATA_PREFIX}${task.id}`,
        serializeDLQEntry(entry) as never
      );
    },

    async list(limit: number = 100, offset: number = 0): Promise<DeadLetterEntry[]> {
      const taskIds = await kv.zrange(DEAD_LETTER_KEY, offset, offset + limit - 1);
      const entries: DeadLetterEntry[] = [];

      for (const taskId of taskIds) {
        const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
        if (data && Object.keys(data).length > 0) {
          entries.push(deserializeDLQEntry(data));
        }
      }

      return entries;
    },

    async get(taskId: string): Promise<DeadLetterEntry | null> {
      const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
      if (!data || Object.keys(data).length === 0) return null;
      return deserializeDLQEntry(data);
    },

    async retry(taskId: string): Promise<string | null> {
      const data = await kv.hgetall(`${DLQ_DATA_PREFIX}${taskId}`);
      if (!data || Object.keys(data).length === 0) return null;

      const entry = deserializeDLQEntry(data);

      await kv.zrem(DEAD_LETTER_KEY, taskId);
      await kv.del(`${DLQ_DATA_PREFIX}${taskId}`);
      await storage.delete(taskId);

      const newTask: Task = {
        ...entry.task,
        id: crypto.randomUUID(),
        status: "pending",
        attempt: 0,
        createdAt: Date.now(),
        scheduledFor: Date.now(),
        startedAt: undefined,
        completedAt: undefined,
        workerId: undefined,
        lastError: undefined,
        result: undefined,
      };

      return requeue(newTask);
    },

    async retryAll(): Promise<number> {
      const entries = await this.list(1000);
      let retried = 0;

      for (const entry of entries) {
        const newId = await this.retry(entry.taskId);
        if (newId) retried++;
      }

      return retried;
    },

    async purge(olderThanMs?: number): Promise<number> {
      const cutoff = olderThanMs ? Date.now() - olderThanMs : Infinity;

      const taskIds = await kv.zrangebyscore(DEAD_LETTER_KEY, "-inf", cutoff);

      for (const taskId of taskIds) {
        await kv.del(`${DLQ_DATA_PREFIX}${taskId}`);
        await storage.delete(taskId);
      }

      await kv.zrem(DEAD_LETTER_KEY, ...taskIds);

      return taskIds.length;
    },

    async count(): Promise<number> {
      return kv.zcard(DEAD_LETTER_KEY);
    },
  };
};
