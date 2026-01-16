import { CronExpressionParser } from "cron-parser";
import { KVAdapter } from "@/kv/types";
import { RecurringConfig, RecurringSchedule, TaskDefinition } from "./types";

const RECURRING_KEY = "concave:tasks:recurring";
const RECURRING_DATA_PREFIX = "concave:tasks:recurring:data:";

const serializeSchedule = (
  schedule: RecurringSchedule
): Record<string, string> => ({
  id: schedule.id,
  taskName: schedule.taskName,
  input: JSON.stringify(schedule.input),
  enabled: String(schedule.enabled),
  timezone: schedule.timezone,
  nextRunAt: String(schedule.nextRunAt),
  createdAt: String(schedule.createdAt),
  ...(schedule.cron && { cron: schedule.cron }),
  ...(schedule.interval && { interval: String(schedule.interval) }),
  ...(schedule.lastRunAt && { lastRunAt: String(schedule.lastRunAt) }),
});

const deserializeSchedule = (
  data: Record<string, string>
): RecurringSchedule => ({
  id: data.id,
  taskName: data.taskName,
  input: JSON.parse(data.input),
  enabled: data.enabled === "true",
  timezone: data.timezone,
  nextRunAt: parseInt(data.nextRunAt, 10),
  createdAt: parseInt(data.createdAt, 10),
  ...(data.cron && { cron: data.cron }),
  ...(data.interval && { interval: parseInt(data.interval, 10) }),
  ...(data.lastRunAt && { lastRunAt: parseInt(data.lastRunAt, 10) }),
});

export interface RecurringManager {
  create(
    task: TaskDefinition,
    input: unknown,
    config: RecurringConfig
  ): Promise<string>;
  pause(scheduleId: string): Promise<void>;
  resume(scheduleId: string): Promise<void>;
  delete(scheduleId: string): Promise<void>;
  get(scheduleId: string): Promise<RecurringSchedule | null>;
  list(): Promise<RecurringSchedule[]>;
  tick(enqueue: (taskName: string, input: unknown) => Promise<string>): Promise<void>;
}

export const calculateNextRun = (
  config: RecurringConfig,
  fromTime: number
): number => {
  if (config.cron) {
    const interval = CronExpressionParser.parse(config.cron, {
      currentDate: new Date(fromTime),
      tz: config.timezone ?? "UTC",
    });
    return interval.next().toDate().getTime();
  }

  if (config.interval) {
    return fromTime + config.interval;
  }

  throw new Error("Either cron or interval must be specified");
};

export const createRecurringManager = (kv: KVAdapter): RecurringManager => ({
  async create(
    task: TaskDefinition,
    input: unknown,
    config: RecurringConfig
  ): Promise<string> {
    const scheduleId = crypto.randomUUID();
    const now = Date.now();
    const nextRunAt = calculateNextRun(config, now);

    const schedule: RecurringSchedule = {
      id: scheduleId,
      taskName: task.name,
      input,
      cron: config.cron,
      interval: config.interval,
      timezone: config.timezone ?? "UTC",
      enabled: true,
      nextRunAt,
      createdAt: now,
    };

    await kv.hmset(
      `${RECURRING_DATA_PREFIX}${scheduleId}`,
      serializeSchedule(schedule) as never
    );
    await kv.zadd(RECURRING_KEY, nextRunAt, scheduleId);

    return scheduleId;
  },

  async pause(scheduleId: string): Promise<void> {
    await kv.hset(
      `${RECURRING_DATA_PREFIX}${scheduleId}`,
      "enabled",
      "false"
    );
    await kv.zrem(RECURRING_KEY, scheduleId);
  },

  async resume(scheduleId: string): Promise<void> {
    const data = await kv.hgetall(`${RECURRING_DATA_PREFIX}${scheduleId}`);
    if (!data || Object.keys(data).length === 0) return;

    const schedule = deserializeSchedule(data);
    const nextRunAt = calculateNextRun(
      { cron: schedule.cron, interval: schedule.interval, timezone: schedule.timezone },
      Date.now()
    );

    await kv.hmset(`${RECURRING_DATA_PREFIX}${scheduleId}`, {
      enabled: "true",
      nextRunAt: String(nextRunAt),
    } as never);
    await kv.zadd(RECURRING_KEY, nextRunAt, scheduleId);
  },

  async delete(scheduleId: string): Promise<void> {
    await kv.zrem(RECURRING_KEY, scheduleId);
    await kv.del(`${RECURRING_DATA_PREFIX}${scheduleId}`);
  },

  async get(scheduleId: string): Promise<RecurringSchedule | null> {
    const data = await kv.hgetall(`${RECURRING_DATA_PREFIX}${scheduleId}`);
    if (!data || Object.keys(data).length === 0) return null;
    return deserializeSchedule(data);
  },

  async list(): Promise<RecurringSchedule[]> {
    const keys = await kv.keys(`${RECURRING_DATA_PREFIX}*`);
    const schedules: RecurringSchedule[] = [];

    for (const key of keys) {
      const data = await kv.hgetall(key);
      if (data && Object.keys(data).length > 0) {
        schedules.push(deserializeSchedule(data));
      }
    }

    return schedules;
  },

  async tick(
    enqueue: (taskName: string, input: unknown) => Promise<string>
  ): Promise<void> {
    const now = Date.now();

    const dueScheduleIds = await kv.zrangebyscore(RECURRING_KEY, "-inf", now);

    for (const scheduleId of dueScheduleIds) {
      const data = await kv.hgetall(`${RECURRING_DATA_PREFIX}${scheduleId}`);
      if (!data || Object.keys(data).length === 0) {
        await kv.zrem(RECURRING_KEY, scheduleId);
        continue;
      }

      const schedule = deserializeSchedule(data);
      if (!schedule.enabled) continue;

      await enqueue(schedule.taskName, schedule.input);

      const nextRunAt = calculateNextRun(
        {
          cron: schedule.cron,
          interval: schedule.interval,
          timezone: schedule.timezone,
        },
        now
      );

      await kv.hmset(`${RECURRING_DATA_PREFIX}${scheduleId}`, {
        lastRunAt: String(now),
        nextRunAt: String(nextRunAt),
      } as never);
      await kv.zadd(RECURRING_KEY, nextRunAt, scheduleId);
    }
  },
});

export const startRecurringScheduler = (
  kv: KVAdapter,
  enqueue: (taskName: string, input: unknown) => Promise<string>,
  intervalMs: number = 1000
): (() => void) => {
  const manager = createRecurringManager(kv);
  const interval = setInterval(() => manager.tick(enqueue), intervalMs);
  return () => clearInterval(interval);
};
