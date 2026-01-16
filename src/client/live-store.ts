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
  create: (data: Omit<T, "id">) => string;
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
  include?: string;
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
    getIdMappings?: () => Map<string, string>;
    hasPendingMutationsForId?: (id: string) => Promise<boolean>;
  }
): LiveQuery<T> => {
  const cache = new Map<string, T>();
  const optimisticIds = new Set<string>();
  const pendingDeletes = new Set<string>();
  const pendingUpdates = new Map<string, Partial<T>>();
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

    // If this item (or its optimistic version) has a pending delete, don't add it
    if (pendingDeletes.has(item.id)) {
      return;
    }
    if (optimisticId && pendingDeletes.has(optimisticId)) {
      // Clean up the pending delete since server confirmed addition
      pendingDeletes.delete(optimisticId);
    }

    if (optimisticId && optimisticIds.has(optimisticId)) {
      cache.delete(optimisticId);
      optimisticIds.delete(optimisticId);
      idMappings.set(optimisticId, item.id);
      callbacks?.onIdRemapped?.(optimisticId, item.id);

      // Transfer any pending updates from optimistic ID to server ID
      const pendingUpdate = pendingUpdates.get(optimisticId);
      if (pendingUpdate) {
        pendingUpdates.delete(optimisticId);
        pendingUpdates.set(item.id, pendingUpdate);
      }
    }

    const mappedOptimisticId = Array.from(idMappings.entries()).find(
      ([optId, serverId]) => serverId === item.id
    )?.[0];

    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      cache.delete(mappedOptimisticId);
    }

    // Apply any pending updates to the item
    let finalItem = item;
    const pendingUpdate = pendingUpdates.get(item.id);
    if (pendingUpdate) {
      finalItem = { ...item, ...pendingUpdate };
    }

    cache.set(item.id, finalItem);
    notify();
  };

  const handleExisting = async (item: T) => {
    // Check if this item has a pending delete - if so, don't add it back
    if (pendingDeletes.has(item.id)) {
      return;
    }

    // Check if this item's ID is a server ID that maps to an optimistic ID
    // This handles the case where the subscription reconnects after offline sync
    // and the added event with optimisticId metadata was missed

    // Find the optimistic ID that maps to this server ID
    let mappedOptimisticId: string | undefined;

    // First check our local idMappings (optimisticId -> serverId)
    for (const [optId, serverId] of idMappings.entries()) {
      if (serverId === item.id) {
        mappedOptimisticId = optId;
        break;
      }
    }

    // Also check external ID mappings (from OfflineManager)
    if (!mappedOptimisticId && callbacks?.getIdMappings) {
      const externalMappings = callbacks.getIdMappings();
      // externalMappings is optimisticId -> serverId, so we need to find by serverId
      for (const [optimisticId, serverId] of externalMappings) {
        if (serverId === item.id) {
          mappedOptimisticId = optimisticId;
          break;
        }
      }
    }

    // Check if the mapped optimistic ID has a pending delete
    if (mappedOptimisticId && pendingDeletes.has(mappedOptimisticId)) {
      return;
    }

    // If we found a mapping and have the optimistic item in cache
    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      // Check if there are pending mutations for this item
      // If so, DON'T replace - keep the optimistic state until mutations sync
      if (callbacks?.hasPendingMutationsForId) {
        const hasPending = await callbacks.hasPendingMutationsForId(mappedOptimisticId);
        if (hasPending) {
          // Don't replace optimistic item - it has pending changes
          // Update our local idMappings for when the mutations complete
          idMappings.set(mappedOptimisticId, item.id);
          return;
        }
      }

      // No pending mutations - safe to replace
      cache.delete(mappedOptimisticId);
      optimisticIds.delete(mappedOptimisticId);
      idMappings.set(mappedOptimisticId, item.id);
    }

    // Apply any pending updates to the item
    let finalItem = item;
    const pendingUpdate = pendingUpdates.get(item.id);
    if (pendingUpdate) {
      finalItem = { ...item, ...pendingUpdate };
    }
    // Also check for pending updates on the mapped optimistic ID
    if (mappedOptimisticId) {
      const optPendingUpdate = pendingUpdates.get(mappedOptimisticId);
      if (optPendingUpdate) {
        finalItem = { ...finalItem, ...optPendingUpdate };
      }
    }

    cache.set(item.id, finalItem);
    notify();
  };

  const handleChange = (item: T) => {
    // Check if this change is for an item that was optimistically created
    // If so, we need to clean up the optimistic entry
    const mappedOptimisticId = Array.from(idMappings.entries()).find(
      ([serverId]) => serverId === item.id
    )?.[1];

    if (mappedOptimisticId && cache.has(mappedOptimisticId)) {
      cache.delete(mappedOptimisticId);
      optimisticIds.delete(mappedOptimisticId);
    }

    // Also check external mappings
    if (callbacks?.getIdMappings) {
      const externalMappings = callbacks.getIdMappings();
      for (const [optimisticId, serverId] of externalMappings) {
        if (serverId === item.id && cache.has(optimisticId)) {
          cache.delete(optimisticId);
          optimisticIds.delete(optimisticId);
          idMappings.set(item.id, optimisticId);
        }
      }
    }

    cache.set(item.id, item);
    notify();
  };

  const handleRemove = (id: string) => {
    cache.delete(id);
    optimisticIds.delete(id);
    // Server confirmed removal, clear pending delete
    pendingDeletes.delete(id);
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
    onExisting: handleExisting,
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
      if (options.include) listOptions.include = options.include;
      if (options.orderBy) listOptions.orderBy = options.orderBy;
      if (options.limit) listOptions.limit = options.limit;

      const result = await repo.list(listOptions);

      // Save optimistic items before clearing cache
      const optimisticItems = new Map<string, T>();
      for (const optId of optimisticIds) {
        const item = cache.get(optId);
        if (item) {
          optimisticItems.set(optId, item);
        }
      }

      cache.clear();

      // Add server items, but skip items with pending deletes
      // and apply pending updates
      for (const item of result.items) {
        // Skip items with pending deletes
        if (pendingDeletes.has(item.id)) {
          continue;
        }

        // Check if any optimistic ID maps to this server ID
        let mappedOptId: string | undefined;
        for (const [optId, serverId] of idMappings.entries()) {
          if (serverId === item.id) {
            mappedOptId = optId;
            break;
          }
        }

        // Skip if the mapped optimistic ID has a pending delete
        if (mappedOptId && pendingDeletes.has(mappedOptId)) {
          continue;
        }

        // Apply any pending updates
        let finalItem = item;
        const pendingUpdate = pendingUpdates.get(item.id);
        if (pendingUpdate) {
          finalItem = { ...item, ...pendingUpdate };
        }
        if (mappedOptId) {
          const optPendingUpdate = pendingUpdates.get(mappedOptId);
          if (optPendingUpdate) {
            finalItem = { ...finalItem, ...optPendingUpdate };
          }
        }

        cache.set(item.id, finalItem);
      }

      // Restore optimistic items that don't have server equivalents yet
      for (const [optId, item] of optimisticItems) {
        // Check if this optimistic ID has been mapped to a server ID
        const serverId = idMappings.get(optId);
        if (serverId && cache.has(serverId)) {
          // Server item exists, don't add optimistic version
          continue;
        }
        // Skip if pending delete
        if (pendingDeletes.has(optId)) {
          continue;
        }
        cache.set(optId, item);
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
    if (options.include) subscribeOptions.include = options.include;

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

      return optimisticId;
    },

    update: (id, data) => {
      const existing = cache.get(id);
      if (existing) {
        cache.set(id, { ...existing, ...data });
        notify();
      }

      // Track pending update so it can be reapplied after reconnection
      // It will be cleared when we receive the "changed" event from server
      const existingPending = pendingUpdates.get(id) || {};
      pendingUpdates.set(id, { ...existingPending, ...data } as Partial<T>);

      repo.update(id, data).then(() => {
        updatePendingCount();
      });
    },

    delete: (id) => {
      cache.delete(id);
      optimisticIds.delete(id);
      // Track pending delete so item doesn't reappear on reconnection
      // It will be cleared when we receive the "removed" event from server
      pendingDeletes.add(id);
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
