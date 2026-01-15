// Main server-side exports for Concave

// Resource (core)
export { useResource } from "./resource/hook";
export { createResourceFilter, type Filter } from "./resource/filter";
export { changelog, recordCreate, recordUpdate, recordDelete } from "./resource/changelog";
export {
  encodeCursor,
  decodeCursor,
  parseOrderBy,
  createPagination,
  type CursorData,
  type PaginationConfig,
  type OrderByField,
} from "./resource/pagination";
export {
  ResourceError,
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
  RateLimitError,
  BatchLimitError,
  ConflictError,
  formatErrorResponse,
  formatZodError,
} from "./resource/error";
export type {
  ResourceConfig,
  ScopeConfig,
  ScopeFunction,
  BatchConfig,
  CustomOperator,
  LifecycleHooks,
  ProcedureDefinition,
  ProcedureContext,
  WriteEffect,
} from "./resource/types";

// Subscriptions
export {
  createSubscription as createServerSubscription,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  clearAllSubscriptions,
} from "./resource/subscription";

// Procedures
export { defineProcedure, executeProcedure } from "./resource/procedures";

// Query utilities
export { parseSelect, applyProjection } from "./resource/query";

// Auth
export {
  rsql,
  allScope,
  emptyScope,
  eq,
  ne,
  gt,
  gte,
  lt,
  lte,
  inList,
  notIn,
  like,
  isNull,
  isNotNull,
  and,
  or,
  not,
  ownerScope,
  publicScope,
  ownerOrPublic,
  isCompiledScope,
  scopeFromString,
} from "./auth/rsql";
export {
  BaseAuthAdapter,
  CompositeAuthAdapter,
  NullAuthAdapter,
  createUserContext,
} from "./auth/adapter";
export {
  requireAuth,
  optionalAuth,
  requireRole,
  requirePermission,
  getUser,
  rateByUser,
} from "./auth/middleware";
export {
  ScopeResolver,
  createScopeResolver,
  combineScopes,
  checkObjectAccess,
  scopePatterns,
  type Operation,
} from "./auth/scope";
export { createPassportAdapter } from "./auth/adapters/passport";
export { createAuthJsAdapter } from "./auth/adapters/authjs";
export type {
  AuthCredentials,
  AuthResult,
  SessionData,
  ApiKeyData,
  AuthAdapter,
  ResourceAuthConfig,
  AuthenticatedRequest,
  AuthMiddlewareOptions,
  SessionStore,
} from "./auth/types";

// Middleware
export { createRateLimiter } from "./middleware/rateLimit";
export { asyncHandler } from "./middleware/error";

// KV Store
export {
  createKV,
  initializeKV,
  createMemoryKV,
  createRedisKV,
  createRedisKVFromConfig,
  setGlobalKV,
  getGlobalKV,
  hasGlobalKV,
  MemoryKVStore,
  RedisKVStore,
} from "./kv";
export type {
  KVAdapter,
  KVTransaction,
  KVConfig,
  RedisConfig,
  SetOptions,
} from "./kv";

// Subscription initialization (for multi-process deployments)
export { initializeEventSubscription } from "./resource/subscription";
