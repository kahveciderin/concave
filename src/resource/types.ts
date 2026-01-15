import {
  Table,
  TableConfig,
  AnyColumn,
  InferSelectModel,
  InferInsertModel,
  SQLWrapper,
} from "drizzle-orm";
import { z } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleDatabase = any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type DrizzleTransaction = any;

export type EventType =
  | "added"
  | "existing"
  | "changed"
  | "removed"
  | "invalidate";

export interface BaseEvent {
  id: string;
  subscriptionId: string;
  seq: number;
  timestamp: number;
}

export interface AddedEvent<T = Record<string, unknown>> extends BaseEvent {
  type: "added";
  object: T;
}

export interface ExistingEvent<T = Record<string, unknown>> extends BaseEvent {
  type: "existing";
  object: T;
}

export interface ChangedEvent<T = Record<string, unknown>> extends BaseEvent {
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

export type SubscriptionEvent<T = Record<string, unknown>> =
  | AddedEvent<T>
  | ExistingEvent<T>
  | ChangedEvent<T>
  | RemovedEvent
  | InvalidateEvent;

export interface ChangelogEntry {
  seq: number;
  resource: string;
  type: "create" | "update" | "delete";
  objectId: string;
  object?: Record<string, unknown>;
  previousObject?: Record<string, unknown>;
  timestamp: number;
}

export interface Subscription {
  id: string;
  createdAt: Date;
  resource: string;
  filter: string;
  authId: string | null;
  handlerId: string;
  relevantObjectIds: Set<string>;
  lastSeq: number;
  scopeFilter?: string;
  authExpiresAt?: Date | null;
}

export interface PaginationParams {
  cursor?: string;
  limit: number;
  orderBy?: string;
  orderDirection?: "asc" | "desc";
}

export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface ProjectionParams {
  select?: string[];
}

export interface AggregationParams {
  groupBy?: string[];
  sum?: string[];
  avg?: string[];
  count?: boolean;
  min?: string[];
  max?: string[];
}

export interface AggregationResult {
  groups: Array<{
    key: Record<string, unknown> | null;
    count?: number;
    sum?: Record<string, number>;
    avg?: Record<string, number>;
    min?: Record<string, number | string>;
    max?: Record<string, number | string>;
  }>;
}

export interface CustomOperator {
  convert: (lhs: SQLWrapper, rhs: SQLWrapper) => SQLWrapper;
  execute: (lhs: unknown, rhs: unknown) => boolean;
}

export type WriteEffect =
  | { type: "create"; resource: string }
  | { type: "update"; resource: string; ids?: string[] }
  | { type: "delete"; resource: string; ids?: string[] };

export interface ProcedureContext<TConfig extends TableConfig = TableConfig> {
  db: unknown;
  schema: Table<TConfig>;
  user: UserContext | null;
  req: unknown;
}

export interface ProcedureDefinition<TInput = unknown, TOutput = unknown> {
  input?: z.ZodSchema<TInput>;
  output?: z.ZodSchema<TOutput>;
  writeEffects?: WriteEffect[];
  handler: (ctx: ProcedureContext, input: TInput) => Promise<TOutput>;
}

export interface LifecycleHooks<TConfig extends TableConfig = TableConfig> {
  onBeforeCreate?: (
    ctx: ProcedureContext<TConfig>,
    data: InferInsertModel<Table<TConfig>>
  ) => Promise<InferInsertModel<Table<TConfig>> | void>;
  onAfterCreate?: (
    ctx: ProcedureContext<TConfig>,
    created: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
  onBeforeUpdate?: (
    ctx: ProcedureContext<TConfig>,
    id: string,
    data: Partial<InferSelectModel<Table<TConfig>>>
  ) => Promise<Partial<InferSelectModel<Table<TConfig>>> | void>;
  onAfterUpdate?: (
    ctx: ProcedureContext<TConfig>,
    updated: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
  onBeforeDelete?: (
    ctx: ProcedureContext<TConfig>,
    id: string
  ) => Promise<void>;
  onAfterDelete?: (
    ctx: ProcedureContext<TConfig>,
    deleted: InferSelectModel<Table<TConfig>>
  ) => Promise<void>;
}

export interface UserContext {
  id: string;
  email: string | null;
  name: string | null;
  image: string | null;
  emailVerified: Date | null;
  sessionId: string;
  sessionExpiresAt: Date;
  metadata?: Record<string, unknown>;
}

export interface ScopeFunction {
  (user: UserContext): CompiledScope | Promise<CompiledScope>;
}

export interface ScopeConfig {
  scope?: ScopeFunction;
  read?: ScopeFunction;
  create?: ScopeFunction;
  update?: ScopeFunction;
  delete?: ScopeFunction;
  subscribe?: ScopeFunction;
  public?:
    | boolean
    | {
        read?: boolean;
        subscribe?: boolean;
      };
}

export interface CompiledScope {
  toString(): string;
  isEmpty(): boolean;
  and(other: CompiledScope): CompiledScope;
  or(other: CompiledScope): CompiledScope;
}

export interface RateLimitConfig {
  windowMs?: number;
  maxRequests?: number;
}

export interface BatchConfig {
  create?: number;
  update?: number;
  replace?: number;
  delete?: number;
}

export interface ResourceConfig<
  TConfig extends TableConfig,
  TTable extends Table<TConfig>,
> {
  db: DrizzleDatabase;
  id: AnyColumn<{ tableName: TTable["_"]["name"] }>;
  batch?: BatchConfig;
  pagination?: {
    defaultLimit?: number;
    maxLimit?: number;
  };
  rateLimit?: RateLimitConfig;
  auth?: ScopeConfig;
  procedures?: Record<string, ProcedureDefinition>;
  hooks?: LifecycleHooks<TConfig>;
  customOperators?: Record<string, CustomOperator>;
}
