export type EventType = "added" | "existing" | "changed" | "removed" | "invalidate";

export interface BaseEvent {
  id: string;
  subscriptionId: string;
  seq: number;
  timestamp: number;
}

export interface EventMeta {
  optimisticId?: string;
}

export interface AddedEvent<T = unknown> extends BaseEvent {
  type: "added";
  object: T;
  meta?: EventMeta;
}

export interface ExistingEvent<T = unknown> extends BaseEvent {
  type: "existing";
  object: T;
}

export interface ChangedEvent<T = unknown> extends BaseEvent {
  type: "changed";
  object: T;
  previousObjectId?: string;
}

export interface RemovedEvent extends BaseEvent {
  type: "removed";
  objectId: string;
}

export interface InvalidateEvent extends BaseEvent {
  type: "invalidate";
  reason?: string;
}

export type SubscriptionEvent<T = unknown> =
  | AddedEvent<T>
  | ExistingEvent<T>
  | ChangedEvent<T>
  | RemovedEvent
  | InvalidateEvent;

export interface PaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface CountResponse {
  count: number;
}

export interface AggregationGroup {
  key: Record<string, unknown> | null;
  count?: number;
  sum?: Record<string, number>;
  avg?: Record<string, number>;
  min?: Record<string, number | string>;
  max?: Record<string, number | string>;
}

export interface AggregationResponse {
  groups: AggregationGroup[];
}

export interface ErrorResponse {
  error: {
    code: string;
    message: string;
    details?: unknown;
  };
}

export interface ProcedureResponse<T = unknown> {
  data: T;
}

export interface ListOptions {
  filter?: string;
  select?: string[];
  include?: string;
  cursor?: string;
  limit?: number;
  orderBy?: string;
  totalCount?: boolean;
}

export interface GetOptions {
  select?: string[];
  include?: string;
}

export interface AggregateOptions {
  filter?: string;
  groupBy?: string[];
  count?: boolean;
  sum?: string[];
  avg?: string[];
  min?: string[];
  max?: string[];
}

export interface SubscribeOptions {
  filter?: string;
  include?: string;
  resumeFrom?: number;
}

export interface CreateOptions {
  optimistic?: boolean;
  optimisticId?: string;
}

export interface UpdateOptions {
  optimistic?: boolean;
}

export interface DeleteOptions {
  optimistic?: boolean;
}

export interface BatchCreateOptions {
  items: unknown[];
}

export interface BatchUpdateOptions {
  filter: string;
  data: unknown;
}

export interface BatchDeleteOptions {
  filter: string;
}

export interface SubscriptionState<T> {
  items: Map<string, T>;
  isConnected: boolean;
  lastSeq: number;
  error: Error | null;
}

export interface SubscriptionCallbacks<T> {
  onAdded?: (item: T, meta?: EventMeta) => void;
  onExisting?: (item: T) => void;
  onChanged?: (item: T, previousId?: string) => void;
  onRemoved?: (id: string) => void;
  onInvalidate?: (reason?: string) => void;
  onError?: (error: Error) => void;
  onConnected?: (seq: number) => void;
  onDisconnected?: () => void;
}

export interface TransportConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
}

export interface TransportRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  params?: Record<string, string | number | boolean | string[]>;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface TransportResponse<T = unknown> {
  data: T;
  status: number;
  headers: Headers;
}

export type ConflictResolutionStrategy = "server-wins" | "client-wins" | "manual";

export interface ConflictError {
  code: "CONFLICT";
  serverState: unknown;
  clientState: unknown;
}

export interface ResolvedMutation {
  data: unknown;
  retryWith?: "create" | "update";
}

export interface OfflineMutation {
  id: string;
  idempotencyKey: string;
  type: "create" | "update" | "delete";
  resource: string;
  data?: unknown;
  objectId?: string;
  optimisticId?: string;
  serverId?: string;
  timestamp: number;
  retryCount: number;
  status: "pending" | "processing" | "failed" | "synced";
  error?: string;
}

export interface OfflineConfig {
  enabled?: boolean;
  maxRetries?: number;
  retryDelay?: number;
  storage?: OfflineStorage;
  conflictResolution?: ConflictResolutionStrategy;
  onConflict?: (
    mutation: OfflineMutation,
    serverState: unknown,
    error: ConflictError
  ) => ResolvedMutation | "retry" | "discard";
  onIdRemapped?: (optimisticId: string, serverId: string) => void;
  dedupeWindowMs?: number;
}

export interface OfflineStorage {
  getMutations(): Promise<OfflineMutation[]>;
  addMutation(mutation: OfflineMutation): Promise<void>;
  updateMutation(id: string, update: Partial<OfflineMutation>): Promise<void>;
  removeMutation(id: string): Promise<void>;
  clear(): Promise<void>;
}

export interface ClientConfig {
  baseUrl: string;
  headers?: Record<string, string>;
  credentials?: RequestCredentials;
  timeout?: number;
  offline?: OfflineConfig;
  onError?: (error: Error) => void;
  onAuthError?: () => void;
  onSyncComplete?: () => void;
}

export interface ResourceClient<T extends { id: string }> {
  list(options?: ListOptions): Promise<PaginatedResponse<T>>;
  get(id: string, options?: GetOptions): Promise<T>;
  count(filter?: string): Promise<number>;
  aggregate(options: AggregateOptions): Promise<AggregationResponse>;
  create(data: Omit<T, "id">, options?: CreateOptions): Promise<T>;
  update(id: string, data: Partial<T>, options?: UpdateOptions): Promise<T>;
  replace(id: string, data: Omit<T, "id">, options?: UpdateOptions): Promise<T>;
  delete(id: string, options?: DeleteOptions): Promise<void>;
  batchCreate(items: Omit<T, "id">[]): Promise<T[]>;
  batchUpdate(filter: string, data: Partial<T>): Promise<{ count: number }>;
  batchDelete(filter: string): Promise<{ count: number }>;
  subscribe(
    options?: SubscribeOptions,
    callbacks?: SubscriptionCallbacks<T>
  ): Subscription<T>;
  rpc<TInput, TOutput>(name: string, input: TInput): Promise<TOutput>;
}

export interface Subscription<T> {
  readonly state: SubscriptionState<T>;
  readonly items: T[];
  unsubscribe(): void;
  reconnect(): void;
}

export interface PaginatedQuery<T> {
  readonly items: T[];
  readonly hasMore: boolean;
  readonly isLoading: boolean;
  readonly error: Error | null;
  loadMore(): Promise<void>;
  refresh(): Promise<void>;
  setFilter(filter: string): void;
  setOrderBy(orderBy: string): void;
}

export interface ReactiveAggregate {
  readonly groups: AggregationGroup[];
  readonly isLoading: boolean;
  readonly error: Error | null;
  refresh(): Promise<void>;
  setOptions(options: AggregateOptions): void;
}

export interface AuthManager {
  configure(config: unknown): void;
  initialize(): Promise<unknown>;
  login(options?: { prompt?: "none" | "login" | "consent" }): Promise<void>;
  handleCallback(callbackUrl?: string): Promise<unknown>;
  logout(options?: { localOnly?: boolean }): Promise<void>;
  refreshTokens(): Promise<unknown>;
  getState(): unknown;
  getAccessToken(): string | null;
  getUser(): unknown | null;
  isAuthenticated(): boolean;
  getTransport(): unknown | null;
  subscribe(callback: (state: unknown) => void): () => void;
  on(event: string, listener: (...args: unknown[]) => void): () => void;
}

export interface ConcaveClient {
  readonly transport: unknown;
  readonly offline?: unknown;
  readonly auth: AuthManager;
  resource<T extends { id: string }>(path: string): ResourceClient<T>;
  setAuthToken(token: string): void;
  clearAuthToken(): void;
  setAuthErrorHandler(handler: () => void): void;
  getPendingCount(): Promise<number>;
  checkAuth(url?: string): Promise<{ user: unknown | null }>;
}
