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
} from "./subscription";
import {
  createPagination,
  decodeCursor,
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
import {
  ResourceConfig,
  CustomOperator,
  ProcedureDefinition,
  LifecycleHooks,
  UserContext,
  ProcedureContext,
  DrizzleTransaction,
} from "./types";
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

export const useResource = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  config: ResourceConfig<TConfig, Table<TConfig>>
): IRouter => {
  const db = config.db;
  const handlerId = uuidv4();
  const resourceName = getTableName(schema);
  const idColumnName = config.id.name;

  const router = Router();

  const filterer = createResourceFilter(schema, config.customOperators ?? {});

  const pagination = createPagination(
    schema,
    config.id,
    config.pagination ?? DEFAULT_PAGINATION
  );

  const queryHelper = createQueryHelper(schema);

  const scopeResolver = createScopeResolver(config.auth, resourceName);

  const insertSchema = createInsertSchema(schema);
  const updateSchema = createUpdateSchema(schema);

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

  const createProcedureContext = (req: Request): ProcedureContext<TConfig> => ({
    db,
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
        }

        await pushInsertsToSubscriptions(
          resourceName,
          filterer as any,
          createdArray,
          idColumnName
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

        await pushUpdatesToSubscriptions(
          resourceName,
          filterer as any,
          result.items,
          idColumnName,
          result.previousMap
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
      if (!isHandlerConnected(handlerId)) {
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

  router.get(
    "/subscribe",
    asyncHandler(async (req, res) => {
      const user = getUser(req);
      const scope = await scopeResolver.resolve("subscribe", user);
      const filterQuery = req.query.filter?.toString() ?? "";
      const resumeFrom = req.query.resumeFrom
        ? parseInt(req.query.resumeFrom.toString(), 10)
        : undefined;

      res.set({
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      res.flushHeaders?.();

      registerHandler(handlerId, res);
      activeClients++;
      startEventPolling();

      const currentSeq = changelog.getCurrentSequence();
      res.write(`event: connected\ndata: ${JSON.stringify({ seq: currentSeq })}\n\n`);

      const heartbeat = setInterval(() => {
        if (res.writableEnded) {
          clearInterval(heartbeat);
          return;
        }
        res.write(`: ping\n\n`);
      }, 20000);

      const subscriptionId = await createSubscription({
        resource: resourceName,
        filter: filterQuery,
        handlerId,
        authId: user?.id ?? null,
        scopeFilter: scope.toString() !== "*" ? scope.toString() : undefined,
        authExpiresAt: user?.sessionExpiresAt,
      });

      if (resumeFrom !== undefined) {
        if (await changelog.needsInvalidation(resumeFrom)) {
          await sendInvalidateEvent(subscriptionId, "Sequence gap - please refetch");
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

      req.on("close", async () => {
        clearInterval(heartbeat);
        activeClients--;

        if (activeClients === 0) {
          stopEventPolling();
          unregisterHandler(handlerId);
        }

        await removeSubscription(subscriptionId);
      });

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

      await pushInsertsToSubscriptions(
        resourceName,
        filterer as any,
        [createdObj],
        idColumnName
      );

      res.status(201).json(created);
    })
  );

  router.get(
    "/",
    asyncHandler(async (req, res) => {
      const filter = await applyFilters(req, "read");
      const paginationParams = pagination.parseParams(req.query as Record<string, unknown>);
      const selectFields = parseSelect(req.query.select?.toString());
      const includeTotalCount = req.query.totalCount === "true";

      const orderByFields = parseOrderBy(paginationParams.orderBy);

      let query = db.select().from(schema);

      if (filter) {
        query = query.where(filter) as any;
      }

      if (paginationParams.cursor) {
        const cursorData = decodeCursor(paginationParams.cursor);
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

      const items = await query;

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

      const selectResult = await db.select().from(schema).where(filter);
      const item = (selectResult as any[])[0];

      if (!item) {
        throw new NotFoundError(resourceName, id);
      }

      let result = item;
      if (selectFields) {
        result = applyProjection([item], selectFields)[0] as typeof item;
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

      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set(id, existing);
      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        [updated],
        idColumnName,
        previousMap
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

      const previousMap = new Map<string, Record<string, unknown>>();
      previousMap.set(id, existing);
      await pushUpdatesToSubscriptions(
        resourceName,
        filterer as any,
        [updated],
        idColumnName,
        previousMap
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

      await pushDeletesToSubscriptions(resourceName, [id]);

      res.status(204).send();
    })
  );

  return router;
};

export type { ResourceConfig, CustomOperator, ProcedureDefinition, LifecycleHooks };
