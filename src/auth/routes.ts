import { Router, Request, Response, NextFunction } from "express";
import { AuthAdapter } from "./types";
import { UnauthorizedError, ValidationError } from "@/resource/error";
import { UserContext } from "@/resource/types";

export interface AuthUser {
  id: string;
  email?: string | null;
  name?: string | null;
  image?: string | null;
}

export interface UseAuthOptions {
  adapter: AuthAdapter;
  cookieName?: string;
  cookieOptions?: {
    httpOnly?: boolean;
    secure?: boolean;
    sameSite?: "strict" | "lax" | "none";
    maxAge?: number;
    path?: string;
  };
  login?: {
    validateCredentials: (email: string, password: string) => Promise<AuthUser | null>;
  };
  signup?: {
    createUser: (data: { email: string; password: string; name?: string }) => Promise<AuthUser>;
    validateEmail?: (email: string) => boolean | Promise<boolean>;
    validatePassword?: (password: string) => boolean | Promise<boolean>;
  };
  serializeUser?: (user: UserContext) => Record<string, unknown>;
  onLogin?: (user: UserContext, req: Request) => void | Promise<void>;
  onLogout?: (user: UserContext | null, req: Request) => void | Promise<void>;
  onSignup?: (user: AuthUser, req: Request) => void | Promise<void>;
}

export interface AuthRouterResult {
  router: Router;
  middleware: (req: Request, res: Response, next: NextFunction) => Promise<void>;
}

const defaultCookieOptions = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax" as const,
  maxAge: 7 * 24 * 60 * 60 * 1000,
  path: "/",
};

const defaultSerializeUser = (user: UserContext): Record<string, unknown> => ({
  id: user.id,
  email: user.email,
  name: user.name,
  image: user.image,
});

export const useAuth = (options: UseAuthOptions): AuthRouterResult => {
  const {
    adapter,
    cookieName = "session",
    cookieOptions = {},
    login,
    signup,
    serializeUser = defaultSerializeUser,
    onLogin,
    onLogout,
    onSignup,
  } = options;

  const finalCookieOptions = { ...defaultCookieOptions, ...cookieOptions };
  const router = Router();

  const middleware = async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    try {
      const credentials = adapter.extractCredentials(req);
      if (!credentials) {
        req.user = null;
        return next();
      }

      const result = await adapter.validateCredentials(credentials);
      if (!result.success || !result.user) {
        req.user = null;
        return next();
      }

      req.user = result.user;
      next();
    } catch {
      req.user = null;
      next();
    }
  };

  router.get("/me", async (req: Request, res: Response) => {
    try {
      const credentials = adapter.extractCredentials(req);
      if (!credentials) {
        return res.json({ user: null });
      }

      const result = await adapter.validateCredentials(credentials);
      if (!result.success || !result.user) {
        return res.json({ user: null });
      }

      const serialized = serializeUser(result.user);
      res.json({ user: serialized, expiresAt: result.expiresAt });
    } catch {
      res.json({ user: null });
    }
  });

  if (login?.validateCredentials) {
    router.post("/login", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, password } = req.body;

        if (!email || !password) {
          throw new ValidationError("Email and password are required");
        }

        const user = await login.validateCredentials(email, password);
        if (!user) {
          throw new UnauthorizedError("Invalid email or password");
        }

        if (!adapter.createSession) {
          throw new Error("Adapter does not support session creation");
        }

        const session = await adapter.createSession(user.id);
        const credentials = { type: "session" as const, sessionId: session.id };
        const authResult = await adapter.validateCredentials(credentials);

        if (!authResult.success || !authResult.user) {
          throw new UnauthorizedError("Failed to create session");
        }

        res.cookie(cookieName, session.id, {
          ...finalCookieOptions,
          expires: session.expiresAt,
        });

        await onLogin?.(authResult.user, req);

        const serialized = serializeUser(authResult.user);
        res.json({ user: serialized, sessionId: session.id });
      } catch (error) {
        next(error);
      }
    });
  }

  if (signup?.createUser) {
    router.post("/signup", async (req: Request, res: Response, next: NextFunction) => {
      try {
        const { email, password, name } = req.body;

        if (!email || !password) {
          throw new ValidationError("Email and password are required");
        }

        if (signup.validateEmail) {
          const isValidEmail = await signup.validateEmail(email);
          if (!isValidEmail) {
            throw new ValidationError("Invalid email format");
          }
        }

        if (signup.validatePassword) {
          const isValidPassword = await signup.validatePassword(password);
          if (!isValidPassword) {
            throw new ValidationError("Password does not meet requirements");
          }
        }

        const user = await signup.createUser({ email, password, name });

        if (!adapter.createSession) {
          throw new Error("Adapter does not support session creation");
        }

        const session = await adapter.createSession(user.id);

        res.cookie(cookieName, session.id, {
          ...finalCookieOptions,
          expires: session.expiresAt,
        });

        await onSignup?.(user, req);

        res.json({ user: { id: user.id, email: user.email, name: user.name } });
      } catch (error) {
        next(error);
      }
    });
  }

  router.post("/logout", async (req: Request, res: Response) => {
    try {
      const credentials = adapter.extractCredentials(req);
      let user: UserContext | null = null;

      if (credentials) {
        const result = await adapter.validateCredentials(credentials);
        if (result.success && result.user) {
          user = result.user;
        }

        const sessionToken = credentials.sessionId ?? credentials.token;
        if (sessionToken) {
          await adapter.invalidateSession(sessionToken);
        }
      }

      res.clearCookie(cookieName);
      res.clearCookie("connect.sid");
      res.clearCookie("session");

      await onLogout?.(user, req);

      res.json({ success: true });
    } catch {
      res.clearCookie(cookieName);
      res.json({ success: true });
    }
  });

  return { router, middleware };
};

export const createAuthRoutes = useAuth;
