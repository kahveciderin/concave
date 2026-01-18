import { Request, Response, NextFunction } from "express";
import { UserContext } from "@/resource/types";
import { AuthenticatedRequest } from "@/auth/types";

export interface AdminUser {
  id: string;
  email: string;
  name?: string;
  roles?: string[];
  permissions?: string[];
}

export type EnvironmentMode = "development" | "staging" | "production";

export interface AdminSecurityConfig {
  mode?: EnvironmentMode;

  auth?: {
    disabled?: boolean;
    useSessionAuth?: boolean;
    apiKey?: string;
    authenticate?: (req: Request) => Promise<AdminUser | null>;
  };

  authorization?: {
    requiredRole?: string;
    requiredPermission?: string;
    authorize?: (user: AdminUser) => Promise<boolean>;
  };

  allowedIPs?: string[];

  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

export interface AdminAuditEntry {
  timestamp: number;
  userId: string;
  userEmail: string;
  operation: string;
  resource?: string;
  resourceId?: string;
  reason?: string;
  details?: Record<string, unknown>;
  beforeValue?: Record<string, unknown>;
  afterValue?: Record<string, unknown>;
}

const adminAuditLog: AdminAuditEntry[] = [];
const MAX_AUDIT_ENTRIES = 1000;

export const logAdminAction = (entry: Omit<AdminAuditEntry, "timestamp">): void => {
  adminAuditLog.unshift({ ...entry, timestamp: Date.now() });
  if (adminAuditLog.length > MAX_AUDIT_ENTRIES) {
    adminAuditLog.pop();
  }
};

export const getAdminAuditLog = (
  limit: number = 100,
  offset: number = 0
): AdminAuditEntry[] => {
  return adminAuditLog.slice(offset, offset + limit);
};

export const clearAdminAuditLog = (): void => {
  adminAuditLog.length = 0;
};

export const detectEnvironment = (): EnvironmentMode => {
  const env = process.env.NODE_ENV?.toLowerCase();
  if (env === "production") return "production";
  if (env === "staging") return "staging";
  return "development";
};

const rateLimitStore = new Map<string, { count: number; resetAt: number }>();

export const createAdminAuthMiddleware = (
  config: AdminSecurityConfig = {}
) => {
  const mode = config.mode ?? detectEnvironment();

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    const clientIP = req.ip ?? req.socket.remoteAddress ?? "unknown";

    if (config.allowedIPs && config.allowedIPs.length > 0 && mode === "production") {
      if (!config.allowedIPs.includes(clientIP)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "IP not allowed",
          status: 403,
          detail: "Your IP address is not in the allowed list",
        });
        return;
      }
    }

    if (config.rateLimit) {
      const key = clientIP;
      const now = Date.now();
      const entry = rateLimitStore.get(key);

      if (entry && entry.resetAt > now) {
        if (entry.count >= config.rateLimit.maxRequests) {
          res.status(429).json({
            type: "/__concave/problems/rate-limit-exceeded",
            title: "Rate limit exceeded",
            status: 429,
            detail: "Too many admin API requests",
          });
          return;
        }
        entry.count++;
      } else {
        rateLimitStore.set(key, {
          count: 1,
          resetAt: now + config.rateLimit.windowMs,
        });
      }
    }

    if (config.auth?.disabled) {
      if (mode !== "development") {
        console.warn(
          "[Concave Admin] Auth is disabled in non-development mode. This is a security risk."
        );
      }
      (req as AdminAuthenticatedRequest).adminUser = {
        id: "admin",
        email: "admin@localhost",
      };
      next();
      return;
    }

    let adminUser: AdminUser | null = null;

    if (config.auth?.apiKey) {
      const authHeader = req.headers.authorization;
      if (authHeader?.startsWith("Bearer ")) {
        const token = authHeader.slice(7);
        if (token === config.auth.apiKey) {
          adminUser = { id: "api-key", email: "api-key@admin" };
        }
      }

      const apiKeyHeader = req.headers["x-admin-api-key"];
      if (apiKeyHeader === config.auth.apiKey) {
        adminUser = { id: "api-key", email: "api-key@admin" };
      }
    }

    if (!adminUser && config.auth?.useSessionAuth) {
      const authReq = req as AuthenticatedRequest;
      if (authReq.user) {
        adminUser = {
          id: authReq.user.id,
          email: authReq.user.email ?? "unknown",
          name: authReq.user.name ?? undefined,
          roles: (authReq.user.metadata?.roles as string[]) ?? [],
          permissions: (authReq.user.metadata?.permissions as string[]) ?? [],
        };
      }
    }

    if (!adminUser && config.auth?.authenticate) {
      try {
        adminUser = await config.auth.authenticate(req);
      } catch {
        adminUser = null;
      }
    }

    if (!adminUser) {
      if (mode === "development" && !config.auth?.apiKey && !config.auth?.authenticate) {
        (req as AdminAuthenticatedRequest).adminUser = {
          id: "dev-admin",
          email: "dev@localhost",
        };
        next();
        return;
      }

      res.status(401).json({
        type: "/__concave/problems/unauthorized",
        title: "Unauthorized",
        status: 401,
        detail: "Admin authentication required",
      });
      return;
    }

    if (config.authorization?.requiredRole && adminUser.roles) {
      if (!adminUser.roles.includes(config.authorization.requiredRole)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Forbidden",
          status: 403,
          detail: `Required role: ${config.authorization.requiredRole}`,
        });
        return;
      }
    }

    if (config.authorization?.requiredPermission && adminUser.permissions) {
      if (!adminUser.permissions.includes(config.authorization.requiredPermission)) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Forbidden",
          status: 403,
          detail: `Required permission: ${config.authorization.requiredPermission}`,
        });
        return;
      }
    }

    if (config.authorization?.authorize) {
      const authorized = await config.authorization.authorize(adminUser);
      if (!authorized) {
        res.status(403).json({
          type: "/__concave/problems/forbidden",
          title: "Forbidden",
          status: 403,
          detail: "Authorization check failed",
        });
        return;
      }
    }

    (req as AdminAuthenticatedRequest).adminUser = adminUser;
    next();
  };
};

export interface AdminAuthenticatedRequest extends Request {
  adminUser?: AdminUser;
}

export const getAdminUser = (req: Request): AdminUser | null => {
  return (req as AdminAuthenticatedRequest).adminUser ?? null;
};

export const requireAdminUser = (
  req: Request,
  res: Response
): AdminUser | null => {
  const user = getAdminUser(req);
  if (!user) {
    res.status(401).json({
      type: "/__concave/problems/unauthorized",
      title: "Unauthorized",
      status: 401,
      detail: "Admin user not found in request",
    });
    return null;
  }
  return user;
};
