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
  SearchError,
  SearchNotConfiguredError,
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
  type RelationLoader,
} from "./resource/subscription";

// Procedures
export {
  defineProcedure,
  executeProcedure,
  createTimestampHooks,
  composeHooks,
} from "./resource/procedures";

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
  createAuthMiddleware,
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
export { useAuth, createAuthRoutes } from "./auth/routes";
export type { UseAuthOptions, AuthRouterResult, AuthUser } from "./auth/routes";
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
export { asyncHandler, errorMiddleware, notFoundHandler } from "./middleware/error";
export {
  observabilityMiddleware,
  createMetricsCollector,
} from "./middleware/observability";
export type {
  RequestMetrics,
  SubscriptionMetrics,
  ErrorMetrics,
  MetricsConfig,
  ObservabilityConfig,
  MetricsCollector,
} from "./middleware/observability";

// Admin UI
export {
  createAdminUI,
  registerResourceSchema,
  unregisterResourceSchema,
  getResourceSchema,
  getAllResourceSchemas,
  getSchemaInfo,
  getAllSchemaInfos,
  getAllResourcesForDisplay,
} from "./ui";
export type {
  AdminUIConfig,
  SchemaRegistryEntry,
  ColumnInfo,
  SchemaInfo,
  ResourceDisplayInfo,
} from "./ui";

// Health Endpoints
export { createHealthEndpoints } from "./health";
export type {
  HealthConfig,
  HealthResponse,
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
} from "./health";

// OpenAPI
export {
  generateOpenAPISpec,
  serveOpenAPI,
  createConcaveRouter,
  extractSchemaInfo,
  buildConcaveSchema,
  generateTypeScriptTypes,
} from "./openapi";
export type {
  OpenAPIConfig,
  RegisteredResource,
  ResourceSchemaInfo,
  FieldSchemaInfo,
  TypeInfo,
  ConcaveSchema,
} from "./openapi";

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

// OIDC Provider
export {
  createOIDCProvider,
  oidcProviders,
  generateDiscoveryDocument,
  createKeyManager,
  createTokenService,
  createEmailPasswordBackend,
  createFederatedBackend,
} from "./oidc";
export type {
  OIDCProviderConfig,
  OIDCProviderResult,
  OIDCClient,
  OIDCUser,
  OIDCDiscoveryDocument,
  TokenResponse,
  TokenService,
  KeyManager,
  AuthBackend,
  AuthBackendResult,
  AuthBackendsConfig,
  EmailPasswordBackendConfig,
  FederatedProvider,
  IDTokenClaims,
  AccessTokenClaims,
  TokenConfig,
  KeyConfig,
  UIConfig,
  SecurityConfig,
  ProviderHooks,
} from "./oidc";

// Background Tasks
export {
  defineTask,
  initializeTasks,
  getTaskScheduler,
  getTaskRegistry,
  createTaskScheduler,
  createTaskRegistry,
  createTaskWorker,
  startTaskWorkers,
  createTaskTriggerHooks,
  composeHooks as composeTaskHooks,
} from "./tasks";
export type {
  TaskDefinition,
  TaskContext,
  Task,
  TaskStatus,
  TaskFilter,
  ScheduleOptions,
  RecurringConfig,
  RetryConfig,
  WorkerConfig,
  WorkerStats,
  TaskScheduler,
  TaskRegistry,
  TaskWorker,
} from "./tasks";

// Relations
export {
  parseInclude,
  parseNestedFilter,
} from "./resource/relations";
export type {
  RelationType,
  RelationConfig,
  RelationsConfig,
  IncludeSpec,
  IncludeConfig,
} from "./resource/types";

// Environment Variables
export { createEnv, envVariable, usePublicEnv } from "./env";
export type { PublicEnvConfig, PublicEnvSchema, EnvSchemaField } from "./env";

// Search
export {
  setGlobalSearch,
  getGlobalSearch,
  hasGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
  createOpenSearchAdapter,
} from "./search";
export type {
  SearchAdapter,
  SearchQuery,
  SearchHit,
  SearchResult,
  SearchConfig,
  FieldMapping,
  IndexMappings,
  OpenSearchConfig,
} from "./search";
export type { ResourceSearchConfig, SearchFieldConfig } from "./resource/types";
