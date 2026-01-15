import { Request, Response, NextFunction } from "express";
import {
  AuthAdapter,
  AuthenticatedRequest,
  AuthMiddlewareOptions,
} from "./types";
import { UnauthorizedError } from "@/resource/error";

export const createAuthMiddleware = (
  adapter: AuthAdapter,
  options: AuthMiddlewareOptions = {}
) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (options.skipPaths) {
        for (const path of options.skipPaths) {
          if (req.path.startsWith(path)) {
            return next();
          }
        }
      }

      const extractor = options.extractCredentials ?? adapter.extractCredentials.bind(adapter);
      const credentials = extractor(req);

      if (!credentials) {
        return next();
      }

      const result = await adapter.validateCredentials(credentials);

      if (!result.success) {
        throw new UnauthorizedError(
          result.error ?? options.unauthorizedMessage ?? "Invalid credentials"
        );
      }

      req.user = result.user;

      if (credentials.type === "session" && credentials.sessionId) {
        req.session = await adapter.getSession(credentials.sessionId) ?? undefined;
      } else if (credentials.type === "bearer" && credentials.token) {
        req.session = await adapter.getSession(credentials.token) ?? undefined;
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const requireAuth = (
  options: { message?: string } = {}
) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      return next(
        new UnauthorizedError(options.message ?? "Authentication required")
      );
    }
    next();
  };
};

export const optionalAuth = () => {
  return (
    _req: AuthenticatedRequest,
    _res: Response,
    next: NextFunction
  ): void => {
    next();
  };
};

export const requirePermission = (permission: string) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      return next(new UnauthorizedError("Authentication required"));
    }

    const permissions = req.user.metadata?.permissions;
    if (!Array.isArray(permissions) || !permissions.includes(permission)) {
      return next(
        new UnauthorizedError(`Permission '${permission}' required`)
      );
    }

    next();
  };
};

export const requireRole = (...roles: string[]) => {
  return (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): void => {
    if (!req.user) {
      return next(new UnauthorizedError("Authentication required"));
    }

    const userRole = req.user.metadata?.role;
    if (typeof userRole !== "string" || !roles.includes(userRole)) {
      return next(
        new UnauthorizedError(`One of roles [${roles.join(", ")}] required`)
      );
    }

    next();
  };
};

export const requireOwnership = (
  getResourceOwnerId: (req: Request) => string | Promise<string>,
  options: { allowAdmin?: boolean; adminCheck?: (req: AuthenticatedRequest) => boolean } = {}
) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (!req.user) {
        return next(new UnauthorizedError("Authentication required"));
      }

      if (options.allowAdmin && options.adminCheck?.(req)) {
        return next();
      }

      const ownerId = await getResourceOwnerId(req);
      if (ownerId !== req.user.id) {
        return next(new UnauthorizedError("You don't own this resource"));
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const refreshSession = (adapter: AuthAdapter) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (req.session && adapter.refreshSession) {
        const refreshed = await adapter.refreshSession(req.session.id);
        if (refreshed) {
          req.session = refreshed;
        }
      }
      next();
    } catch (error) {
      next(error);
    }
  };
};

export const createLogoutMiddleware = (adapter: AuthAdapter) => {
  return async (
    req: AuthenticatedRequest,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (req.session) {
        await adapter.invalidateSession(req.session.id);
      }

      res.clearCookie("session");

      res.json({ success: true });
    } catch (error) {
      next(error);
    }
  };
};

export const getUser = (req: Request): AuthenticatedRequest["user"] => {
  return (req as AuthenticatedRequest).user;
};

export const getSession = (req: Request): AuthenticatedRequest["session"] => {
  return (req as AuthenticatedRequest).session;
};

export const rateByUser = (req: AuthenticatedRequest): string => {
  return req.user?.id ?? req.ip ?? "anonymous";
};
