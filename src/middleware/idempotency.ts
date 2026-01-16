import { Request, Response, NextFunction } from "express";
import { createHash } from "crypto";
import { KVAdapter } from "@/kv";
import { IdempotencyMismatchError } from "@/resource/error";
import { AuthenticatedRequest } from "@/auth/types";

export interface IdempotencyConfig {
  storage: KVAdapter;
  ttlMs?: number;
  methods?: ("POST" | "PATCH" | "PUT" | "DELETE")[];
  paths?: string[];
  excludePaths?: string[];
  headerName?: string;
}

interface CachedResponse {
  status: number;
  body: unknown;
  requestHash: string;
  createdAt: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_METHODS: IdempotencyConfig["methods"] = ["POST", "PATCH", "PUT"];
const DEFAULT_HEADER = "idempotency-key";

const hashRequest = (method: string, path: string, body: unknown): string => {
  const data = JSON.stringify({ method, path, body });
  return createHash("sha256").update(data).digest("hex");
};

export const idempotencyMiddleware = (config: IdempotencyConfig) => {
  const {
    storage,
    ttlMs = DEFAULT_TTL_MS,
    methods = DEFAULT_METHODS,
    paths,
    excludePaths,
    headerName = DEFAULT_HEADER,
  } = config;

  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const key = req.headers[headerName] as string | undefined;

    if (!key) {
      return next();
    }

    const method = req.method.toUpperCase() as "POST" | "PATCH" | "PUT" | "DELETE" | "GET";
    if (!methods.includes(method as typeof methods[number])) {
      return next();
    }

    if (paths && !paths.some((p) => req.path.startsWith(p))) {
      return next();
    }

    if (excludePaths && excludePaths.some((p) => req.path.startsWith(p))) {
      return next();
    }

    const userId = (req as AuthenticatedRequest).user?.id ?? "anonymous";
    const requestHash = hashRequest(req.method, req.path, req.body);
    const cacheKey = `idempotency:${userId}:${key}`;

    try {
      const cached = await storage.get(cacheKey);

      if (cached) {
        const parsedCache: CachedResponse = JSON.parse(cached);

        if (parsedCache.requestHash !== requestHash) {
          const error = new IdempotencyMismatchError(
            "Idempotency key was already used with different request parameters"
          );
          return next(error);
        }

        res.status(parsedCache.status).json(parsedCache.body);
        return;
      }

      const originalJson = res.json.bind(res);
      let responseCaptured = false;

      res.json = function (body: unknown): Response {
        if (!responseCaptured && res.statusCode < 500) {
          responseCaptured = true;
          const cacheData: CachedResponse = {
            status: res.statusCode,
            body,
            requestHash,
            createdAt: Date.now(),
          };

          storage
            .set(cacheKey, JSON.stringify(cacheData), { px: ttlMs })
            .catch((err) => {
              console.error("Failed to cache idempotency response:", err);
            });
        }

        return originalJson(body);
      };

      next();
    } catch (error) {
      console.error("Idempotency middleware error:", error);
      next();
    }
  };
};

export const createIdempotencyMiddleware = idempotencyMiddleware;

export interface IdempotencyKeyGenerator {
  generate(): string;
  fromMutation(type: string, resource: string, objectId?: string): string;
}

export const createIdempotencyKeyGenerator = (): IdempotencyKeyGenerator => {
  return {
    generate(): string {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 15);
      return `${timestamp}-${random}`;
    },

    fromMutation(type: string, resource: string, objectId?: string): string {
      const timestamp = Date.now().toString(36);
      const random = Math.random().toString(36).substring(2, 8);
      const parts = [type, resource];
      if (objectId) {
        parts.push(objectId);
      }
      parts.push(timestamp, random);
      return parts.join("-");
    },
  };
};

export const validateIdempotencyKey = (key: string): boolean => {
  if (!key || typeof key !== "string") {
    return false;
  }

  if (key.length < 8 || key.length > 256) {
    return false;
  }

  return /^[a-zA-Z0-9_-]+$/.test(key);
};

export const idempotencyKeyValidationMiddleware = (
  headerName: string = DEFAULT_HEADER
) => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const key = req.headers[headerName] as string | undefined;

    if (key && !validateIdempotencyKey(key)) {
      res.status(400).json({
        type: "/__concave/problems/validation-error",
        title: "Invalid idempotency key",
        status: 400,
        detail: "Idempotency key must be 8-256 characters and contain only alphanumeric characters, underscores, and hyphens",
      });
      return;
    }

    next();
  };
};
