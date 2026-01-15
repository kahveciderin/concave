import z from "zod";
import { v4 as uuidv4 } from "uuid";
import { Filter } from "./filter";

// todo: use redis here

const inMemoryKv = new Map<string, { value: string; expiry: Date | null }>();

export const kvSet = async <T>(key: string, value: T): Promise<void> => {
  inMemoryKv.set(key, { value: JSON.stringify(value), expiry: null });
};

export const kvSetEx = async <T>(
  key: string,
  value: T,
  expiry: number
): Promise<void> => {
  const expiryDate = new Date(Date.now() + expiry * 1000);
  inMemoryKv.set(key, { value: JSON.stringify(value), expiry: expiryDate });
};

export const kvGet = async <T>(key: string): Promise<T | null> => {
  const { value, expiry } = inMemoryKv.get(key) ?? {
    value: null,
    expiry: null,
  };
  if (!value) return null;
  if (expiry && expiry < new Date()) {
    inMemoryKv.delete(key);
    return null;
  }
  return JSON.parse(value) as T;
};

export const kvDelete = async (key: string): Promise<void> => {
  inMemoryKv.delete(key);
};

export const kvDeleteAll = async (pattern: string): Promise<void> => {
  const regex = new RegExp(
    "^" +
      pattern.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^:]*")) +
      "$"
  );

  for (const key of inMemoryKv.keys()) {
    if (regex.test(key)) {
      inMemoryKv.delete(key);
    }
  }
};

export async function* kvScan<T>(pattern: string) {
  const regex = new RegExp(
    "^" +
      pattern.replace(/\*\*|\*/g, (m) => (m === "**" ? ".*" : "[^:]*")) +
      "$"
  );

  for (const [key, { value }] of inMemoryKv.entries()) {
    if (regex.test(key)) {
      yield { key: key, value: JSON.parse(value) as T };
    }
  }
}

const subscriptionSchema = z.object({
  id: z.uuid(),
  createdAt: z.date(),
  resource: z.string(), // name of the resource
  filter: z.string(), // filters as inputted to filter.ts
  authId: z.string().nullable(), // id of the user who created the subscription
  handlerId: z.string(), // id of the handler to send events to
  relevantObjectIds: z.set(z.string()),
});

type Subscription = z.infer<typeof subscriptionSchema>;

const eventSchema = z.union([
  z.object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    type: z.literal("added"),
    object: z.any(),
  }),
  z.object({
    id: z.uuid(),
    subscriptionId: z.uuid(),
    type: z.literal("existing"),
    object: z.any(),
  }),
]);

export type Event = z.infer<typeof eventSchema>;

export const createSubscription = async (
  resource: string,
  filter: string,
  handlerId: string,
  authId: string | null,
  relevantObjectIds: Set<string>
) => {
  const subscriptionId = uuidv4();
  const createdAt = new Date();
  const subscription = {
    id: subscriptionId,
    createdAt,
    resource,
    filter,
    authId,
    handlerId,
    relevantObjectIds,
  } satisfies Subscription;

  await kvSet(
    `subscription::${resource}::${handlerId}::${authId ?? "null"}::${subscriptionId}`,
    subscription
  );

  return subscriptionId;
};

export const removeSubscription = async (
  resource: string,
  subscriptionId: string
) => {
  for await (const { key, value } of kvScan<Subscription>(
    "subscription::" + resource + "::**::" + subscriptionId
  )) {
    if (value.id === subscriptionId) {
      await kvDelete(key);

      await kvDeleteAll(
        "event::" +
          resource +
          "::" +
          value.handlerId +
          "::" +
          (value.authId ?? "null") +
          "::" +
          subscriptionId +
          "::**"
      );
      return;
    }
  }
};

// todo: auth / scope checking
export const pushInsertsToSubscriptions = async (
  resource: string,
  filter: Filter,
  items: any[]
) => {
  for await (const { key, value } of kvScan<Subscription>(
    "subscription::" + resource + "::**"
  )) {
    const compiledFilter = filter.compile(value.filter);

    for (const item of items) {
      const result = compiledFilter.execute(item);

      if (!result) continue;
      const eventId = uuidv4();

      const event = {
        id: eventId,
        subscriptionId: value.id,
        type: "added",
        object: item,
      } satisfies Event;

      await kvSetEx(
        `event::${resource}::${value.handlerId}::${value.authId ?? "null"}::${value.id}::${eventId}`,
        event,
        60
      );
    }
  }
};

export const pushUpdatesToSubscriptions = async (resource: string, filter: Filter, items: any[]) => {}