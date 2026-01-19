import { useSyncExternalStore, useRef, useEffect, useCallback, useState, useMemo } from "react";
import type { LiveListResourceClient, SearchableResourceClient, ConcaveClient, SearchResponse, SearchOptions, LiveQueryLike } from "./types";
import { getClient, getAuthErrorHandler } from "./globals";
import { createLiveQuery, LiveQuery, LiveQueryOptions, LiveQueryState, LiveQueryMutations, statusLabel } from "./live-store";

export type LiveStatus = "loading" | "live" | "reconnecting" | "offline" | "error";

export interface UseLiveListOptions<
  T extends { id: string } = { id: string },
  K extends keyof T & string = keyof T & string,
> extends Omit<LiveQueryOptions, "select"> {
  enabled?: boolean;
  select?: K[];
}

export interface UseLiveListResult<
  T extends { id: string },
  TItem = T,
> {
  items: TItem[];
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
 * // Using typed resource client (type is inferred automatically)
 * const { items, status, mutate } = useLiveList(client.resources.todos, { orderBy: 'position' });
 * // items type is inferred as Todo[]
 *
 * @example
 * // Using fluent LiveQuery with type-safe includes (recommended)
 * const { items } = useLiveList(client.resources.todos.filter('completed==true').include('category', 'tags'));
 * // items type: (todos & { category?: categories | null; tags?: tags[] })[]
 *
 * @example
 * // With projections for type-safe field selection
 * const { items } = useLiveList<User, 'id' | 'name' | 'avatar'>('/api/users', {
 *   select: ['id', 'name', 'avatar'],
 * });
 * // items type: { id: string; name: string; avatar: string }[]
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

// Type guard to check if input is a LiveQueryLike object
function isLiveQueryLike<T extends { id: string }>(
  input: unknown
): input is LiveQueryLike<T> {
  return (
    input !== null &&
    typeof input === "object" &&
    "_path" in input &&
    "_options" in input &&
    typeof (input as LiveQueryLike<T>)._path === "string"
  );
}

// Overload: Accept LiveQueryLike for fluent API with type-safe includes and select
export function useLiveList<T extends { id: string }, Included = {}, Selected extends keyof T = keyof T>(
  query: LiveQueryLike<T, Included, Selected>,
  options?: Omit<UseLiveListOptions<T>, "filter" | "orderBy" | "limit" | "select" | "include">
): UseLiveListResult<T, Pick<T, Selected> & Included>;

// Overload: Accept path string or ResourceClient
export function useLiveList<
  T extends { id: string },
  K extends keyof T & string = keyof T & string,
>(
  pathOrRepo: string | LiveListResourceClient<T>,
  options?: UseLiveListOptions<T, K>
): UseLiveListResult<T, Pick<T, K | "id">>;

// Implementation
export function useLiveList<
  T extends { id: string },
  K extends keyof T & string = keyof T & string,
>(
  pathOrRepoOrQuery: string | LiveListResourceClient<T> | LiveQueryLike<T>,
  options?: UseLiveListOptions<T, K>
): UseLiveListResult<T, Pick<T, K | "id">> {
  // Handle LiveQueryLike input - extract path and options as stable primitives
  const isLiveQuery = isLiveQueryLike(pathOrRepoOrQuery);
  const liveQueryInput = isLiveQuery ? pathOrRepoOrQuery as LiveQueryLike<T> : null;

  // Extract stable primitive values from LiveQuery to avoid reference instability
  const lqPath = liveQueryInput?._path;
  const lqFilter = liveQueryInput?._options.filter;
  const lqOrderBy = liveQueryInput?._options.orderBy;
  const lqLimit = liveQueryInput?._options.limit;
  const lqSelect = liveQueryInput?._options.select;
  const lqInclude = liveQueryInput?._options.include;
  const lqSelectKey = lqSelect ? JSON.stringify(lqSelect) : undefined;

  // Merge options from LiveQuery with passed options - use primitive dependencies
  const mergedOptions = useMemo(() => {
    if (isLiveQuery) {
      return {
        ...options,
        filter: lqFilter ?? (options as UseLiveListOptions<T, K>)?.filter,
        orderBy: lqOrderBy ?? (options as UseLiveListOptions<T, K>)?.orderBy,
        limit: lqLimit ?? (options as UseLiveListOptions<T, K>)?.limit,
        select: lqSelect ?? (options as UseLiveListOptions<T, K>)?.select,
        include: lqInclude ?? (options as UseLiveListOptions<T, K>)?.include,
      };
    }
    return options;
  }, [isLiveQuery, lqFilter, lqOrderBy, lqLimit, lqSelectKey, lqInclude, options]);

  const { enabled = true, select, ...queryOptions } = mergedOptions ?? {};
  const liveQueryRef = useRef<LiveQuery<T> | null>(null);
  const [pendingCount, setPendingCount] = useState(0);

  // Get path for resource - use stable lqPath
  const resourcePath = isLiveQuery ? lqPath : (typeof pathOrRepoOrQuery === "string" ? pathOrRepoOrQuery : null);

  // Get client and repo - use stable dependencies only
  // For LiveQuery: use lqPath (stable string)
  // For string: use the string itself (stable)
  // For ResourceClient: store in ref to maintain stability
  const client = (isLiveQuery || typeof pathOrRepoOrQuery === "string") ? getClient() : null;
  const isString = typeof pathOrRepoOrQuery === "string";
  const stringPath = isString ? pathOrRepoOrQuery : null;

  // Store ResourceClient in ref to avoid re-creating repo on every render
  // This is needed because ResourceClient passed inline would be unstable
  const resourceClientRef = useRef<LiveListResourceClient<T> | null>(null);
  if (!isLiveQuery && !isString) {
    resourceClientRef.current = pathOrRepoOrQuery as LiveListResourceClient<T>;
  }

  const repo = useMemo(() => {
    if (isLiveQuery && lqPath) {
      return getClient().resource<T>(lqPath);
    }
    if (stringPath) {
      return getClient().resource<T>(stringPath);
    }
    // ResourceClient case - use ref for stability
    return resourceClientRef.current;
  }, [isLiveQuery, lqPath, stringPath]);

  const optionsKey = JSON.stringify({ ...queryOptions, select });

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

    const liveQueryOptions = {
      ...queryOptions,
      select: select as string[] | undefined,
    };

    liveQueryRef.current = createLiveQuery(repo, liveQueryOptions, {
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

export interface UsePublicEnvOptions {
  baseUrl?: string;
  envPath?: string;
  refreshInterval?: number;
  enabled?: boolean;
}

export interface UsePublicEnvResult<T> {
  env: T | null;
  isLoading: boolean;
  error: Error | null;
  refetch: () => Promise<void>;
}

export function usePublicEnv<T = unknown>(
  options: UsePublicEnvOptions = {}
): UsePublicEnvResult<T> {
  const {
    baseUrl = typeof window !== "undefined" ? window.location.origin : "",
    envPath = "/api/env",
    refreshInterval,
    enabled = true,
  } = options;

  const [env, setEnv] = useState<T | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  const fetchEnv = useCallback(async () => {
    if (!enabled) return;

    try {
      setIsLoading(true);
      setError(null);
      const response = await fetch(`${baseUrl}${envPath}`, {
        credentials: "include",
      });
      if (!response.ok) {
        throw new Error(`Failed to fetch env: ${response.status}`);
      }
      const data = await response.json();
      setEnv(data as T);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setIsLoading(false);
    }
  }, [baseUrl, envPath, enabled]);

  useEffect(() => {
    fetchEnv();
  }, [fetchEnv]);

  useEffect(() => {
    if (!refreshInterval || !enabled) return;

    const interval = setInterval(fetchEnv, refreshInterval);
    return () => clearInterval(interval);
  }, [fetchEnv, refreshInterval, enabled]);

  return {
    env,
    isLoading,
    error,
    refetch: fetchEnv,
  };
}

export interface UseSearchOptions extends SearchOptions {
  debounceMs?: number;
  enabled?: boolean;
}

export interface UseSearchResult<T> {
  items: T[];
  total: number;
  highlights?: Record<string, Record<string, string[]>>;
  isSearching: boolean;
  error: Error | null;
  search: (query: string) => void;
  clear: () => void;
}

/**
 * Search hook that handles debounced search requests.
 *
 * @example
 * const { items, isSearching, search, clear } = useSearch<Todo>('/api/todos');
 *
 * // In your component:
 * <input onChange={(e) => search(e.target.value)} />
 * {items.map(item => <div key={item.id}>{item.title}</div>)}
 */
export function useSearch<T extends { id: string }>(
  pathOrRepo: string | SearchableResourceClient<T>,
  options: UseSearchOptions = {}
): UseSearchResult<T> {
  const { debounceMs = 300, enabled = true, ...searchOptions } = options;

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResponse<T> | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [error, setError] = useState<Error | null>(null);

  const repo = useMemo(() => {
    if (typeof pathOrRepo === "string") {
      return getClient().resource<T>(pathOrRepo);
    }
    return pathOrRepo;
  }, [pathOrRepo]);

  useEffect(() => {
    if (!enabled || !query.trim()) {
      setResults(null);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    setError(null);

    const timeoutId = setTimeout(async () => {
      try {
        const response = await repo.search(query, searchOptions);
        setResults(response);
      } catch (err) {
        setError(err instanceof Error ? err : new Error(String(err)));
        setResults(null);
      } finally {
        setIsSearching(false);
      }
    }, debounceMs);

    return () => clearTimeout(timeoutId);
  }, [query, repo, debounceMs, enabled, JSON.stringify(searchOptions)]);

  const search = useCallback((newQuery: string) => {
    setQuery(newQuery);
  }, []);

  const clear = useCallback(() => {
    setQuery("");
    setResults(null);
    setError(null);
  }, []);

  return {
    items: results?.items ?? [],
    total: results?.total ?? 0,
    highlights: results?.highlights,
    isSearching,
    error,
    search,
    clear,
  };
}

export { statusLabel } from "./live-store";
export type { LiveQueryStatus, LiveQueryState, LiveQueryMutations, LiveQuery, SubscriptionMode } from "./live-store";

export {
  useFileUpload,
  useFile,
  useFiles,
} from "./react-files";
export type {
  UseFileUploadOptions,
  UseFileUploadResult,
  UseFileOptions,
  UseFileResult,
  UseFilesOptions,
  UseFilesResult,
  UploadedFile,
  UploadProgress,
  FileUploadOptions,
} from "./react-files";
