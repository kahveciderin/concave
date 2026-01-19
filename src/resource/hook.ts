import {
  eq,
  InferInsertModel,
  Table,
  TableConfig,
  InferSelectModel,
  count,
  getTableName,
  SQL,
  and,
  getTableColumns,
  inArray,
} from "drizzle-orm";
import { Request, Response, Router, type IRouter } from "express";
import { createInsertSchema, createUpdateSchema } from "drizzle-zod";
import { AnyColumn } from "drizzle-orm";
import z, { ZodError } from "zod";
import { v4 as uuidv4 } from "uuid";

import { createResourceFilter } from "./filter";
import { recordCreate, recordUpdate, recordDelete, changelog } from "./changelog";
import {
  createSubscription,
  removeSubscription,
  registerHandler,
  unregisterHandler,
  pushInsertsToSubscriptions,
  pushUpdatesToSubscriptions,
  pushDeletesToSubscriptions,
  sendExistingItems,
  sendInvalidateEvent,
  isHandlerConnected,
  getHandlerSubscriptions,
  registerKnownIds,
} from "./subscription";
import {
  createPagination,
  decodeCursorLegacy,
  parseOrderBy,
  OrderByField,
} from "./pagination";
import {
  parseSelect,
  applyProjection,
  parseAggregationParams,
  buildAggregationSelections,
  transformAggregationResults,
  createQueryHelper,
} from "./query";
import {
  executeProcedure,
  executeBeforeCreate,
  executeAfterCreate,
  executeBeforeUpdate,
  executeAfterUpdate,
  executeBeforeDelete,
  executeAfterDelete,
} from "./procedures";
import { trackMutations, isTrackedDb } from "./track-mutations";
import {
  ResourceConfig,
  CustomOperator,
  ProcedureDefinition,
  LifecycleHooks,
  UserContext,
  ProcedureContext,
  DrizzleTransaction,
  ResourceSearchConfig,
} from "./types";
import { createSearchHandler } from "./search";
import { hasGlobalSearch, getGlobalSearch } from "@/search";
import {
  NotFoundError,
  ValidationError,
  BatchLimitError,
  ResourceError,
  formatZodError,
} from "./error";
import { createScopeResolver, combineScopes, Operation } from "@/auth/scope";
import { AuthenticatedRequest } from "@/auth/types";
import { createRateLimiter, createOperationRateLimiter } from "@/middleware/rateLimit";
import { asyncHandler } from "@/middleware/error";
import {
  parseInclude,
  RelationLoader,
  RelationsConfig,
  IncludeConfig,
} from "./relations";
import { registerResourceSchema, setResourceMountPath } from "@/ui/schema-registry";

const DEFAULT_BATCH_LIMITS = {
  create: 100,
  update: 100,
  replace: 100,
  delete: 100,
};

const DEFAULT_PAGINATION = {
  defaultLimit: 20,
  maxLimit: 100,
};

const resourceRegistry = new Map<
  string,
  { schema: Table<TableConfig>; config: { relations?: RelationsConfig } }
>();

export const getResourceRegistry = () => resourceRegistry;

export const useResource = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  config: ResourceConfig<TConfig, Table<TConfig>>
): IRouter => {
  const db = config.db;
  const resourceName = getTableName(schema);
  const idColumnName = config.id.name;

  resourceRegistry.set(resourceName, {
    schema: schema as Table<TableConfig>,
    config: { relations: config.relations as RelationsConfig | undefined },
  });

  // Default capabilities: all enabled unless explicitly disabled
  const capabilities = {
    enableCreate: config.capabilities?.enableCreate ?? true,
    enableUpdate: config.capabilities?.enableUpdate ?? true,
    enableDelete: config.capabilities?.enableDelete ?? true,
    enableSubscribe: config.capabilities?.enableSubscribe ?? true,
    enableAggregations: config.capabilities?.enableAggregations ?? true,
    enableBatch: config.capabilities?.enableBatch ?? !!config.batch,
  };

  registerResourceSchema(resourceName, schema as Table<TableConfig>, db, config.id, {
    relations: config.relations as RelationsConfig | undefined,
    auth: config.auth,
    batch: config.batch,
    capabilities,
    sseEnabled: !!config.sse,
    procedures: config.procedures ? Object.keys(config.procedures) : undefined,
    generatedFields: config.generatedFields,
    fields: config.fields,
  });

  const relationLoader = config.relations
    ? new RelationLoader(
        db,
        schema as Table<TableConfig>,
        config.relations as RelationsConfig<TableConfig>,
        resourceRegistry,
        config.include
      )
    : null;

  // Create a subscription relation loader for pushing updates with relations
  const subscriptionRelationLoader = relationLoader
    ? async <T extends Record<string, unknown>>(items: T[], include: string): Promise<T[]> => {
        const includeSpecs = parseInclude(include);
        if (includeSpecs.length === 0) return items;
        return relationLoader.loadRelationsForItems(items, includeSpecs, idColumnName) as Promise<T[]>;
      }
    : undefined;

  const router = Router();

  // Capture mount path on first request for OpenAPI auto-discovery
  let mountPathCaptured = false;
  router.use((req, _res, next) => {
    if (!mountPathCaptured) {
      setResourceMountPath(resourceName, req.baseUrl);
      mountPathCaptured = true;
    }
    next();
  });

  const filterer = createResourceFilter(schema, config.customOperators ?? {});

  const pagination = createPagination(
    schema,
    config.id,
    config.pagination ?? DEFAULT_PAGINATION
  );

  const queryHelper = createQueryHelper(schema);

  const scopeResolver = createScopeResolver(config.auth, resourceName);

  const baseInsertSchema = createInsertSchema(schema);
  const updateSchema = createUpdateSchema(schema);

  const generatedFieldsPartial = config.generatedFields?.length
    ? Object.fromEntries(config.generatedFields.map((f) => [f, true] as const))
    : null;

  const insertSchema = generatedFieldsPartial
    ? (baseInsertSchema.partial as any)(generatedFieldsPartial)
    : baseInsertSchema;

  const parseInsert = (data: unknown) => {
    try {
      return insertSchema.parse(data) as InferInsertModel<Table<TConfig>>;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const parseMultiInsert = (data: unknown) => {
    try {
      return z.object({ items: z.array(insertSchema) }).parse(data) as {
        items: InferInsertModel<Table<TConfig>>[];
      };
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const parseUpdate = (data: unknown) => {
    try {
      return updateSchema.parse(data) as Partial<InferSelectModel<Table<TConfig>>>;
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ValidationError("Validation failed", formatZodError(error));
      }
      throw error;
    }
  };

  const batchConfig = { ...DEFAULT_BATCH_LIMITS, ...config.batch };
  const hooks = config.hooks;
  const procedures = config.procedures ?? {};

  const rateLimitMiddleware = config.rateLimit
    ? createRateLimiter({
        windowMs: config.rateLimit.windowMs ?? 60000,
        maxRequests: config.rateLimit.maxRequests ?? 100,
      })
    : null;

  const getUser = (req: Request): UserContext | null => {
    return (req as AuthenticatedRequest).user ?? null;
  };

  // Create a tracked db for procedures if not already tracked
  // This ensures mutations in procedures are automatically recorded to changelog
  const trackedDb = isTrackedDb(db)
    ? db
    : trackMutations(db, {
        [resourceName]: { table: schema, id: config.id },
      });

  const createProcedureContext = (req: Request): ProcedureContext<TConfig> => ({
    db: trackedDb,
    schema,
    user: getUser(req),
    req,
  });

  const applyFilters = async (
    req: Request,
    operation: Operation,
    additionalFilter?: string
  ): Promise<SQL<unknown> | undefined> => {
    const user = getUser(req);
    const scope = await scopeResolver.resolve(operation, user);

    const filterQuery = additionalFilter ?? req.query.filter?.toString() ?? "";
    const combinedFilter = combineScopes(scope, filterQuery);

    if (combinedFilter === "" || combinedFilter === "*") {
      return filterQuery ? (filterer.convert(filterQuery) as SQL<unknown>) : undefined;
    }

    return filterer.convert(combinedFilter) as SQL<unknown>;
  };

  if (rateLimitMiddleware) {
    router.use(rateLimitMiddleware);
  }

  if (batchConfig.create && batchConfig.create > 0) {
    router.post(
      "/batch",
      asyncHandler(async (req, res) => {
        await scopeResolver.requirePermission("create", getUser(req));

        const data = parseMultiInsert(req.body);
        if (data.items.length > batchConfig.create!) {
          throw new BatchLimitError("create", batchConfig.create!, data.items.length);
        }

        const ctx = createProcedureContext(req);

        const processedItems = await Promise.all(
          data.items.map(async (item) => {
            const processed = await executeBeforeCreate(hooks, ctx, item);
            return processed;
          })
        );

        const created = await db.insert(schema).values(processedItems).returning();
        const createdArray = created as unknown as Record<string, unknown>[];

        for (const item of createdArray) {
          await executeAfterCreate(hooks, ctx, item as any);
          recordCreate(resourceName, String(item[idColumnName]), item);
          await indexDocument(String(item[idColumnName]), item);
        }

        await pushInsertsToSubscriptions(
          resourceName,
          filterer as any,
          createdArray,
          idColumnName,
          undefined,
          subscriptionRelationLoader
        );

        res.json({ items: created });
      })
    );
  }

  if (batchConfig.update && batchConfig.update > 0) {
    router.patch(
      "/batch",
      asyncHandler(async (req, res) => {
        const filter = await applyFilters(req, "update");
        const data = parseUpdate(req.body);

        const result = await db.transaction(async (tx: DrizzleTransaction) => {
          const beforeItems = (await tx.select().from(schema).where(filter)) as unknown as Record<string, unknown>[];

          if (beforeItems.length > batchConfig.update!) {
            throw new BatchLimitError("update", batchConfig.update!, beforeItems.length);
          }

          const ctx = createProcedureContext(req);

          let processedData = data;
          for (const item of beforeItems) {
            processedData = await executeBeforeUpdate(
              hooks,
              ctx,
              String(item[idColumnName]),
              processedData
            );
          }

          await tx.update(schema).set(processedData).where(filter);

          // Select by IDs, not by original filter, since the update may have changed fields used in the filter
          const ids = beforeItems.map((item) => item[idColumnName]);
          const afterItems = (await tx.select().from(schema).where(inArray(config.id, ids as any))) as unknown as Record<string, unknown>[];

          const previousMap = new Map<string, Record<string, unknown>>();
          for (let i = 0; i < beforeItems.length; i++) {
            const before = beforeItems[i]!;
            const after = afterItems[i]!;
            const id = String(before[idColumnName]);
            previousMap.set(id, before);
            recordUpdate(resourceName, id, after, before);
            await executeAfterUpdate(hooks, ctx, after as any);
          }

          return { count: afterItems.length, items: afterItems, previousMap };
        });

        for (const item of result.items) {
          await indexDocument(String(item[idColumnName]), item);
        }

        await pushUpdatesToSubscriptions(
          resourceName,
          filterer as any,
          result.items,
          idColumnName,
          result.previousMap,
          subscriptionRelationLoader
        );

        res.json({ count: result.count });
      })
    );
  }

  if (batchConfig.delete && batchConfig.delete > 0) {
    router.delete(
      "/batch",
      asyncHandler(async (req, res) => {
        const filter = await applyFilters(req, "delete");

        const result = await db.transaction(async (tx: DrizzleTransaction) => {
          const items = (await tx.select().from(schema).where(filter)) as unknown as Record<string, unknown>[];

          if (items.length > batchConfig.delete!) {
            throw new BatchLimitError("delete", batchConfig.delete!, items.length);
          }

          const ctx = createProcedureContext(req);

          for (const item of items) {
            await executeBeforeDelete(hooks, ctx, String(item[idColumnName]));
          }

          await tx.delete(schema).where(filter);

          const deletedIds: string[] = [];
          for (const item of items) {
            const id = String(item[idColumnName]);
            deletedIds.push(id);
            recordDelete(resourceName, id, item);
            await executeAfterDelete(hooks, ctx, item as any);
          }

          return { count: items.length, deletedIds };
        });

        for (const id of result.deletedIds) {
          await deleteFromIndex(id);
        }

        await pushDeletesToSubscriptions(resourceName, result.deletedIds);

        res.json({ count: result.count });
      })
    );
  }

  let eventPollInterval: NodeJS.Timeout | null = null;
  let activeClients = 0;

  const startEventPolling = () => {
    if (eventPollInterval) return;

    eventPollInterval = setInterval(async () => {
      if (activeClients === 0) {
        stopEventPolling();
      }
    }, 30000);
  };

  const stopEventPolling = () => {
    if (eventPollInterval) {
      clearInterval(eventPollInterval);
      eventPollInterval = null;
    }
  };

  const sseConfig = {
    maxSubscriptionsPerUser: config.sse?.maxSubscriptionsPerUser ?? 10,
    maxSubscriptionsPerIP: config.sse?.maxSubscriptionsPerIP ?? 50,
    heartbeatMs: config.sse?.heartbeatMs ?? 20000,
    maxQueueBytes: config.sse?.maxQueueBytes ?? 65536,
    onBackpressure: config.sse?.onBackpressure ?? "invalidate",
  };

  const userSubscriptionCounts = new Map<string, number>();
  const ipSubscriptionCounts = new Map<string, number>();

  router.get(
    "/subscribe",
    asyncHandler(async (req, res) => {
      const user = getUser(req);
      const scope = await scopeResolver.resolve("subscribe", user);
      const filterQuery = req.query.filter?.toString() ?? "";
      const includeQuery = req.query.include?.toString();
      const handlerId = uuidv4();

      const resumeFrom = req.headers["last-event-id"]
        ? parseInt(req.headers["last-event-id"] as string, 10)
        : req.query.resumeFrom
          ? parseInt(req.query.resumeFrom.toString(), 10)
          : undefined;

      const skipExisting = req.query.skipExisting === "true";
      const knownIdsParam = req.query.knownIds?.toString();
      const knownIds = knownIdsParam ? knownIdsParam.split(",").filter(id => id.length > 0) : [];

      const userId = user?.id ?? "anonymous";
      const clientIP = req.ip ?? req.socket.remoteAddress ?? "unknown";

      const userCount = userSubscriptionCounts.get(userId) ?? 0;
      if (userCount >= sseConfig.maxSubscriptionsPerUser) {
        res.status(429).json({
          type: "/__concave/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerUser} subscriptions per user`,
        });
        return;
      }

      const ipCount = ipSubscriptionCounts.get(clientIP) ?? 0;
      if (ipCount >= sseConfig.maxSubscriptionsPerIP) {
        res.status(429).json({
          type: "/__concave/problems/rate-limit-exceeded",
          title: "Too many subscriptions",
          status: 429,
          detail: `Maximum ${sseConfig.maxSubscriptionsPerIP} subscriptions per IP`,
        });
        return;
      }

      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        "Connection": "keep-alive",
        "X-Accel-Buffering": "no",
        "X-Content-Type-Options": "nosniff",
      });
      res.flushHeaders?.();

      userSubscriptionCounts.set(userId, userCount + 1);
      ipSubscriptionCounts.set(clientIP, ipCount + 1);

      registerHandler(handlerId, res);
      activeClients++;
      startEventPolling();

      const currentSeq = await changelog.getCurrentSequence();
      res.write(`id: ${currentSeq}\nevent: connected\ndata: ${JSON.stringify({ seq: currentSeq })}\n\n`);

      let queuedBytes = 0;

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(`: ping ${Date.now()}\n\n`);
      }, sseConfig.heartbeatMs);

      const subscriptionId = await createSubscription({
        resource: resourceName,
        filter: filterQuery,
        handlerId,
        authId: user?.id ?? null,
        scopeFilter: scope.toString() !== "*" ? scope.toString() : undefined,
        authExpiresAt: user?.sessionExpiresAt,
        include: includeQuery,
      });

      res.on("drain", () => {
        queuedBytes = 0;
      });

      try {
        if (resumeFrom !== undefined) {
          if (await changelog.needsInvalidation(resumeFrom)) {
            await sendInvalidateEvent(subscriptionId, "Sequence gap - please refetch");
          }
        } else if (skipExisting) {
          // Client already has data from paginated GET, just register known IDs
          if (knownIds.length > 0) {
            await registerKnownIds(subscriptionId, knownIds);
          }
          // If no knownIds provided but skipExisting is true, we need to query
          // matching items to populate relevantObjectIds for proper change tracking
          // This ensures removed events work correctly when items leave the filter scope
          else {
            const combinedFilter = combineScopes(scope, filterQuery);
            const filter = combinedFilter && combinedFilter !== "*"
              ? (filterer.convert(combinedFilter) as SQL<unknown>)
              : undefined;

            const items = await db.select().from(schema).where(filter);
            const ids = (items as Record<string, unknown>[]).map(item => String(item[idColumnName]));
            await registerKnownIds(subscriptionId, ids);
          }
        } else {
          const combinedFilter = combineScopes(scope, filterQuery);
          const filter = combinedFilter && combinedFilter !== "*"
            ? (filterer.convert(combinedFilter) as SQL<unknown>)
            : undefined;

          const items = await db.select().from(schema).where(filter);
          await sendExistingItems(
            subscriptionId,
            items as Record<string, unknown>[],
            idColumnName
          );
        }
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        res.write(`event: error\ndata: ${JSON.stringify({ error: errorMessage })}\n\n`);
        res.end();
        return;
      }

      const cleanup = async () => {
        clearInterval(heartbeat);
        activeClients--;

        userSubscriptionCounts.set(
          userId,
          Math.max(0, (userSubscriptionCounts.get(userId) ?? 1) - 1)
        );
        ipSubscriptionCounts.set(
          clientIP,
          Math.max(0, (ipSubscriptionCounts.get(clientIP) ?? 1) - 1)
        );

        unregisterHandler(handlerId);

        if (activeClients === 0) {
          stopEventPolling();
        }

        await removeSubscription(subscriptionId);
      };

      req.on("close", cleanup);
      req.on("error", () => {
        clearInterval(heartbeat);
      });
    })
  );

  router.get(
    "/aggregate",
    asyncHandler(async (req, res) => {
      const filter = await applyFilters(req, "read");
      const params = parseAggregationParams(req.query as Record<string, unknown>);

      const { groupByColumns, aggregateColumns } = buildAggregationSelections(
        schema,
        params
      );

      const columns = getTableColumns(schema);
      const selectObj: Record<string, unknown> = {
        ...groupByColumns,
        ...aggregateColumns,
      };

      let query = db.select(selectObj as any).from(schema);

      if (filter) {
        query = query.where(filter) as any;
      }

      if (params.groupBy.length > 0) {
        const groupByCols = params.groupBy.map((f) => columns[f]).filter(Boolean);
        query = (query as any).groupBy(...groupByCols);
      }

      const results = await query;
      const transformed = transformAggregationResults(
        results as Record<string, unknown>[],
        params
      );

      res.json(transformed);
    })
  );

  router.get(
    "/count",
    asyncHandler(async (req, res) => {
      const filter = await applyFilters(req, "read");

      const [countData] = await db
        .select({ count: count() })
        .from(schema)
        .where(filter);

      res.json({ count: countData?.count ?? 0 });
    })
  );

  for (const [name, procedure] of Object.entries(procedures)) {
    router.post(
      `/rpc/${name}`,
      asyncHandler(async (req, res) => {
        const ctx = createProcedureContext(req);
        const result = await executeProcedure(procedure, ctx, req.body);
        res.json({ data: result });
      })
    );
  }

  // Search endpoint and auto-indexing
  const searchEnabled = config.search?.enabled !== false && hasGlobalSearch();
  const autoIndexEnabled = searchEnabled && config.search?.autoIndex !== false;
  const searchIndexName = config.search?.indexName ?? resourceName;

  const indexDocument = async (id: string, document: Record<string, unknown>) => {
    if (!autoIndexEnabled) return;
    try {
      const search = getGlobalSearch();
      await search.index(searchIndexName, id, document);
    } catch (err) {
      console.error(`Failed to index document ${id} in ${searchIndexName}:`, err);
    }
  };

  const deleteFromIndex = async (id: string) => {
    if (!autoIndexEnabled) return;
    try {
      const search = getGlobalSearch();
      await search.delete(searchIndexName, id);
    } catch (err) {
      console.error(`Failed to delete document ${id} from ${searchIndexName}:`, err);
    }
  };

  if (searchEnabled) {
    const searchConfig = config.search ?? {};
    const searchHandler = createSearchHandler(
      searchConfig,
      resourceName,
      idColumnName
    );

    router.get("/search", asyncHandler(searchHandler));
  }

  router.post(
    "/",
    asyncHandler(async (req, res) => {
      await scopeResolver.requirePermission("create", getUser(req));

      const ctx = createProcedureContext(req);
      let data = parseInsert(req.body);

      data = await executeBeforeCreate(hooks, ctx, data);

      const insertResult = await db.insert(schema).values(data).returning();
      const created = (insertResult as any[])[0];
      const createdObj = created as Record<string, unknown>;

      await executeAfterCreate(hooks, ctx, created);

      recordCreate(resourceName, String(createdObj[idColumnName]), createdObj);
      await indexDocument(String(createdObj[idColumnName]), createdObj);

      const optimisticId = req.headers["x-concave-optimistic-id"] as string | undefined;
      const optimisticIds = optimisticId
        ? new Map([[String(createdObj[idColumnName]), optimisticId]])
        : undefined;

      await pushInsertsToSubscriptions(
        resourceName,
        filterer as any,
        [createdObj],
        idColumnName,
        optimisticIds,
        subscriptionRelationLoader
      );

      const response = optimisticId
        ? { ...created, _optimisticId: optimisticId }
        : created;

      res.status(201).json(response);
    })
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const filter = await applyFilters(req, "read");
      const paginationParams = pagination.parseParams(req.query as Record<string, unknown>);
      const selectFields = parseSelect(req.query.select?.toString());
      const includeTotalCount = req.query.totalCount === "true";
      const includeSpecs = parseInclude(req.query.include?.toString());

      const orderByFields = parseOrderBy(paginationParams.orderBy);

      let query = db.select().from(schema);

      if (filter) {
        query = query.where(filter) as any;
      }

      if (paginationParams.cursor) {
        const cursorData = decodeCursorLegacy(paginationParams.cursor);
        if (cursorData) {
          const cursorCondition = pagination.buildCursorCondition(
            cursorData,
            orderByFields
          );
          if (cursorCondition) {
            query = query.where(
              filter ? and(filter, cursorCondition) : cursorCondition
            ) as any;
          }
        }
      }

      const orderByClauses = pagination.buildOrderBy(orderByFields);
      if (orderByClauses.length > 0) {
        query = (query as any).orderBy(...orderByClauses);
      }

      query = query.limit(paginationParams.limit + 1) as any;

      let items = await query;

      let totalCount: number | undefined;
      if (includeTotalCount) {
        const [countResult] = await db
          .select({ count: count() })
          .from(schema)
          .where(filter);
        totalCount = countResult?.count ?? 0;
      }

      const result = pagination.processResults(
        items as Record<string, unknown>[],
        paginationParams.limit,
        idColumnName,
        orderByFields,
        totalCount
      );

      if (relationLoader && includeSpecs.length > 0) {
        result.items = await relationLoader.loadRelationsForItems(
          result.items,
          includeSpecs,
          idColumnName
        );
      }

      if (selectFields) {
        result.items = applyProjection(result.items, selectFields) as any;
      }

      res.json(result);
    })
  );

  router.get(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const filter = await applyFilters(req, "read", `${idColumnName}=="${id}"`);
      const selectFields = parseSelect(req.query.select?.toString());
      const includeSpecs = parseInclude(req.query.include?.toString());

      const selectResult = await db.select().from(schema).where(filter);
      const item = (selectResult as any[])[0];

      if (!item) {
        throw new NotFoundError(resourceName, id);
      }

      let result = item;

      if (relationLoader && includeSpecs.length > 0) {
        result = await relationLoader.loadRelationsForItem(
          result as Record<string, unknown>,
          includeSpecs,
          idColumnName
        );
      }

      if (selectFields) {
        result = applyProjection([result], selectFields)[0] as typeof item;
      }

      res.json(result);
    })
  );

  router.put(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const filter = await applyFilters(req, "update", `${idColumnName}=="${id}"`);

      const existingResult = await db.select().from(schema).where(filter);
      const existing = (existingResult as any[])[0];
      if (!existing) {
        throw new NotFoundError(resourceName, id);
      }

      const ctx = createProcedureContext(req);
      let data = parseInsert(req.body);

      const updateData = await executeBeforeUpdate(hooks, ctx, id, data as any);

      const updateResult = await db
        .update(schema)
        .set(updateData as any)
        .where(filter)
        .returning();
      const updated = (updateResult as any[])[0];

      await executeAfterUpdate(hooks, ctx, updated);

      recordUpdate(resourceName, id, updated, existing);
      await indexDocument(id, updated);

      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set(id, existing);
      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        [updated],
        idColumnName,
        previousMap,
        subscriptionRelationLoader
      );

      res.json(updated);
    })
  );

  router.patch(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const filter = await applyFilters(req, "update", `${idColumnName}=="${id}"`);

      const existingResult = await db.select().from(schema).where(filter);
      const existing = (existingResult as any[])[0];
      if (!existing) {
        throw new NotFoundError(resourceName, id);
      }

      const ctx = createProcedureContext(req);
      let data = parseUpdate(req.body);

      data = await executeBeforeUpdate(hooks, ctx, id, data);

      const updateResult = await db
        .update(schema)
        .set(data as any)
        .where(filter)
        .returning();
      const updated = (updateResult as any[])[0];

      await executeAfterUpdate(hooks, ctx, updated);

      recordUpdate(resourceName, id, updated, existing);
      await indexDocument(id, updated);

      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set(id, existing);
      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        [updated],
        idColumnName,
        previousMap,
        subscriptionRelationLoader
      );

      res.json(updated);
    })
  );

  router.delete(
    "/:id",
    asyncHandler(async (req, res) => {
      const id = req.params.id as string;
      const filter = await applyFilters(req, "delete", `${idColumnName}=="${id}"`);

      const existingResult = await db.select().from(schema).where(filter);
      const existing = (existingResult as any[])[0];
      if (!existing) {
        throw new NotFoundError(resourceName, id);
      }

      const ctx = createProcedureContext(req);

      await executeBeforeDelete(hooks, ctx, id);

      await db.delete(schema).where(filter);

      await executeAfterDelete(hooks, ctx, existing);

      recordDelete(resourceName, id, existing);
      await deleteFromIndex(id);

      await pushDeletesToSubscriptions(resourceName, [id]);

      res.status(204).send();
    })
  );

  return router;
};

export type { ResourceConfig, CustomOperator, ProcedureDefinition, LifecycleHooks };
