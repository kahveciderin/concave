import type { ResourceClient, SubscriptionCallbacks, Subscription, ListOptions, SubscribeOptions, EventMeta } from "./types";

export type LiveQueryStatus = "loading" | "live" | "reconnecting" | "offline" | "error";

export interface LiveQueryState<T> {
  items: T[];
  status: LiveQueryStatus;
  error: Error | null;
  pendingCount: number;
  lastSeq: number;
}

export interface LiveQueryMutations<T extends { id: string }> {
  create: (data: Omit<T, "id">) => void;
  update: (id: string, data: Partial<T>) => void;
  delete: (id: string) => void;
}

export interface LiveQuery<T extends { id: string }> {
  getSnapshot: () => LiveQueryState<T>;
  subscribe: (listener: () => void) => () => void;
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
  destroy: () => void;
}

export interface LiveQueryOptions {
  filter?: string;
  orderBy?: string;
  limit?: number;
}

type SortFn<T> = (a: T, b: T) => number;

const createSortFn = <T>(orderBy?: string): SortFn<T> | null => {
  if (!orderBy) return null;

  const parts = orderBy.split(",").map(part => {
    const [field, dir] = part.trim().split(":");
    return { field: field!, desc: dir === "desc" };
  });

  return (a: T, b: T) => {
    for (const { field, desc } of parts) {
      const aVal = (a as Record<string, unknown>)[field];
      const bVal = (b as Record<string, unknown>)[field];

      if (aVal === bVal) continue;
      if (aVal === null || aVal === undefined) return desc ? -1 : 1;
      if (bVal === null || bVal === undefined) return desc ? 1 : -1;

      const cmp = aVal < bVal ? -1 : 1;
      return desc ? -cmp : cmp;
    }
    return 0;
  };
};

export const createLiveQuery = <T extends { id: string }>(
  repo: ResourceClient<T>,
  options: LiveQueryOptions = {},
  callbacks?: {
    onAuthError?: () => void;
    getPendingCount?: () => Promise<number>;
    onIdRemapped?: (optimisticId: string, serverId: string) => void;
  }
): LiveQuery<T> => {
  const cache = new Map<string, T>();
  const optimisticIds = new Set<string>();
  const idMappings = new Map<string, string>();
  const listeners = new Set<() => void>();
  let subscription: Subscription<T> | null = null;
  let status: LiveQueryStatus = "loading";
  let error: Error | null = null;
  let pendingCount = 0;
  let lastSeq = 0;
  let destroyed = false;

  const sortFn = createSortFn<T>(options.orderBy);

  // Cached snapshot for useSyncExternalStore compatibility
  let cachedSnapshot: LiveQueryState<T> = {
    items: [],
    status: "loading",
    error: null,
    pendingCount: 0,
    lastSeq: 0,
  };

  const getSortedItems = (): T[] => {
    const items = Array.from(cache.values());
    if (sortFn) items.sort(sortFn);
    return items;
  };

  const updateSnapshot = () => {
    cachedSnapshot = {
      items: getSortedItems(),
      status,
      error,
      pendingCount,
      lastSeq,
    };
  };

  const notify = () => {
    updateSnapshot();
    for (const listener of listeners) {
      listener();
    }
  };

  const updatePendingCount = async () => {
    if (callbacks?.getPendingCount) {
      pendingCount = await callbacks.getPendingCount();
      notify();
    }
  };

  const handleAdd = (item: T, meta?: EventMeta) => {
    const optimisticId = meta?.optimisticId;

    if (optimisticId && optimisticIds.has(optimisticId)) {
      cache.delete(optimisticId);
      optimisticIds.delete(optimisticId);
      idMappings.set(item.id, optimisticId);
      callbacks?.onIdRemapped?.(optimisticId, item.id);
    }

    const mappedOptimisticId = Array.from(idMappings.entries()).find(
      ([serverId]) => serverId === item.id
    )?.[1];

    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      cache.delete(mappedOptimisticId);
    }

    cache.set(item.id, item);
    notify();
  };

  const handleChange = (item: T) => {
    cache.set(item.id, item);
    notify();
  };

  const handleRemove = (id: string) => {
    cache.delete(id);
    optimisticIds.delete(id);
    notify();
  };

  const handleInvalidate = async () => {
    status = "loading";
    notify();
    await refresh();
  };

  const handleConnected = (seq: number) => {
    lastSeq = seq;
    status = navigator.onLine ? "live" : "offline";
    notify();
  };

  const handleDisconnected = () => {
    status = navigator.onLine ? "reconnecting" : "offline";
    notify();
  };

  const handleError = (err: Error) => {
    if ((err as { status?: number }).status === 401) {
      callbacks?.onAuthError?.();
      return;
    }
    error = err;
    status = "error";
    notify();
  };

  const subscriptionCallbacks: SubscriptionCallbacks<T> = {
    onAdded: handleAdd,
    onChanged: handleChange,
    onRemoved: handleRemove,
    onInvalidate: handleInvalidate,
    onConnected: handleConnected,
    onDisconnected: handleDisconnected,
    onError: handleError,
  };

  const refresh = async () => {
    if (destroyed) return;
    try {
      const listOptions: ListOptions = {};
      if (options.filter) listOptions.filter = options.filter;
      if (options.orderBy) listOptions.orderBy = options.orderBy;
      if (options.limit) listOptions.limit = options.limit;

      const result = await repo.list(listOptions);

      cache.clear();
      for (const item of result.items) {
        cache.set(item.id, item);
      }

      status = "live";
      error = null;
      notify();
    } catch (err) {
      if ((err as { status?: number }).status === 401) {
        callbacks?.onAuthError?.();
        return;
      }
      error = err as Error;
      status = "error";
      notify();
    }
  };

  const init = async () => {
    await refresh();
    if (destroyed) return;

    const subscribeOptions: SubscribeOptions = {};
    if (options.filter) subscribeOptions.filter = options.filter;

    subscription = repo.subscribe(subscribeOptions, subscriptionCallbacks);
    await updatePendingCount();
  };

  init();

  if (typeof window !== "undefined") {
    const handleOnline = () => {
      if (status === "offline" || status === "reconnecting") {
        status = subscription ? "reconnecting" : "offline";
        subscription?.reconnect();
        notify();
      }
    };

    const handleOffline = () => {
      status = "offline";
      notify();
    };

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
  }

  const mutate: LiveQueryMutations<T> = {
    create: (data) => {
      const optimisticId = `optimistic_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const optimisticItem = { ...data, id: optimisticId } as T;

      optimisticIds.add(optimisticId);
      cache.set(optimisticId, optimisticItem);
      notify();

      repo.create(data, { optimisticId }).then(() => {
        updatePendingCount();
      });
    },

    update: (id, data) => {
      const existing = cache.get(id);
      if (existing) {
        cache.set(id, { ...existing, ...data });
        notify();
      }

      repo.update(id, data).then(() => {
        updatePendingCount();
      });
    },

    delete: (id) => {
      cache.delete(id);
      optimisticIds.delete(id);
      notify();

      repo.delete(id).then(() => {
        updatePendingCount();
      });
    },
  };

  return {
    getSnapshot: () => cachedSnapshot,

    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    mutate,
    refresh,

    destroy: () => {
      destroyed = true;
      subscription?.unsubscribe();
      listeners.clear();
      cache.clear();
    },
  };
};

export const statusLabel = (status: LiveQueryStatus, pendingCount: number): string => {
  switch (status) {
    case "loading":
      return "Loading...";
    case "live":
      return "Live";
    case "reconnecting":
      return "Reconnecting...";
    case "offline":
      return pendingCount > 0 ? `Offline (${pendingCount} pending)` : "Offline";
    case "error":
      return "Error";
  }
};
