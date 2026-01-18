import { Router, Request, Response } from "express";
import { KVAdapter } from "@/kv/types";
import {
  logAdminAction,
  getAdminUser,
  requireAdminUser,
  AdminSecurityConfig,
  detectEnvironment,
} from "./admin-auth";

export interface KVInspectorConfig {
  enabled?: boolean;
  kv?: KVAdapter;
  readOnly?: boolean;
  allowedPatterns?: string[];
}

const matchPattern = (pattern: string, key: string): boolean => {
  const regex = new RegExp(
    "^" +
      pattern
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, ".*")
        .replace(/\?/g, ".") +
      "$"
  );
  return regex.test(key);
};

export const createKVInspectorRoutes = (
  config: KVInspectorConfig = {},
  securityConfig: AdminSecurityConfig = {}
): Router => {
  const router = Router();
  const mode = securityConfig.mode ?? detectEnvironment();

  const defaultEnabled = mode === "development";
  const enabled = config.enabled ?? defaultEnabled;

  const defaultReadOnly = mode !== "development";
  const isReadOnly = config.readOnly ?? defaultReadOnly;

  if (!enabled || !config.kv) {
    router.use((_req: Request, res: Response) => {
      res.json({ enabled: false });
    });
    return router;
  }

  const kv = config.kv;

  const isPatternAllowed = (pattern: string): boolean => {
    if (!config.allowedPatterns || config.allowedPatterns.length === 0) {
      return true;
    }
    return config.allowedPatterns.some((allowed) =>
      matchPattern(allowed, pattern)
    );
  };

  const isKeyAllowed = (key: string): boolean => {
    if (!config.allowedPatterns || config.allowedPatterns.length === 0) {
      return true;
    }
    return config.allowedPatterns.some((allowed) => matchPattern(allowed, key));
  };

  router.get("/keys", async (req: Request, res: Response) => {
    const adminUser = getAdminUser(req);
    const pattern = (req.query.pattern as string) ?? "*";
    const limit = parseInt((req.query.limit as string) ?? "100", 10);

    if (!isPatternAllowed(pattern)) {
      res.status(403).json({
        type: "/__concave/problems/forbidden",
        title: "Pattern not allowed",
        status: 403,
        detail: "This key pattern is not in the allowed list",
      });
      return;
    }

    try {
      let keys = await kv.keys(pattern);

      if (config.allowedPatterns && config.allowedPatterns.length > 0) {
        keys = keys.filter(isKeyAllowed);
      }

      keys = keys.slice(0, limit);

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_list_keys",
          reason: `Admin list keys: pattern=${pattern}`,
        });
      }

      res.json({
        enabled: true,
        readOnly: isReadOnly,
        keys,
        mode,
      });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to list keys",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/key/:key", async (req: Request, res: Response) => {
    const adminUser = getAdminUser(req);
    const key = decodeURIComponent(req.params.key as string);

    if (!isKeyAllowed(key)) {
      res.status(403).json({
        type: "/__concave/problems/forbidden",
        title: "Key not allowed",
        status: 403,
        detail: "This key is not in the allowed patterns",
      });
      return;
    }

    try {
      const value = await kv.get(key);
      const ttl = await kv.ttl(key);

      if (value === null) {
        const hashValue = await kv.hgetall(key);
        if (Object.keys(hashValue).length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV hash value",
            });
          }

          res.json({
            key,
            type: "hash",
            value: hashValue,
            ttl,
          });
          return;
        }

        const listLength = await kv.llen(key);
        if (listLength > 0) {
          const listValue = await kv.lrange(key, 0, 99);
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV list value",
            });
          }

          res.json({
            key,
            type: "list",
            value: listValue,
            length: listLength,
            ttl,
          });
          return;
        }

        const setMembers = await kv.smembers(key);
        if (setMembers.length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV set value",
            });
          }

          res.json({
            key,
            type: "set",
            value: setMembers,
            ttl,
          });
          return;
        }

        const zsetMembers = await kv.zrange(key, 0, 99);
        if (zsetMembers.length > 0) {
          if (adminUser) {
            logAdminAction({
              userId: adminUser.id,
              userEmail: adminUser.email,
              operation: "kv_inspector_get",
              resourceId: key,
              reason: "Admin get KV sorted set value",
            });
          }

          res.json({
            key,
            type: "zset",
            value: zsetMembers,
            ttl,
          });
          return;
        }

        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Key not found",
          status: 404,
        });
        return;
      }

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_get",
          resourceId: key,
          reason: "Admin get KV string value",
        });
      }

      let parsedValue: unknown = value;
      try {
        parsedValue = JSON.parse(value);
      } catch {
        parsedValue = value;
      }

      res.json({
        key,
        type: "string",
        value: parsedValue,
        rawValue: value,
        ttl,
      });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to get key",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/key/:key/ttl", async (req: Request, res: Response) => {
    const key = decodeURIComponent(req.params.key as string);

    if (!isKeyAllowed(key)) {
      res.status(403).json({
        type: "/__concave/problems/forbidden",
        title: "Key not allowed",
        status: 403,
      });
      return;
    }

    try {
      const ttl = await kv.ttl(key);
      res.json({ key, ttl });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to get TTL",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  if (!isReadOnly) {
    router.put("/key/:key", async (req: Request, res: Response) => {
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      const key = decodeURIComponent(req.params.key as string);
      const { value, ttl } = req.body;

      if (!isKeyAllowed(key)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Key not allowed",
          status: 403,
        });
        return;
      }

      try {
        const stringValue =
          typeof value === "string" ? value : JSON.stringify(value);

        if (ttl && ttl > 0) {
          await kv.set(key, stringValue, { ex: ttl });
        } else {
          await kv.set(key, stringValue);
        }

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_set",
          resourceId: key,
          reason: "Admin set KV value",
          afterValue: { value, ttl },
        });

        res.json({ success: true, key });
      } catch (error) {
        res.status(500).json({
          type: "/__concave/problems/internal-error",
          title: "Failed to set key",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    router.post("/key/:key/expire", async (req: Request, res: Response) => {
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      const key = decodeURIComponent(req.params.key as string);
      const { ttl } = req.body;

      if (!isKeyAllowed(key)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Key not allowed",
          status: 403,
        });
        return;
      }

      try {
        const success = await kv.expire(key, ttl);

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_expire",
          resourceId: key,
          reason: `Admin set TTL: ${ttl}s`,
        });

        res.json({ success, key, ttl });
      } catch (error) {
        res.status(500).json({
          type: "/__concave/problems/internal-error",
          title: "Failed to set expiry",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    router.delete("/key/:key", async (req: Request, res: Response) => {
      const adminUser = requireAdminUser(req, res);
      if (!adminUser) return;

      const key = decodeURIComponent(req.params.key as string);

      if (!isKeyAllowed(key)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Key not allowed",
          status: 403,
        });
        return;
      }

      try {
        const deleted = await kv.del(key);

        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "kv_inspector_delete",
          resourceId: key,
          reason: "Admin delete KV key",
        });

        res.json({ success: deleted > 0, deleted });
      } catch (error) {
        res.status(500).json({
          type: "/__concave/problems/internal-error",
          title: "Failed to delete key",
          status: 500,
          detail: error instanceof Error ? error.message : "Unknown error",
        });
      }
    });
  }

  return router;
};
