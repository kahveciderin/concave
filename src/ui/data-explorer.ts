import { Router, Request, Response } from "express";
import { SQL, getTableColumns, eq, and, count } from "drizzle-orm";
import {
  getResourceSchema,
  getAllResourceSchemas,
  getSchemaInfo,
  getAllSchemaInfos,
} from "./schema-registry";
import { createResourceFilter } from "@/resource/filter";
import {
  createPagination,
  decodeCursorLegacy,
  parseOrderBy,
} from "@/resource/pagination";
import {
  logAdminAction,
  getAdminUser,
  requireAdminUser,
  AdminSecurityConfig,
  detectEnvironment,
} from "./admin-auth";

export interface DataExplorerConfig {
  enabled?: boolean;
  resources?: string[];
  excludeFields?: Record<string, string[]>;
  maxLimit?: number;
  readOnly?: boolean;
}

const DEFAULT_MAX_LIMIT = 100;

const applyFieldExclusion = (
  item: Record<string, unknown>,
  excludeFields?: string[]
): Record<string, unknown> => {
  if (!excludeFields || excludeFields.length === 0) return item;
  const result = { ...item };
  for (const field of excludeFields) {
    if (field in result) {
      result[field] = "[REDACTED]";
    }
  }
  return result;
};

export const createDataExplorerRoutes = (
  config: DataExplorerConfig = {},
  securityConfig: AdminSecurityConfig = {}
): Router => {
  const router = Router();
  const maxLimit = config.maxLimit ?? DEFAULT_MAX_LIMIT;
  const mode = securityConfig.mode ?? detectEnvironment();

  const isReadOnly =
    config.readOnly ?? (mode === "production" ? true : false);

  const isResourceAllowed = (name: string): boolean => {
    if (!config.resources || config.resources.length === 0) return true;
    return config.resources.includes(name);
  };

  router.get("/schemas", (_req: Request, res: Response) => {
    let schemas = getAllSchemaInfos();
    if (config.resources && config.resources.length > 0) {
      schemas = schemas.filter((s) => config.resources!.includes(s.name));
    }
    res.json({ schemas, mode, readOnly: isReadOnly });
  });

  router.get("/schemas/:resource", (req: Request, res: Response) => {
    const resource = req.params.resource as string;

    if (!isResourceAllowed(resource)) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
        detail: `Resource '${resource}' is not available in the data explorer`,
      });
      return;
    }

    const schema = getSchemaInfo(resource);
    if (!schema) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
        detail: `Resource '${resource}' not found`,
      });
      return;
    }

    res.json({ schema });
  });

  router.get("/data/:resource", async (req: Request, res: Response) => {
    const resource = req.params.resource as string;
    const adminUser = getAdminUser(req);

    if (!isResourceAllowed(resource)) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
      });
      return;
    }

    const entry = getResourceSchema(resource);
    if (!entry) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
      });
      return;
    }

    const db = entry.db;
    const schema = entry.schema;
    const idColumnName = entry.idColumn.name;

    const filterStr = (req.query.filter as string) ?? "";
    const limitNum = Math.min(
      parseInt((req.query.limit as string) ?? "20", 10),
      maxLimit
    );
    const cursor = req.query.cursor as string | undefined;
    const orderByStr = (req.query.orderBy as string) ?? idColumnName;
    const selectStr = req.query.select as string | undefined;
    const includeTotalCount = req.query.totalCount === "true";

    try {
      const filterer = createResourceFilter(schema, {});
      const pagination = createPagination(schema, entry.idColumn, {
        defaultLimit: 20,
        maxLimit,
      });

      const orderByFields = parseOrderBy(orderByStr);

      let filter: SQL<unknown> | undefined;
      if (filterStr) {
        filter = filterer.convert(filterStr) as SQL<unknown>;
      }

      let query = db.select().from(schema);

      if (filter) {
        query = query.where(filter);
      }

      if (cursor) {
        const cursorData = decodeCursorLegacy(cursor);
        if (cursorData) {
          const cursorCondition = pagination.buildCursorCondition(
            cursorData,
            orderByFields
          );
          if (cursorCondition) {
            query = query.where(
              filter ? and(filter, cursorCondition) : cursorCondition
            );
          }
        }
      }

      const orderByClauses = pagination.buildOrderBy(orderByFields);
      if (orderByClauses.length > 0) {
        query = query.orderBy(...orderByClauses);
      }

      query = query.limit(limitNum + 1);

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
        limitNum,
        idColumnName,
        orderByFields,
        totalCount
      );

      const excludeFields = config.excludeFields?.[resource];
      if (excludeFields) {
        result.items = result.items.map((item) =>
          applyFieldExclusion(item, excludeFields)
        );
      }

      if (selectStr) {
        const fields = selectStr.split(",").map((f) => f.trim());
        result.items = result.items.map((item) => {
          const filtered: Record<string, unknown> = {};
          for (const field of fields) {
            if (field in item) {
              filtered[field] = item[field];
            }
          }
          return filtered;
        });
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_list",
          resource,
          reason: `Admin browse: filter=${filterStr || "none"}, limit=${limitNum}`,
        });
      }

      res.json({
        ...result,
        adminBypass: true,
        warning: "Admin bypass active - all scopes bypassed",
      });
    } catch (error) {
      res.status(400).json({
        type: "/__concave/problems/filter-parse-error",
        title: "Invalid query",
        status: 400,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/data/:resource/:id", async (req: Request, res: Response) => {
    const resource = req.params.resource as string;
    const id = req.params.id as string;
    const adminUser = getAdminUser(req);

    if (!isResourceAllowed(resource)) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
      });
      return;
    }

    const entry = getResourceSchema(resource);
    if (!entry) {
      res.status(404).json({
        type: "/__concave/problems/not-found",
        title: "Resource not found",
        status: 404,
      });
      return;
    }

    const db = entry.db;
    const schema = entry.schema;
    const columns = getTableColumns(schema);
    const idColumn = columns[entry.idColumn.name];

    if (!idColumn) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Internal error",
        status: 500,
        detail: "ID column not found",
      });
      return;
    }

    try {
      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Record not found",
          status: 404,
          detail: `Record with id '${id}' not found in '${resource}'`,
        });
        return;
      }

      let result = item as Record<string, unknown>;
      const excludeFields = config.excludeFields?.[resource];
      if (excludeFields) {
        result = applyFieldExclusion(result, excludeFields);
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_get",
          resource,
          resourceId: id,
          reason: "Admin view record",
        });
      }

      res.json({
        item: result,
        adminBypass: true,
        warning: "Admin bypass active - all scopes bypassed",
      });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Internal error",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  if (!isReadOnly) {
    router.post("/data/:resource", async (req: Request, res: Response) => {
      const resource = req.params.resource as string;
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      if (!isResourceAllowed(resource)) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const data = req.body;

      try {
        const [created] = await db.insert(schema).values(data).returning();

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_create",
          resource,
          resourceId: String((created as Record<string, unknown>)[entry.idColumn.name]),
          reason: "Admin create record",
          afterValue: created as Record<string, unknown>,
        });

        res.status(201).json({
          item: created,
          adminBypass: true,
        });
      } catch (error) {
        res.status(400).json({
          type: "/__concave/problems/validation-error",
          title: "Create failed",
          status: 400,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    router.patch("/data/:resource/:id", async (req: Request, res: Response) => {
      const resource = req.params.resource as string;
      const id = req.params.id as string;
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      if (!isResourceAllowed(resource)) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];
      const data = req.body;

      if (!idColumn) {
        res.status(500).json({
          type: "/__concave/problems/internal-error",
          title: "Internal error",
          status: 500,
        });
        return;
      }

      try {
        const [existing] = await db.select().from(schema).where(eq(idColumn, id));
        if (!existing) {
          res.status(404).json({
            type: "/__concave/problems/not-found",
            title: "Record not found",
            status: 404,
          });
          return;
        }

        const [updated] = await db
          .update(schema)
          .set(data)
          .where(eq(idColumn, id))
          .returning();

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_update",
          resource,
          resourceId: id,
          reason: "Admin update record",
          beforeValue: existing as Record<string, unknown>,
          afterValue: updated as Record<string, unknown>,
        });

        res.json({
          item: updated,
          adminBypass: true,
        });
      } catch (error) {
        res.status(400).json({
          type: "/__concave/problems/validation-error",
          title: "Update failed",
          status: 400,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    router.delete("/data/:resource/:id", async (req: Request, res: Response) => {
      const resource = req.params.resource as string;
      const id = req.params.id as string;
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      if (!isResourceAllowed(resource)) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Resource not found",
          status: 404,
        });
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      if (!idColumn) {
        res.status(500).json({
          type: "/__concave/problems/internal-error",
          title: "Internal error",
          status: 500,
        });
        return;
      }

      try {
        const [existing] = await db.select().from(schema).where(eq(idColumn, id));
        if (!existing) {
          res.status(404).json({
            type: "/__concave/problems/not-found",
            title: "Record not found",
            status: 404,
          });
          return;
        }

        await db.delete(schema).where(eq(idColumn, id));

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "data_explorer_delete",
          resource,
          resourceId: id,
          reason: "Admin delete record",
          beforeValue: existing as Record<string, unknown>,
        });

        res.status(204).send();
      } catch (error) {
        res.status(400).json({
          type: "/__concave/problems/validation-error",
          title: "Delete failed",
          status: 400,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  }

  return router;
};
