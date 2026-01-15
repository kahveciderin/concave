import {
  Table,
  TableConfig,
  SQL,
  sql,
  asc,
  desc,
  gt,
  lt,
  eq,
  or,
  and,
  AnyColumn,
  getTableColumns,
} from "drizzle-orm";
import { PaginationParams, PaginatedResult } from "./types";
import { ValidationError } from "./error";

export interface CursorData {
  v: unknown; // orderBy value
  id: string; // primary key value
}

export interface PaginationConfig {
  defaultLimit: number;
  maxLimit: number;
}

const DEFAULT_CONFIG: PaginationConfig = {
  defaultLimit: 20,
  maxLimit: 100,
};

export const encodeCursor = (data: CursorData): string => {
  return Buffer.from(JSON.stringify(data)).toString("base64url");
};

export const decodeCursor = (cursor: string): CursorData | null => {
  try {
    const decoded = Buffer.from(cursor, "base64url").toString("utf-8");
    const data = JSON.parse(decoded);
    if (typeof data !== "object" || data === null) return null;
    if (!("v" in data) || !("id" in data)) return null;
    return data as CursorData;
  } catch {
    return null;
  }
};

export interface OrderByField {
  field: string;
  direction: "asc" | "desc";
}

export const parseOrderBy = (orderBy?: string): OrderByField[] => {
  if (!orderBy) return [];

  return orderBy.split(",").map((part) => {
    const [field, dir] = part.trim().split(":");
    const direction = dir?.toLowerCase() === "desc" ? "desc" : "asc";
    return { field, direction };
  });
};

export const buildOrderByClause = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  orderByFields: OrderByField[]
): SQL[] => {
  const columns = getTableColumns(schema);
  const clauses: SQL[] = [];

  for (const { field, direction } of orderByFields) {
    const column = columns[field];
    if (!column) {
      throw new ValidationError(`Invalid orderBy field: ${field}`);
    }
    clauses.push(direction === "desc" ? desc(column) : asc(column));
  }

  clauses.push(asc(idColumn));

  return clauses;
};

export const buildCursorCondition = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  cursor: CursorData,
  orderByFields: OrderByField[],
  direction: "forward" | "backward" = "forward"
): SQL | undefined => {
  const columns = getTableColumns(schema);

  if (orderByFields.length === 0) {
    const compare = direction === "forward" ? gt : lt;
    return compare(idColumn, cursor.id);
  }

  const conditions: SQL[] = [];
  const cursorValues = cursor.v as Record<string, unknown>;

  for (let i = 0; i < orderByFields.length; i++) {
    const { field, direction: fieldDir } = orderByFields[i];
    const column = columns[field];
    if (!column) continue;

    const cursorValue = cursorValues[field];
    const equalParts: SQL[] = [];

    for (let j = 0; j < i; j++) {
      const prevField = orderByFields[j].field;
      const prevColumn = columns[prevField];
      if (prevColumn) {
        equalParts.push(eq(prevColumn, cursorValues[prevField]));
      }
    }

    const isDesc = fieldDir === "desc";
    const isBackward = direction === "backward";
    const useGreaterThan = isDesc !== isBackward;
    const compare = useGreaterThan ? lt : gt;

    if (equalParts.length > 0) {
      conditions.push(and(...equalParts, compare(column, cursorValue))!);
    } else {
      conditions.push(compare(column, cursorValue));
    }
  }

  const allEqual: SQL[] = [];
  for (const { field } of orderByFields) {
    const column = columns[field];
    if (column) {
      allEqual.push(eq(column, cursorValues[field]));
    }
  }

  const idCompare = direction === "forward" ? gt : lt;
  conditions.push(and(...allEqual, idCompare(idColumn, cursor.id))!);

  return or(...conditions);
};

export const extractCursorValues = <T extends Record<string, unknown>>(
  item: T,
  idColumn: string,
  orderByFields: OrderByField[]
): CursorData => {
  const values: Record<string, unknown> = {};

  for (const { field } of orderByFields) {
    values[field] = item[field];
  }

  return {
    v: orderByFields.length > 0 ? values : item[idColumn],
    id: String(item[idColumn]),
  };
};

export const processPaginatedResults = <T extends Record<string, unknown>>(
  items: T[],
  limit: number,
  idColumn: string,
  orderByFields: OrderByField[],
  totalCount?: number
): PaginatedResult<T> => {
  const hasMore = items.length > limit;
  const resultItems = hasMore ? items.slice(0, limit) : items;

  let nextCursor: string | null = null;
  if (hasMore && resultItems.length > 0) {
    const lastItem = resultItems[resultItems.length - 1];
    nextCursor = encodeCursor(
      extractCursorValues(lastItem, idColumn, orderByFields)
    );
  }

  return {
    items: resultItems,
    nextCursor,
    hasMore,
    totalCount,
  };
};

export const normalizePaginationParams = (
  params: Partial<PaginationParams>,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationParams => {
  let limit = params.limit ?? config.defaultLimit;

  if (limit < 1) {
    limit = 1;
  } else if (limit > config.maxLimit) {
    limit = config.maxLimit;
  }

  return {
    cursor: params.cursor,
    limit,
    orderBy: params.orderBy,
    orderDirection: params.orderDirection ?? "asc",
  };
};

export const parsePaginationFromQuery = (
  query: Record<string, unknown>,
  config: PaginationConfig = DEFAULT_CONFIG
): PaginationParams => {
  const cursor =
    typeof query.cursor === "string" ? query.cursor : undefined;
  const limit =
    typeof query.limit === "string"
      ? parseInt(query.limit, 10)
      : typeof query.limit === "number"
        ? query.limit
        : config.defaultLimit;
  const orderBy =
    typeof query.orderBy === "string" ? query.orderBy : undefined;
  const orderDirection =
    query.orderDirection === "desc" ? "desc" : "asc";

  return normalizePaginationParams(
    { cursor, limit, orderBy, orderDirection },
    config
  );
};

export const createPagination = <TConfig extends TableConfig>(
  schema: Table<TConfig>,
  idColumn: AnyColumn,
  config: Partial<PaginationConfig> = {}
) => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };

  return {
    config: mergedConfig,

    parseParams: (query: Record<string, unknown>) =>
      parsePaginationFromQuery(query, mergedConfig),

    buildOrderBy: (orderByFields: OrderByField[]) =>
      buildOrderByClause(schema, idColumn, orderByFields),

    buildCursorCondition: (
      cursor: CursorData,
      orderByFields: OrderByField[],
      direction: "forward" | "backward" = "forward"
    ) => buildCursorCondition(schema, idColumn, cursor, orderByFields, direction),

    processResults: <T extends Record<string, unknown>>(
      items: T[],
      limit: number,
      idColumn: string,
      orderByFields: OrderByField[],
      totalCount?: number
    ) => processPaginatedResults(items, limit, idColumn, orderByFields, totalCount),

    encodeCursor,
    decodeCursor,
    parseOrderBy,
  };
};

export { DEFAULT_CONFIG as defaultPaginationConfig };
