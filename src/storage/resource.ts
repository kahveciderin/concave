import { Router, Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";
import type { SQLiteColumn } from "drizzle-orm/sqlite-core";
import type { PgColumn } from "drizzle-orm/pg-core";
import { eq, inArray, Table, TableConfig, InferSelectModel, getTableName } from "drizzle-orm";
import {
  StorageAdapter,
  getGlobalStorage,
  hasGlobalStorage,
  PresignedUrlOptions,
} from "./types";
import {
  NotFoundError,
  ValidationError,
  UnauthorizedError,
  ForbiddenError,
} from "@/resource/error";
import { createResourceFilter } from "@/resource/filter";
import type { ScopeFunction, UserContext } from "@/resource/types";
import type { AuthenticatedRequest } from "@/auth/types";
import { registerResourceSchema } from "@/ui";

type DrizzleColumn = SQLiteColumn | PgColumn;

export interface FileRecord {
  id: string;
  userId?: string | null;
  filename: string;
  mimeType: string;
  size: number;
  storagePath: string;
  url?: string | null;
  status: "pending" | "completed";
  createdAt: Date;
}

export interface FileTableSchema {
  id: DrizzleColumn;
  userId?: DrizzleColumn;
  filename: DrizzleColumn;
  mimeType: DrizzleColumn;
  size: DrizzleColumn;
  storagePath: DrizzleColumn;
  url?: DrizzleColumn;
  status: DrizzleColumn;
  createdAt: DrizzleColumn;
}

export interface FileResourceConfig {
  db: unknown;
  schema: FileTableSchema;
  id: DrizzleColumn;
  storage?: StorageAdapter;
  allowedMimeTypes?: string[];
  maxFileSize?: number;
  generateKey?: (filename: string, userId?: string) => string;
  auth?: {
    read?: ScopeFunction;
    create?: ScopeFunction;
    delete?: ScopeFunction;
  };
  usePresignedUrls?: boolean;
  presignedUrlExpiry?: number;
}

const defaultGenerateKey = (filename: string, userId?: string): string => {
  const timestamp = Date.now();
  const uuid = randomUUID().slice(0, 8);
  const sanitized = filename.replace(/[^a-zA-Z0-9.-]/g, "_");
  if (userId) {
    return `${userId}/${timestamp}-${uuid}-${sanitized}`;
  }
  return `${timestamp}-${uuid}-${sanitized}`;
};

const parseMultipartFormData = async (
  req: Request
): Promise<{ file: Buffer; filename: string; mimeType: string } | null> => {
  const contentType = req.headers["content-type"] || "";

  if (!contentType.includes("multipart/form-data")) {
    return null;
  }

  const boundaryMatch = contentType.match(/boundary=(.+)/);
  if (!boundaryMatch) {
    return null;
  }

  const boundary = boundaryMatch[1];
  const chunks: Buffer[] = [];

  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const body = Buffer.concat(chunks);
  const bodyStr = body.toString("binary");
  const parts = bodyStr.split(`--${boundary}`);

  for (const part of parts) {
    if (part.includes("Content-Disposition: form-data")) {
      const headerEnd = part.indexOf("\r\n\r\n");
      if (headerEnd === -1) continue;

      const headers = part.slice(0, headerEnd);
      const filenameMatch = headers.match(/filename="([^"]+)"/);
      const contentTypeMatch = headers.match(/Content-Type:\s*([^\r\n]+)/i);

      if (filenameMatch) {
        const filename = filenameMatch[1];
        const mimeType = contentTypeMatch?.[1]?.trim() || "application/octet-stream";

        let content = part.slice(headerEnd + 4);
        if (content.endsWith("\r\n")) {
          content = content.slice(0, -2);
        }

        const fileBuffer = Buffer.from(content, "binary");
        return { file: fileBuffer, filename, mimeType };
      }
    }
  }

  return null;
};

const checkScopeAccess = async <T>(
  scopeFn: ScopeFunction | undefined,
  user: UserContext | null,
  record?: FileRecord,
  filterExecute?: (expr: string, obj: T) => boolean
): Promise<boolean> => {
  if (!scopeFn) return true;
  if (!user) return false;

  const scope = await scopeFn(user);
  const scopeStr = scope.toString();

  if (scopeStr === "*") return true;
  if (scope.isEmpty()) return false;

  if (record && filterExecute) {
    return filterExecute(scopeStr, record as unknown as T);
  }

  return true;
};

export const useFileResource = <TConfig extends TableConfig>(
  table: Table<TConfig> & FileTableSchema,
  config: FileResourceConfig
): Router => {
  const router = Router();
  type SchemaType = InferSelectModel<typeof table>;

  const storage = config.storage ?? (hasGlobalStorage() ? getGlobalStorage() : null);
  if (!storage) {
    throw new Error(
      "Storage not configured. Either pass storage in config or call initializeStorage() first."
    );
  }

  const {
    db,
    id: idColumn,
    allowedMimeTypes,
    maxFileSize,
    generateKey = defaultGenerateKey,
    auth,
    usePresignedUrls = false,
    presignedUrlExpiry = 3600,
  } = config;

  const resourceFilter = createResourceFilter(table);

  const getUser = (req: Request): UserContext | null => {
    return (req as AuthenticatedRequest).user ?? null;
  };

  const getUserId = (user: UserContext | null): string | undefined => {
    return user?.id;
  };

  const dbQuery = db as {
    select(): {
      from(table: unknown): {
        where(condition: unknown): {
          limit(n: number): Promise<unknown[]>;
        };
        limit(n: number): {
          offset(n: number): Promise<unknown[]>;
        };
      };
    };
    insert(table: unknown): {
      values(data: unknown): {
        returning(): Promise<unknown[]>;
      };
    };
    update(table: unknown): {
      set(data: unknown): {
        where(condition: unknown): {
          returning(): Promise<unknown[]>;
        };
      };
    };
    delete(table: unknown): {
      where(condition: unknown): Promise<void>;
    };
  };

  const resourceName = getTableName(table);

  registerResourceSchema(
    resourceName,
    table,
    db as Parameters<typeof registerResourceSchema>[2],
    idColumn,
    { generatedFields: ["id", "storagePath", "status", "createdAt"] }
  );

  const executeFilter = (expr: string, obj: SchemaType): boolean => {
    return resourceFilter.execute(expr, obj);
  };

  router.post("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const canCreate = await checkScopeAccess(auth?.create, user);
      if (!canCreate) {
        throw new UnauthorizedError("Not authorized to upload files");
      }

      const parsed = await parseMultipartFormData(req);
      if (!parsed) {
        throw new ValidationError("No file provided or invalid multipart form data");
      }

      const { file, filename, mimeType } = parsed;

      if (allowedMimeTypes && !allowedMimeTypes.includes(mimeType)) {
        throw new ValidationError(
          `File type not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`
        );
      }

      if (maxFileSize && file.length > maxFileSize) {
        throw new ValidationError(
          `File too large. Maximum size: ${Math.round(maxFileSize / 1024 / 1024)}MB`
        );
      }

      const userId = getUserId(user);
      const key = generateKey(filename, userId);

      const result = await storage.upload(key, file, {
        filename,
        mimeType,
      });

      const url = storage.getUrl(key);
      const id = randomUUID();

      const fileRecord = {
        id,
        userId: userId ?? null,
        filename,
        mimeType,
        size: result.size,
        storagePath: key,
        url,
        status: "completed" as const,
        createdAt: new Date(),
      };

      const [created] = await dbQuery
        .insert(table)
        .values(fileRecord)
        .returning();

      res.status(201).json({ data: created });
    } catch (error) {
      next(error);
    }
  });

  router.get("/upload-url", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const canCreate = await checkScopeAccess(auth?.create, user);
      if (!canCreate) {
        throw new UnauthorizedError("Not authorized to upload files");
      }

      if (!storage.supportsPresignedUrls()) {
        throw new ValidationError("This storage adapter does not support presigned URLs");
      }

      const filename = req.query.filename as string;
      const contentType = req.query.contentType as string;

      if (!filename) {
        throw new ValidationError("filename query parameter is required");
      }

      if (allowedMimeTypes && contentType && !allowedMimeTypes.includes(contentType)) {
        throw new ValidationError(
          `File type not allowed. Allowed types: ${allowedMimeTypes.join(", ")}`
        );
      }

      const userId = getUserId(user);
      const key = generateKey(filename, userId);

      const presignedOptions: PresignedUrlOptions = {
        expiresIn: presignedUrlExpiry,
        contentType,
      };

      if (maxFileSize) {
        presignedOptions.contentLength = maxFileSize;
      }

      const uploadUrl = await storage.getUploadUrl(key, presignedOptions);
      if (!uploadUrl) {
        throw new ValidationError("Failed to generate upload URL");
      }

      const id = randomUUID();
      const fileRecord = {
        id,
        userId: userId ?? null,
        filename,
        mimeType: contentType || "application/octet-stream",
        size: 0,
        storagePath: key,
        url: null,
        status: "pending" as const,
        createdAt: new Date(),
      };

      await dbQuery.insert(table).values(fileRecord).returning();

      res.json({
        data: {
          fileId: id,
          uploadUrl: uploadUrl.url,
          fields: uploadUrl.fields,
          key,
          expiresAt: uploadUrl.expiresAt,
        },
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/:id/confirm", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const fileId = req.params.id as string;

      const [file] = await dbQuery
        .select()
        .from(table)
        .where(eq(idColumn, fileId))
        .limit(1) as FileRecord[];

      if (!file) {
        throw new NotFoundError("File", fileId);
      }

      const canRead = await checkScopeAccess<SchemaType>(
        auth?.read,
        user,
        file,
        executeFilter
      );
      if (!canRead) {
        throw new ForbiddenError("Not authorized to access this file");
      }

      if (file.status === "completed") {
        res.json({ data: file });
        return;
      }

      const metadata = await storage.getMetadata(file.storagePath);
      if (!metadata) {
        throw new NotFoundError("File", file.storagePath);
      }

      const url = storage.getUrl(file.storagePath);

      const [updated] = await dbQuery
        .update(table)
        .set({
          size: metadata.size,
          mimeType: metadata.mimeType,
          url,
          status: "completed",
        })
        .where(eq(idColumn, fileId))
        .returning() as FileRecord[];

      res.json({ data: updated });
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const fileId = req.params.id as string;

      const [file] = await dbQuery
        .select()
        .from(table)
        .where(eq(idColumn, fileId))
        .limit(1) as FileRecord[];

      if (!file) {
        throw new NotFoundError("File", fileId);
      }

      const canRead = await checkScopeAccess<SchemaType>(
        auth?.read,
        user,
        file,
        executeFilter
      );
      if (!canRead) {
        throw new ForbiddenError("Not authorized to access this file");
      }

      res.json({ data: file });
    } catch (error) {
      next(error);
    }
  });

  router.get("/", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 100);
      const offset = parseInt(req.query.offset as string) || 0;
      const filter = req.query.filter as string | undefined;

      const canRead = await checkScopeAccess(auth?.read, user);
      if (!canRead) {
        throw new ForbiddenError("Not authorized to list files");
      }

      let scopeFilter = "";
      if (auth?.read && user) {
        const scope = await auth.read(user);
        const scopeStr = scope.toString();
        if (scopeStr !== "*" && !scope.isEmpty()) {
          scopeFilter = scopeStr;
        }
      }

      let combinedFilter = filter || "";
      if (scopeFilter && combinedFilter) {
        combinedFilter = `(${scopeFilter});(${combinedFilter})`;
      } else if (scopeFilter) {
        combinedFilter = scopeFilter;
      }

      if (combinedFilter) {
        const whereCondition = resourceFilter.convert(combinedFilter);
        const files = await dbQuery
          .select()
          .from(table)
          .where(whereCondition)
          .limit(limit) as unknown[];
        res.json({ data: files });
      } else {
        const files = await dbQuery
          .select()
          .from(table)
          .limit(limit)
          .offset(offset);
        res.json({ data: files });
      }
    } catch (error) {
      next(error);
    }
  });

  router.get("/:id/download", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const fileId = req.params.id as string;

      const [file] = await dbQuery
        .select()
        .from(table)
        .where(eq(idColumn, fileId))
        .limit(1) as FileRecord[];

      if (!file) {
        throw new NotFoundError("File", fileId);
      }

      const canRead = await checkScopeAccess<SchemaType>(
        auth?.read,
        user,
        file,
        executeFilter
      );
      if (!canRead) {
        throw new ForbiddenError("Not authorized to access this file");
      }

      if (file.status !== "completed") {
        throw new ValidationError("File upload not completed");
      }

      if (usePresignedUrls && storage.supportsPresignedUrls()) {
        const downloadUrl = await storage.getDownloadUrl(file.storagePath, {
          expiresIn: presignedUrlExpiry,
        });
        if (downloadUrl) {
          res.redirect(downloadUrl);
          return;
        }
      }

      const stream = await storage.downloadStream(file.storagePath);
      res.setHeader("Content-Type", file.mimeType);
      res.setHeader("Content-Disposition", `attachment; filename="${file.filename}"`);
      res.setHeader("Content-Length", file.size.toString());
      stream.pipe(res);
    } catch (error) {
      next(error);
    }
  });

  router.delete("/:id", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const fileId = req.params.id as string;

      const [file] = await dbQuery
        .select()
        .from(table)
        .where(eq(idColumn, fileId))
        .limit(1) as FileRecord[];

      if (!file) {
        throw new NotFoundError("File", fileId);
      }

      const canDelete = await checkScopeAccess<SchemaType>(
        auth?.delete,
        user,
        file,
        executeFilter
      );
      if (!canDelete) {
        throw new ForbiddenError("Not authorized to delete this file");
      }

      await storage.delete(file.storagePath);
      await dbQuery.delete(table).where(eq(idColumn, fileId));

      res.status(204).send();
    } catch (error) {
      next(error);
    }
  });

  router.delete("/batch", async (req: Request, res: Response, next: NextFunction) => {
    try {
      const user = getUser(req);
      const { ids } = req.body as { ids: string[] };

      if (!ids || !Array.isArray(ids) || ids.length === 0) {
        throw new ValidationError("ids array is required");
      }

      const files = await dbQuery
        .select()
        .from(table)
        .where(inArray(idColumn, ids))
        .limit(ids.length) as FileRecord[];

      for (const file of files) {
        const canDelete = await checkScopeAccess<SchemaType>(
          auth?.delete,
          user,
          file,
          executeFilter
        );
        if (!canDelete) {
          throw new ForbiddenError(`Not authorized to delete file ${file.id}`);
        }
      }

      const storagePaths = files.map((f) => f.storagePath);
      await storage.deleteMany(storagePaths);
      await dbQuery.delete(table).where(inArray(idColumn, ids));

      res.json({ data: { deleted: files.length } });
    } catch (error) {
      next(error);
    }
  });

  return router;
};
