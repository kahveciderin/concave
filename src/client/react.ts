import { useSyncExternalStore, useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { ResourceClient, ConcaveClient } from "./types";
import { getClient, getAuthErrorHandler } from "./globals";
import { createLiveQuery, LiveQuery, LiveQueryOptions, LiveQueryState, LiveQueryMutations, statusLabel } from "./live-store";

export type LiveStatus = "loading" | "live" | "reconnecting" | "offline" | "error";

export interface UseLiveListOptions extends LiveQueryOptions {
  enabled?: boolean;
}

export interface UseLiveListResult<T extends { id: string }> {
  items: T[];
  status: LiveStatus;
  statusLabel: string;
  error: Error | null;
  pendingCount: number;
  isLoading: boolean;
  isLive: boolean;
  isOffline: boolean;
  isReconnecting: boolean;
  hasMore: boolean;
  totalCount?: number;
  isLoadingMore: boolean;
  mutate: LiveQueryMutations<T>;
  refresh: () => Promise<void>;
  loadMore: () => Promise<void>;
}

/**
 * Live list hook that handles real-time subscriptions, optimistic updates, and offline support.
 *
 * @example
 * // Using path string (requires client to be initialized)
 * const { items, status, mutate } = useLiveList<Todo>('/api/todos', { orderBy: 'position' });
 *
 * @example
 * // Using ResourceClient directly
 * const todosRepo = client.resource<Todo>('/api/todos');
 * const { items, status, mutate } = useLiveList(todosRepo, { orderBy: 'position' });
 */
const EMPTY_STATE: LiveQueryState<never> = {
  items: [],
  status: "loading",
  error: null,
  pendingCount: 0,
  lastSeq: 0,
  hasMore: false,
  totalCount: undefined,
  isLoadingMore: false,
};

export function useLiveList<T extends { id: string }>(
  pathOrRepo: string | ResourceClient<T>,
  options: UseLiveListOptions = {}
): UseLiveListResult<T> {
  const { enabled = true, ...queryOptions } = options;
  const liveQueryRef = useRef<LiveQuery<T> | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  // Get client and repo
  const client = typeof pathOrRepo === "string" ? getClient() : null;
  const repo = useMemo(() => {
    if (typeof pathOrRepo === "string") {
      return getClient().resource<T>(pathOrRepo);
    }
    return pathOrRepo;
  }, [pathOrRepo]);

  const optionsKey = JSON.stringify(queryOptions);

  // Update pending count periodically
  useEffect(() => {
    if (!client) return;

    const updatePending = async () => {
      const count = await client.getPendingCount();
      setPendingCount(count);
    };

    updatePending();
    const interval = setInterval(updatePending, 2000);
    return () => clearInterval(interval);
  }, [client]);

  useEffect(() => {
    if (!repo || !enabled) {
      liveQueryRef.current?.destroy();
      liveQueryRef.current = null;
      return;
    }

    const authErrorHandler = getAuthErrorHandler();

    liveQueryRef.current = createLiveQuery(repo, queryOptions, {
      onAuthError: authErrorHandler ?? undefined,
      getPendingCount: client ? () => client.getPendingCount() : undefined,
    });

    return () => {
      liveQueryRef.current?.destroy();
      liveQueryRef.current = null;
    };
  }, [repo, optionsKey, enabled, client]);

  const subscribe = useCallback((listener: () => void) => {
    if (!liveQueryRef.current) return () => {};
    return liveQueryRef.current.subscribe(listener);
  }, []);

  const getSnapshot = useCallback((): LiveQueryState<T> => {
    if (!liveQueryRef.current) {
      return EMPTY_STATE as LiveQueryState<T>;
    }
    return liveQueryRef.current.getSnapshot();
  }, []);

  const state = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const mutate: LiveQueryMutations<T> = useMemo(() => ({
    create: (data) => {
      if (!liveQueryRef.current) throw new Error("LiveQuery not initialized");
      return liveQueryRef.current.mutate.create(data);
    },
    update: (id, data) => liveQueryRef.current?.mutate.update(id, data),
    delete: (id) => liveQueryRef.current?.mutate.delete(id),
  }), []);

  const refresh = useCallback(async () => {
    await liveQueryRef.current?.refresh();
  }, []);

  const loadMore = useCallback(async () => {
    await liveQueryRef.current?.loadMore();
  }, []);

  // Use state's pending count if available, otherwise use polled count
  const effectivePendingCount = state.pendingCount > 0 ? state.pendingCount : pendingCount;

  return {
    items: state.items,
    status: state.status,
    statusLabel: statusLabel(state.status, effectivePendingCount),
    error: state.error,
    pendingCount: effectivePendingCount,
    isLoading: state.status === "loading",
    isLive: state.status === "live",
    isOffline: state.status === "offline",
    isReconnecting: state.status === "reconnecting",
    hasMore: state.hasMore,
    totalCount: state.totalCount,
    isLoadingMore: state.isLoadingMore,
    mutate,
    refresh,
    loadMore,
  };
}

export interface UseAuthOptions {
  checkUrl?: string;
  logoutUrl?: string;
}

export interface UseAuthResult<TUser = unknown> {
  user: TUser | null;
  status: "loading" | "authenticated" | "unauthenticated";
  isAuthenticated: boolean;
  isLoading: boolean;
  logout: () => Promise<void>;
  refetch: () => Promise<void>;
}

/**
 * Auth hook that integrates with the Concave client.
 *
 * @example
 * const { user, isAuthenticated, logout } = useAuth<User>();
 *
 * if (!isAuthenticated) return <LoginPage />;
 * return <App user={user} onLogout={logout} />;
 */
export function useAuth<TUser = unknown>(options: UseAuthOptions = {}): UseAuthResult<TUser> {
  const [user, setUser] = useState<TUser | null>(null);
  const [status, setStatus] = useState<"loading" | "authenticated" | "unauthenticated">("loading");

  const client = useMemo(() => {
    try {
      return getClient();
    } catch {
      return null;
    }
  }, []);

  const checkAuth = useCallback(async () => {
    if (!client) {
      // Fallback to direct fetch if no client
      try {
        const response = await fetch(options.checkUrl ?? "/api/auth/me", {
          credentials: "include",
        });
        const data = await response.json();
        if (data.user) {
          setUser(data.user as TUser);
          setStatus("authenticated");
        } else {
          setUser(null);
          setStatus("unauthenticated");
        }
      } catch {
        setUser(null);
        setStatus("unauthenticated");
      }
      return;
    }

    const result = await client.checkAuth(options.checkUrl);
    if (result.user) {
      setUser(result.user as TUser);
      setStatus("authenticated");
    } else {
      setUser(null);
      setStatus("unauthenticated");
    }
  }, [client, options.checkUrl]);

  const logout = useCallback(async () => {
    const logoutUrl = options.logoutUrl ?? "/api/auth/logout";
    try {
      await fetch(logoutUrl, {
        method: "POST",
        credentials: "include",
      });
    } catch {
      // Ignore logout errors
    }
    setUser(null);
    setStatus("unauthenticated");
  }, [options.logoutUrl]);

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return {
    user,
    status,
    isAuthenticated: status === "authenticated",
    isLoading: status === "loading",
    logout,
    refetch: checkAuth,
  };
}

export { statusLabel } from "./live-store";
export type { LiveQueryStatus, LiveQueryState, LiveQueryMutations, LiveQuery, SubscriptionMode } from "./live-store";
