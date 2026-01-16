import { Router, Request, Response } from "express";
import { getRegisteredResources } from "./registry";

export interface AdminUIConfig {
  basePath?: string;
  title?: string;
  metricsCollector?: {
    getRecent: (count: number) => any[];
    getSlow: (thresholdMs: number) => any[];
  };
  changelog?: {
    getCurrentSequence: () => Promise<number>;
    getEntries: (fromSeq: number, limit: number) => Promise<any[]>;
  };
  getActiveSubscriptions?: () => any[];
  userManager?: {
    listUsers: (limit?: number, offset?: number) => Promise<{ users: any[]; total: number }>;
    getUser: (id: string) => Promise<any | null>;
    createUser: (data: { email: string; name?: string; metadata?: any }) => Promise<any>;
    updateUser: (id: string, data: { email?: string; name?: string; metadata?: any }) => Promise<any>;
    deleteUser: (id: string) => Promise<void>;
  };
  sessionManager?: {
    listSessions: (limit?: number) => Promise<any[]>;
    getSessionsByUser: (userId: string) => Promise<any[]>;
    createSession: (userId: string, expiresIn?: number) => Promise<{ token: string; expiresAt: Date }>;
    revokeSession: (sessionId: string) => Promise<void>;
    revokeAllUserSessions: (userId: string) => Promise<number>;
  };
}

interface RequestLog {
  id: string;
  method: string;
  path: string;
  status: number;
  duration: number;
  timestamp: number;
  requestBody?: any;
  responseBody?: any;
  headers?: Record<string, string>;
  error?: string;
}

interface ErrorLog {
  id: string;
  timestamp: number;
  path: string;
  method: string;
  error: string;
  stack?: string;
  statusCode: number;
}

const requestLogs: RequestLog[] = [];
const errorLogs: ErrorLog[] = [];
const MAX_LOGS = 500;

export const logRequest = (log: RequestLog) => {
  requestLogs.unshift(log);
  if (requestLogs.length > MAX_LOGS) requestLogs.pop();
};

export const logError = (log: ErrorLog) => {
  errorLogs.unshift(log);
  if (errorLogs.length > MAX_LOGS) errorLogs.pop();
};

export const createAdminUI = (config: AdminUIConfig = {}): Router => {
  const router = Router();
  const basePath = config.basePath || "/__concave";
  const title = config.title || "Concave Admin";

  // API endpoints
  router.get("/api/resources", (_req: Request, res: Response) => {
    const resources = getRegisteredResources();
    res.json({ resources });
  });

  router.get("/api/metrics", (_req: Request, res: Response) => {
    if (!config.metricsCollector) {
      res.json({ metrics: [], enabled: false });
      return;
    }
    const recent = config.metricsCollector.getRecent(200);
    const slow = config.metricsCollector.getSlow(500);
    res.json({ metrics: recent, slowQueries: slow, enabled: true });
  });

  router.get("/api/requests", (_req: Request, res: Response) => {
    res.json({ requests: requestLogs.slice(0, 200) });
  });

  router.get("/api/errors", (_req: Request, res: Response) => {
    res.json({ errors: errorLogs.slice(0, 100) });
  });

  router.get("/api/changelog", async (_req: Request, res: Response) => {
    if (!config.changelog) {
      res.json({ entries: [], currentSeq: 0, enabled: false });
      return;
    }
    try {
      const currentSeq = await config.changelog.getCurrentSequence();
      const entries = await config.changelog.getEntries(Math.max(0, currentSeq - 50), 50);
      res.json({ entries, currentSeq, enabled: true });
    } catch {
      res.json({ entries: [], currentSeq: 0, enabled: false });
    }
  });

  router.get("/api/subscriptions", (_req: Request, res: Response) => {
    if (!config.getActiveSubscriptions) {
      res.json({ subscriptions: [], enabled: false });
      return;
    }
    res.json({ subscriptions: config.getActiveSubscriptions(), enabled: true });
  });

  router.post("/api/query", async (req: Request, res: Response) => {
    const { resource, filter, limit = 10 } = req.body;
    try {
      const url = `${resource}?filter=${encodeURIComponent(filter || "")}&limit=${limit}`;
      res.json({ url, note: "Execute this query via the main API" });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // User management API endpoints
  router.get("/api/users", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.json({ users: [], total: 0, enabled: false });
      return;
    }
    try {
      const limit = parseInt(String(req.query.limit)) || 50;
      const offset = parseInt(String(req.query.offset)) || 0;
      const result = await config.userManager.listUsers(limit, offset);
      res.json({ ...result, enabled: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/api/users/:id", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.status(501).json({ error: "User management not configured" });
      return;
    }
    try {
      const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const user = await config.userManager.getUser(userId);
      if (!user) {
        res.status(404).json({ error: "User not found" });
        return;
      }
      res.json({ user });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/api/users", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.status(501).json({ error: "User management not configured" });
      return;
    }
    try {
      const user = await config.userManager.createUser(req.body);
      res.status(201).json({ user });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch("/api/users/:id", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.status(501).json({ error: "User management not configured" });
      return;
    }
    try {
      const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const user = await config.userManager.updateUser(userId, req.body);
      res.json({ user });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/users/:id", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.status(501).json({ error: "User management not configured" });
      return;
    }
    try {
      const userId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await config.userManager.deleteUser(userId);
      res.status(204).send();
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Session management API endpoints
  router.get("/api/sessions", async (req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.json({ sessions: [], enabled: false });
      return;
    }
    try {
      const limit = parseInt(String(req.query.limit)) || 50;
      const sessions = await config.sessionManager.listSessions(limit);
      res.json({ sessions, enabled: true });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.get("/api/sessions/user/:userId", async (req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.status(501).json({ error: "Session management not configured" });
      return;
    }
    try {
      const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
      const sessions = await config.sessionManager.getSessionsByUser(userId);
      res.json({ sessions });
    } catch (e: any) {
      res.status(500).json({ error: e.message });
    }
  });

  router.post("/api/sessions", async (req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.status(501).json({ error: "Session management not configured" });
      return;
    }
    try {
      const { userId, expiresIn } = req.body;
      if (!userId) {
        res.status(400).json({ error: "userId is required" });
        return;
      }
      const session = await config.sessionManager.createSession(userId, expiresIn);
      res.status(201).json({ session });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/sessions/:id", async (req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.status(501).json({ error: "Session management not configured" });
      return;
    }
    try {
      const sessionId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      await config.sessionManager.revokeSession(sessionId);
      res.status(204).send();
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  router.delete("/api/sessions/user/:userId", async (req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.status(501).json({ error: "Session management not configured" });
      return;
    }
    try {
      const userId = Array.isArray(req.params.userId) ? req.params.userId[0] : req.params.userId;
      const count = await config.sessionManager.revokeAllUserSessions(userId);
      res.json({ revokedCount: count });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // Problem details documentation
  router.get("/problems/:type", (req: Request, res: Response) => {
    const problemDocs: Record<string, { title: string; description: string; solutions: string[] }> = {
      "not-found": {
        title: "Resource Not Found",
        description: "The requested resource does not exist or you do not have permission to access it.",
        solutions: [
          "Verify the resource ID is correct",
          "Check that the resource exists in the database",
          "Ensure you have read permissions for this resource",
          "If using auth scopes, verify your scope includes this resource"
        ]
      },
      "validation-error": {
        title: "Validation Error",
        description: "The request body failed validation against the schema.",
        solutions: [
          "Check the required fields are present",
          "Verify field types match the schema",
          "Review the 'errors' array in the response for specific issues",
          "Use the Schema Viewer to see field requirements"
        ]
      },
      "unauthorized": {
        title: "Unauthorized",
        description: "Authentication is required to access this resource.",
        solutions: [
          "Include a valid authentication token",
          "Check if your session has expired",
          "Verify the auth middleware is configured correctly"
        ]
      },
      "forbidden": {
        title: "Forbidden",
        description: "You do not have permission to perform this operation.",
        solutions: [
          "Check your user role and permissions",
          "Verify the auth scope allows this operation",
          "Contact an administrator for access"
        ]
      },
      "rate-limit-exceeded": {
        title: "Rate Limit Exceeded",
        description: "Too many requests in the current time window.",
        solutions: [
          "Wait before making more requests",
          "Check the Retry-After header for wait time",
          "Consider implementing request batching",
          "Review rate limit configuration"
        ]
      },
      "batch-limit-exceeded": {
        title: "Batch Limit Exceeded",
        description: "The batch operation exceeds the configured limit.",
        solutions: [
          "Reduce the number of items in the batch",
          "Check the batch limits in resource configuration",
          "Split the operation into multiple smaller batches"
        ]
      },
      "filter-parse-error": {
        title: "Filter Parse Error",
        description: "The filter expression could not be parsed.",
        solutions: [
          "Check the filter syntax",
          "Use the Filter Tester to validate expressions",
          "Ensure strings are properly quoted",
          "Review supported operators"
        ]
      },
      "internal-error": {
        title: "Internal Server Error",
        description: "An unexpected error occurred on the server.",
        solutions: [
          "Check the server logs for details",
          "Review the Error Log in the admin panel",
          "If the issue persists, report it with the request ID"
        ]
      },
      "conflict": {
        title: "Conflict",
        description: "The request conflicts with the current state of the resource.",
        solutions: [
          "Check if the resource was modified by another request",
          "Refetch the resource and retry",
          "Use ETag headers for optimistic concurrency control"
        ]
      },
      "precondition-failed": {
        title: "Precondition Failed",
        description: "The resource was modified since you last fetched it (ETag mismatch).",
        solutions: [
          "Refetch the resource to get the latest ETag",
          "Update your If-Match header with the new ETag",
          "Retry the operation with the updated data"
        ]
      },
      "cursor-invalid": {
        title: "Invalid Cursor",
        description: "The pagination cursor is malformed or incompatible.",
        solutions: [
          "Request a fresh first page without a cursor",
          "Ensure the cursor was not modified",
          "Check if the orderBy parameters match the original request",
          "Verify the API version matches the cursor version"
        ]
      },
      "cursor-expired": {
        title: "Cursor Expired",
        description: "The pagination cursor has expired and can no longer be used.",
        solutions: [
          "Request a fresh first page without a cursor",
          "Cursors expire after a period of inactivity",
          "Consider caching results if pagination takes a long time"
        ]
      },
      "idempotency-mismatch": {
        title: "Idempotency Mismatch",
        description: "The idempotency key was already used with different request parameters.",
        solutions: [
          "Use a new unique idempotency key for different requests",
          "If retrying the same request, ensure body and path match exactly",
          "Idempotency keys are tied to specific request signatures"
        ]
      },
      "unsupported-version": {
        title: "Unsupported Client Version",
        description: "The client version is below the minimum supported version.",
        solutions: [
          "Upgrade your client library to a newer version",
          "Check the minVersion field in the response",
          "Review the changelog for breaking changes"
        ]
      },
      "unknown-error": {
        title: "Unknown Error",
        description: "An unrecognized error occurred.",
        solutions: [
          "Check the server logs for details",
          "Review the request ID in the response",
          "Contact support with the error details"
        ]
      }
    };

    const problemType = Array.isArray(req.params.type) ? req.params.type[0] : req.params.type;
    const doc = problemDocs[problemType] || {
      title: "Unknown Error",
      description: "An unrecognized error type.",
      solutions: ["Check the API documentation", "Review server logs"]
    };

    res.json(doc);
  });

  // Serve UI
  router.get("/ui", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(generateHTML(title, basePath));
  });

  router.get("/ui/:path", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(generateHTML(title, basePath));
  });

  return router;
};

const generateHTML = (title: string, basePath: string): string => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${title}</title>
  <script src="https://unpkg.com/react@18/umd/react.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/react-dom@18/umd/react-dom.production.min.js" crossorigin></script>
  <script src="https://unpkg.com/@babel/standalone/babel.min.js"></script>
  <style>
    :root {
      --bg-0: #ffffff;
      --bg-1: #fafafa;
      --bg-2: #f0f0f0;
      --bg-3: #e5e5e5;
      --text-0: #0a0a0a;
      --text-1: #404040;
      --text-2: #737373;
      --accent: #0066ff;
      --accent-hover: #0052cc;
      --accent-light: #e6f0ff;
      --border: #e5e5e5;
      --success: #00875a;
      --success-bg: #e3fcef;
      --warning: #b86e00;
      --warning-bg: #fff8e6;
      --error: #de350b;
      --error-bg: #ffebe6;
      --info: #0052cc;
      --info-bg: #deebff;
      --code-bg: #f4f5f7;
      --shadow: 0 1px 3px rgba(0,0,0,0.08);
      --shadow-lg: 0 4px 12px rgba(0,0,0,0.1);
      --radius: 4px;
      --font-mono: 'SF Mono', 'Monaco', 'Inconsolata', 'Fira Code', monospace;
    }

    [data-theme="dark"] {
      --bg-0: #0a0a0a;
      --bg-1: #141414;
      --bg-2: #1f1f1f;
      --bg-3: #2a2a2a;
      --text-0: #fafafa;
      --text-1: #d4d4d4;
      --text-2: #a3a3a3;
      --accent: #3b9eff;
      --accent-hover: #66b3ff;
      --accent-light: #1a3a5c;
      --border: #2a2a2a;
      --success: #36b37e;
      --success-bg: #1a2e23;
      --warning: #ffab00;
      --warning-bg: #2e2a1a;
      --error: #ff5630;
      --error-bg: #2e1a1a;
      --info: #4c9aff;
      --info-bg: #1a2a3e;
      --code-bg: #1a1a1a;
      --shadow: 0 1px 3px rgba(0,0,0,0.3);
      --shadow-lg: 0 4px 12px rgba(0,0,0,0.4);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif;
      font-size: 14px;
      line-height: 1.5;
      background: var(--bg-0);
      color: var(--text-0);
      -webkit-font-smoothing: antialiased;
    }

    .app { display: flex; flex-direction: column; min-height: 100vh; }

    /* Header */
    .header {
      height: 48px;
      background: var(--bg-1);
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 0 16px;
      position: sticky;
      top: 0;
      z-index: 100;
    }

    .header-left { display: flex; align-items: center; gap: 16px; }
    .header-right { display: flex; align-items: center; gap: 8px; }

    .logo {
      font-weight: 600;
      font-size: 15px;
      color: var(--text-0);
      display: flex;
      align-items: center;
      gap: 8px;
    }

    .logo-icon {
      width: 24px;
      height: 24px;
      background: var(--accent);
      border-radius: 4px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: white;
      font-weight: 700;
      font-size: 12px;
    }

    .status-indicator {
      display: flex;
      align-items: center;
      gap: 6px;
      font-size: 12px;
      color: var(--text-2);
    }

    .status-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: var(--success);
      animation: pulse-green 2s ease-in-out infinite;
    }

    .status-dot.disconnected {
      background: var(--error);
      animation: pulse-red 1s ease-in-out infinite;
    }

    .status-dot.stale {
      background: var(--warning);
      animation: pulse-yellow 1.5s ease-in-out infinite;
    }

    @keyframes pulse-green {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(0, 135, 90, 0.4); }
      50% { opacity: 0.8; box-shadow: 0 0 0 4px rgba(0, 135, 90, 0); }
    }

    @keyframes pulse-red {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(222, 53, 11, 0.4); }
      50% { opacity: 0.6; box-shadow: 0 0 0 4px rgba(222, 53, 11, 0); }
    }

    @keyframes pulse-yellow {
      0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(184, 110, 0, 0.4); }
      50% { opacity: 0.7; box-shadow: 0 0 0 4px rgba(184, 110, 0, 0); }
    }

    .last-updated {
      font-size: 10px;
      color: var(--text-2);
      margin-left: 4px;
    }

    /* Layout */
    .layout { display: flex; flex: 1; }

    .sidebar {
      width: 200px;
      background: var(--bg-1);
      border-right: 1px solid var(--border);
      padding: 8px 0;
      overflow-y: auto;
    }

    .nav-section {
      padding: 8px 12px 4px;
      font-size: 11px;
      font-weight: 600;
      color: var(--text-2);
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }

    .nav-item {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 12px;
      color: var(--text-1);
      cursor: pointer;
      border: none;
      background: none;
      width: 100%;
      text-align: left;
      font-size: 13px;
      transition: all 0.1s;
    }

    .nav-item:hover { background: var(--bg-2); color: var(--text-0); }
    .nav-item.active { background: var(--accent-light); color: var(--accent); font-weight: 500; }

    .nav-icon { width: 16px; text-align: center; opacity: 0.7; }

    .main { flex: 1; overflow: hidden; display: flex; flex-direction: column; }

    .content { flex: 1; overflow-y: auto; padding: 24px; }

    /* Typography */
    .page-header { margin-bottom: 24px; }
    .page-title { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
    .page-desc { color: var(--text-2); font-size: 13px; }

    .section { margin-bottom: 24px; }
    .section-title { font-size: 13px; font-weight: 600; margin-bottom: 12px; color: var(--text-1); }

    /* Cards */
    .card {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      overflow: hidden;
    }

    .card-header {
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
      background: var(--bg-2);
    }

    .card-title { font-weight: 600; font-size: 13px; }
    .card-body { padding: 16px; }
    .card-body-flush { padding: 0; }

    /* Buttons */
    .btn {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      padding: 6px 12px;
      font-size: 13px;
      font-weight: 500;
      border-radius: var(--radius);
      cursor: pointer;
      transition: all 0.1s;
      border: none;
      white-space: nowrap;
    }

    .btn-primary { background: var(--accent); color: white; }
    .btn-primary:hover { background: var(--accent-hover); }

    .btn-secondary { background: var(--bg-2); color: var(--text-0); border: 1px solid var(--border); }
    .btn-secondary:hover { background: var(--bg-3); }

    .btn-ghost { background: transparent; color: var(--text-1); }
    .btn-ghost:hover { background: var(--bg-2); }

    .btn-sm { padding: 4px 8px; font-size: 12px; }

    .btn-icon {
      width: 28px;
      height: 28px;
      padding: 0;
      border-radius: var(--radius);
    }

    /* Inputs */
    .input-group { margin-bottom: 12px; }
    .input-label { display: block; font-size: 12px; font-weight: 500; margin-bottom: 4px; color: var(--text-1); }

    .input {
      width: 100%;
      padding: 8px 12px;
      font-size: 13px;
      border: 1px solid var(--border);
      border-radius: var(--radius);
      background: var(--bg-0);
      color: var(--text-0);
      transition: border-color 0.1s;
    }

    .input:focus { outline: none; border-color: var(--accent); }
    .input-mono { font-family: var(--font-mono); font-size: 12px; }

    .select {
      appearance: none;
      background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'%3E%3Cpath fill='%23666' d='M3 4.5L6 7.5L9 4.5'/%3E%3C/svg%3E");
      background-repeat: no-repeat;
      background-position: right 8px center;
      padding-right: 28px;
    }

    /* Tables */
    .table { width: 100%; border-collapse: collapse; }
    .table th, .table td { padding: 10px 12px; text-align: left; border-bottom: 1px solid var(--border); }
    .table th { font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px; color: var(--text-2); background: var(--bg-2); }
    .table tr:hover td { background: var(--bg-1); }
    .table-mono td { font-family: var(--font-mono); font-size: 12px; }

    /* Badges */
    .badge {
      display: inline-flex;
      align-items: center;
      padding: 2px 8px;
      font-size: 11px;
      font-weight: 600;
      border-radius: 3px;
      text-transform: uppercase;
      letter-spacing: 0.3px;
    }

    .badge-success { background: var(--success-bg); color: var(--success); }
    .badge-warning { background: var(--warning-bg); color: var(--warning); }
    .badge-error { background: var(--error-bg); color: var(--error); }
    .badge-info { background: var(--info-bg); color: var(--info); }
    .badge-neutral { background: var(--bg-2); color: var(--text-1); }

    .method-badge {
      font-family: var(--font-mono);
      font-size: 10px;
      padding: 2px 6px;
      border-radius: 3px;
      font-weight: 600;
    }

    .method-get { background: var(--success-bg); color: var(--success); }
    .method-post { background: var(--info-bg); color: var(--info); }
    .method-patch, .method-put { background: var(--warning-bg); color: var(--warning); }
    .method-delete { background: var(--error-bg); color: var(--error); }

    /* Code */
    .code {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      border-radius: var(--radius);
      padding: 12px;
      overflow-x: auto;
      white-space: pre-wrap;
      word-break: break-word;
    }

    .code-inline {
      font-family: var(--font-mono);
      font-size: 12px;
      background: var(--code-bg);
      padding: 2px 6px;
      border-radius: 3px;
    }

    /* Stats */
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px; }

    .stat-card {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      padding: 16px;
    }

    .stat-value { font-size: 28px; font-weight: 700; color: var(--accent); line-height: 1; }
    .stat-label { font-size: 12px; color: var(--text-2); margin-top: 4px; }
    .stat-change { font-size: 11px; margin-top: 4px; }
    .stat-change.positive { color: var(--success); }
    .stat-change.negative { color: var(--error); }

    /* Tags */
    .tag-list { display: flex; flex-wrap: wrap; gap: 4px; }
    .tag {
      font-family: var(--font-mono);
      font-size: 11px;
      padding: 3px 8px;
      background: var(--bg-2);
      border-radius: 3px;
      color: var(--text-1);
    }

    /* Lists */
    .list-item {
      display: flex;
      align-items: center;
      justify-content: space-between;
      padding: 12px 16px;
      border-bottom: 1px solid var(--border);
      transition: background 0.1s;
    }

    .list-item:hover { background: var(--bg-1); }
    .list-item:last-child { border-bottom: none; }

    /* Tabs */
    .tabs { display: flex; border-bottom: 1px solid var(--border); margin-bottom: 16px; }

    .tab {
      padding: 8px 16px;
      font-size: 13px;
      color: var(--text-2);
      cursor: pointer;
      border: none;
      background: none;
      border-bottom: 2px solid transparent;
      margin-bottom: -1px;
      transition: all 0.1s;
    }

    .tab:hover { color: var(--text-0); }
    .tab.active { color: var(--accent); border-bottom-color: var(--accent); font-weight: 500; }

    /* Panels */
    .panel {
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      max-height: 400px;
      overflow-y: auto;
    }

    .panel-header {
      padding: 8px 12px;
      background: var(--bg-2);
      border-bottom: 1px solid var(--border);
      font-size: 12px;
      font-weight: 600;
      display: flex;
      align-items: center;
      justify-content: space-between;
      position: sticky;
      top: 0;
    }

    /* Event stream */
    .event-stream {
      font-family: var(--font-mono);
      font-size: 12px;
      max-height: 400px;
      overflow-y: auto;
      background: var(--code-bg);
    }

    .event-item {
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      transition: background 0.15s;
    }

    .event-item:hover {
      background: var(--bg-2);
    }

    .event-item.selected {
      background: var(--accent-light);
      border-left: 3px solid var(--accent);
    }

    .event-header { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .event-type { font-weight: 600; }
    .event-time { color: var(--text-2); font-size: 11px; }
    .event-data { color: var(--text-1); white-space: pre-wrap; word-break: break-all; font-size: 12px; font-family: var(--font-mono); }

    /* Empty state */
    .empty-state {
      text-align: center;
      padding: 48px 24px;
      color: var(--text-2);
    }

    .empty-icon { font-size: 32px; margin-bottom: 12px; opacity: 0.5; }
    .empty-title { font-weight: 600; color: var(--text-1); margin-bottom: 4px; }
    .empty-desc { font-size: 13px; }

    /* Toolbar */
    .toolbar {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 8px 16px;
      background: var(--bg-2);
      border-bottom: 1px solid var(--border);
    }

    .toolbar-spacer { flex: 1; }

    /* Split pane */
    .split-pane { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; }

    /* Responsive */
    @media (max-width: 768px) {
      .sidebar { display: none; }
      .split-pane { grid-template-columns: 1fr; }
    }

    /* Animations */
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.5; }
    }

    .pulse { animation: pulse 2s infinite; }

    /* Scrollbar */
    ::-webkit-scrollbar { width: 8px; height: 8px; }
    ::-webkit-scrollbar-track { background: var(--bg-1); }
    ::-webkit-scrollbar-thumb { background: var(--bg-3); border-radius: 4px; }
    ::-webkit-scrollbar-thumb:hover { background: var(--text-2); }

    /* JSON syntax highlighting */
    .json-key { color: #0066cc; }
    .json-string { color: #008800; }
    .json-number { color: #aa00aa; }
    .json-boolean { color: #0000ff; }
    .json-null { color: #888888; }

    [data-theme="dark"] .json-key { color: #6eb5ff; }
    [data-theme="dark"] .json-string { color: #98c379; }
    [data-theme="dark"] .json-number { color: #d19a66; }
    [data-theme="dark"] .json-boolean { color: #56b6c2; }
    [data-theme="dark"] .json-null { color: #888888; }

    /* Resource card */
    .resource-card {
      border: 1px solid var(--border);
      border-radius: var(--radius);
      margin-bottom: 12px;
      overflow: hidden;
    }

    .resource-header {
      padding: 12px 16px;
      background: var(--bg-2);
      display: flex;
      align-items: center;
      justify-content: space-between;
      cursor: pointer;
    }

    .resource-header:hover { background: var(--bg-3); }

    .resource-path {
      font-family: var(--font-mono);
      font-weight: 600;
      font-size: 14px;
    }

    .resource-body { padding: 16px; background: var(--bg-1); }

    /* Request details */
    .request-row {
      display: grid;
      grid-template-columns: 70px 1fr 80px 70px 120px;
      gap: 12px;
      align-items: center;
      padding: 8px 12px;
      border-bottom: 1px solid var(--border);
      font-size: 13px;
      cursor: pointer;
    }

    .request-row:hover { background: var(--bg-1); }

    .request-path {
      font-family: var(--font-mono);
      font-size: 12px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .request-status.success { color: var(--success); }
    .request-status.error { color: var(--error); }

    .request-duration { font-family: var(--font-mono); font-size: 12px; }
    .duration-fast { color: var(--success); }
    .duration-medium { color: var(--warning); }
    .duration-slow { color: var(--error); }

    /* Filter builder */
    .filter-builder { display: flex; flex-direction: column; gap: 8px; }
    .filter-row { display: flex; gap: 8px; align-items: center; }
    .filter-row .input { flex: 1; }

    /* Modal */
    .modal-overlay {
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 1000;
    }

    .modal {
      background: var(--bg-0);
      border-radius: var(--radius);
      width: 90%;
      max-width: 800px;
      max-height: 90vh;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: var(--shadow-lg);
    }

    .modal-header {
      padding: 16px;
      border-bottom: 1px solid var(--border);
      display: flex;
      align-items: center;
      justify-content: space-between;
    }

    .modal-title { font-weight: 600; font-size: 16px; }
    .modal-body { padding: 16px; overflow-y: auto; flex: 1; }
    .modal-footer { padding: 16px; border-top: 1px solid var(--border); display: flex; justify-content: flex-end; gap: 8px; }

    /* Toast */
    .toast-container {
      position: fixed;
      bottom: 24px;
      right: 24px;
      z-index: 1001;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .toast {
      padding: 12px 16px;
      background: var(--bg-1);
      border: 1px solid var(--border);
      border-radius: var(--radius);
      box-shadow: var(--shadow-lg);
      display: flex;
      align-items: center;
      gap: 8px;
      min-width: 280px;
    }

    .toast-success { border-left: 3px solid var(--success); }
    .toast-error { border-left: 3px solid var(--error); }
    .toast-info { border-left: 3px solid var(--info); }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="text/babel">
    const { useState, useEffect, useCallback, useRef } = React;
    const API = '${basePath}';

    // Utility functions
    const formatDuration = (ms) => {
      if (ms < 1) return '<1ms';
      if (ms < 1000) return Math.round(ms) + 'ms';
      return (ms / 1000).toFixed(2) + 's';
    };

    const formatTime = (ts) => {
      const d = new Date(ts);
      return d.toLocaleTimeString();
    };

    const formatJSON = (obj, indent = 2) => {
      try {
        return JSON.stringify(obj, null, indent);
      } catch {
        return String(obj);
      }
    };

    const classNames = (...classes) => classes.filter(Boolean).join(' ');

    // Toast system
    const ToastContext = React.createContext();

    function ToastProvider({ children }) {
      const [toasts, setToasts] = useState([]);

      const addToast = useCallback((message, type = 'info') => {
        const id = Date.now();
        setToasts(t => [...t, { id, message, type }]);
        setTimeout(() => setToasts(t => t.filter(x => x.id !== id)), 3000);
      }, []);

      return (
        <ToastContext.Provider value={addToast}>
          {children}
          <div className="toast-container">
            {toasts.map(t => (
              <div key={t.id} className={\`toast toast-\${t.type}\`}>{t.message}</div>
            ))}
          </div>
        </ToastContext.Provider>
      );
    }

    const useToast = () => React.useContext(ToastContext);

    // Main App
    // Connection status context
    const ConnectionContext = React.createContext({ connected: true, lastUpdated: null, setConnected: () => {}, updateLastUpdated: () => {} });

    function ConnectionProvider({ children }) {
      const [connected, setConnected] = useState(true);
      const [lastUpdated, setLastUpdated] = useState(new Date());

      const updateLastUpdated = useCallback(() => {
        setLastUpdated(new Date());
        setConnected(true);
      }, []);

      useEffect(() => {
        const checkConnection = async () => {
          try {
            const res = await fetch(API + '/api/resources', { method: 'HEAD' });
            if (res.ok) {
              setConnected(true);
            } else {
              setConnected(false);
            }
          } catch {
            setConnected(false);
          }
        };

        const interval = setInterval(checkConnection, 10000);
        return () => clearInterval(interval);
      }, []);

      return (
        <ConnectionContext.Provider value={{ connected, lastUpdated, setConnected, updateLastUpdated }}>
          {children}
        </ConnectionContext.Provider>
      );
    }

    const useConnection = () => React.useContext(ConnectionContext);

    const formatLastUpdated = (date) => {
      if (!date) return '';
      const now = new Date();
      const diff = Math.floor((now - date) / 1000);
      if (diff < 5) return 'just now';
      if (diff < 60) return diff + 's ago';
      if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
      return date.toLocaleTimeString();
    };

    function App() {
      const [theme, setTheme] = useState(() => localStorage.getItem('concave-theme') || 'light');
      const [page, setPage] = useState('dashboard');

      useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
        localStorage.setItem('concave-theme', theme);
      }, [theme]);

      const pages = {
        dashboard: { icon: '\\u25A6', label: 'Dashboard', component: DashboardPage },
        resources: { icon: '\\u25A3', label: 'Resources', component: ResourcesPage },
        requests: { icon: '\\u2192', label: 'Requests', component: RequestsPage },
        errors: { icon: '\\u26A0', label: 'Errors', component: ErrorsPage },
        users: { icon: '\\u263A', label: 'Users', component: UsersPage },
        sessions: { icon: '\\u26BF', label: 'Sessions', component: SessionsPage },
        filter: { icon: '\\u29D6', label: 'Filter Tester', component: FilterPage },
        subscriptions: { icon: '\\u21C4', label: 'Subscriptions', component: SubscriptionsPage },
        changelog: { icon: '\\u2630', label: 'Changelog', component: ChangelogPage },
        explorer: { icon: '\\u2318', label: 'API Explorer', component: ExplorerPage },
        docs: { icon: '\\u2139', label: 'Error Docs', component: DocsPage },
      };

      const PageComponent = pages[page]?.component || DashboardPage;

      return (
        <ConnectionProvider>
          <ToastProvider>
            <AppContent theme={theme} setTheme={setTheme} page={page} setPage={setPage} pages={pages} PageComponent={PageComponent} />
          </ToastProvider>
        </ConnectionProvider>
      );
    }

    function AppContent({ theme, setTheme, page, setPage, pages, PageComponent }) {
      const { connected, lastUpdated } = useConnection();
      const [lastUpdatedDisplay, setLastUpdatedDisplay] = useState('');

      useEffect(() => {
        const updateDisplay = () => setLastUpdatedDisplay(formatLastUpdated(lastUpdated));
        updateDisplay();
        const interval = setInterval(updateDisplay, 1000);
        return () => clearInterval(interval);
      }, [lastUpdated]);

      const isStale = lastUpdated && (Date.now() - lastUpdated.getTime()) > 30000;
      const statusClass = !connected ? 'disconnected' : isStale ? 'stale' : '';
      const statusText = !connected ? 'Disconnected' : isStale ? 'Stale' : 'Connected';

      return (
        <div className="app">
          <header className="header">
            <div className="header-left">
              <div className="logo">
                <div className="logo-icon">C</div>
                <span>Concave Admin</span>
              </div>
              <div className="status-indicator">
                <div className={\`status-dot \${statusClass}\`}></div>
                <span>{statusText}</span>
                {lastUpdatedDisplay && <span className="last-updated">({lastUpdatedDisplay})</span>}
              </div>
            </div>
            <div className="header-right">
              <button
                className="btn btn-ghost btn-sm"
                onClick={() => setTheme(t => t === 'light' ? 'dark' : 'light')}
              >
                {theme === 'light' ? '\\u263D' : '\\u2600'}
              </button>
            </div>
          </header>

            <div className="layout">
              <nav className="sidebar">
                <div className="nav-section">Overview</div>
                {['dashboard', 'resources', 'requests', 'errors'].map(key => (
                  <button
                    key={key}
                    className={classNames('nav-item', page === key && 'active')}
                    onClick={() => setPage(key)}
                  >
                    <span className="nav-icon">{pages[key].icon}</span>
                    {pages[key].label}
                  </button>
                ))}

                <div className="nav-section">Auth</div>
                {['users', 'sessions'].map(key => (
                  <button
                    key={key}
                    className={classNames('nav-item', page === key && 'active')}
                    onClick={() => setPage(key)}
                  >
                    <span className="nav-icon">{pages[key].icon}</span>
                    {pages[key].label}
                  </button>
                ))}

                <div className="nav-section">Tools</div>
                {['filter', 'explorer', 'subscriptions', 'changelog'].map(key => (
                  <button
                    key={key}
                    className={classNames('nav-item', page === key && 'active')}
                    onClick={() => setPage(key)}
                  >
                    <span className="nav-icon">{pages[key].icon}</span>
                    {pages[key].label}
                  </button>
                ))}

                <div className="nav-section">Help</div>
                <button
                  className={classNames('nav-item', page === 'docs' && 'active')}
                  onClick={() => setPage('docs')}
                >
                  <span className="nav-icon">{pages.docs.icon}</span>
                  {pages.docs.label}
                </button>
              </nav>

            <main className="main">
              <div className="content">
                <PageComponent />
              </div>
            </main>
          </div>
        </div>
      );
    }

    // Dashboard Page
    function DashboardPage() {
      const [metrics, setMetrics] = useState({ metrics: [], slowQueries: [] });
      const [resources, setResources] = useState([]);
      const [errors, setErrors] = useState([]);
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        const fetchData = () => {
          Promise.all([
            fetch(API + '/api/metrics').then(r => r.json()),
            fetch(API + '/api/resources').then(r => r.json()),
            fetch(API + '/api/errors').then(r => r.json()),
          ]).then(([m, r, e]) => {
            setMetrics(m);
            setResources(r.resources || []);
            setErrors(e.errors || []);
            updateLastUpdated();
          }).catch(() => {});
        };
        fetchData();
        const interval = setInterval(fetchData, 5000);
        return () => clearInterval(interval);
      }, [updateLastUpdated]);

      const totalRequests = metrics.metrics?.length || 0;
      const avgDuration = totalRequests > 0
        ? Math.round(metrics.metrics.reduce((s, m) => s + m.duration, 0) / totalRequests)
        : 0;
      const errorCount = errors.length;
      const slowCount = metrics.slowQueries?.length || 0;

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Dashboard</h1>
            <p className="page-desc">Overview of your Concave API server</p>
          </div>

          <div className="stats-grid" style={{marginBottom: 24}}>
            <div className="stat-card">
              <div className="stat-value">{resources.length}</div>
              <div className="stat-label">Resources</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{totalRequests}</div>
              <div className="stat-label">Requests</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{avgDuration}ms</div>
              <div className="stat-label">Avg Response</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{color: errorCount > 0 ? 'var(--error)' : undefined}}>{errorCount}</div>
              <div className="stat-label">Errors</div>
            </div>
            <div className="stat-card">
              <div className="stat-value" style={{color: slowCount > 0 ? 'var(--warning)' : undefined}}>{slowCount}</div>
              <div className="stat-label">Slow Queries</div>
            </div>
          </div>

          <div className="split-pane">
            <div className="card">
              <div className="card-header">
                <span className="card-title">Recent Requests</span>
              </div>
              <div className="card-body-flush" style={{maxHeight: 300, overflow: 'auto'}}>
                {metrics.metrics?.slice(0, 10).map((m, i) => (
                  <div key={i} className="list-item">
                    <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                      <span className={\`method-badge method-\${m.method?.toLowerCase()}\`}>{m.method}</span>
                      <span className="code-inline">{m.path}</span>
                    </div>
                    <span className={\`request-duration \${m.duration < 100 ? 'duration-fast' : m.duration < 500 ? 'duration-medium' : 'duration-slow'}\`}>
                      {formatDuration(m.duration)}
                    </span>
                  </div>
                ))}
                {(!metrics.metrics || metrics.metrics.length === 0) && (
                  <div className="empty-state">
                    <div className="empty-title">No requests yet</div>
                    <div className="empty-desc">Make some API calls to see them here</div>
                  </div>
                )}
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <span className="card-title">Resources</span>
              </div>
              <div className="card-body-flush" style={{maxHeight: 300, overflow: 'auto'}}>
                {resources.map((r, i) => (
                  <div key={i} className="list-item">
                    <span className="code-inline">{r.path}</span>
                    <div style={{display: 'flex', gap: 4}}>
                      <span className="badge badge-neutral">{r.fields?.length || 0} fields</span>
                      {r.capabilities?.enableSubscriptions !== false && (
                        <span className="badge badge-success">SSE</span>
                      )}
                    </div>
                  </div>
                ))}
                {resources.length === 0 && (
                  <div className="empty-state">
                    <div className="empty-title">No resources</div>
                    <div className="empty-desc">Register resources with registerResource()</div>
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      );
    }

    // Users Page
    function UsersPage() {
      const [data, setData] = useState({ users: [], total: 0, enabled: false });
      const [loading, setLoading] = useState(true);
      const [showModal, setShowModal] = useState(null);
      const [editUser, setEditUser] = useState(null);
      const [formData, setFormData] = useState({ email: '', name: '', metadata: '' });
      const { updateLastUpdated } = useConnection();
      const addToast = useToast();

      const loadUsers = async () => {
        try {
          const res = await fetch(API + '/api/users');
          const d = await res.json();
          setData(d);
          updateLastUpdated();
        } catch {
          addToast('Failed to load users', 'error');
        }
        setLoading(false);
      };

      useEffect(() => { loadUsers(); }, []);

      const handleCreate = async () => {
        try {
          const body = { email: formData.email, name: formData.name || undefined };
          if (formData.metadata) body.metadata = JSON.parse(formData.metadata);
          const res = await fetch(API + '/api/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!res.ok) throw new Error((await res.json()).error);
          addToast('User created successfully', 'success');
          setShowModal(null);
          setFormData({ email: '', name: '', metadata: '' });
          loadUsers();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const handleUpdate = async () => {
        try {
          const body = { email: formData.email || undefined, name: formData.name || undefined };
          if (formData.metadata) body.metadata = JSON.parse(formData.metadata);
          const res = await fetch(API + '/api/users/' + editUser.id, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
          });
          if (!res.ok) throw new Error((await res.json()).error);
          addToast('User updated successfully', 'success');
          setShowModal(null);
          setEditUser(null);
          setFormData({ email: '', name: '', metadata: '' });
          loadUsers();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const handleDelete = async (user) => {
        if (!confirm('Delete user ' + user.email + '?')) return;
        try {
          const res = await fetch(API + '/api/users/' + user.id, { method: 'DELETE' });
          if (!res.ok && res.status !== 204) throw new Error('Delete failed');
          addToast('User deleted', 'success');
          loadUsers();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const openEdit = (user) => {
        setEditUser(user);
        setFormData({ email: user.email || '', name: user.name || '', metadata: user.metadata ? JSON.stringify(user.metadata, null, 2) : '' });
        setShowModal('edit');
      };

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Users</h1>
            <p className="page-desc">Manage users and their accounts</p>
          </div>

          {!data.enabled ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-icon">&#128100;</div>
                <div className="empty-title">User management not configured</div>
                <div className="empty-desc">Pass userManager config to createAdminUI() to enable</div>
              </div>
            </div>
          ) : (
            <>
              <div style={{marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <span className="badge badge-neutral">{data.total} users</span>
                <button className="btn btn-primary" onClick={() => { setShowModal('create'); setFormData({ email: '', name: '', metadata: '' }); }}>
                  + Create User
                </button>
              </div>

              <div className="card">
                <div className="card-body-flush">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>ID</th>
                        <th>Email</th>
                        <th>Name</th>
                        <th>Created</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.users.map(u => (
                        <tr key={u.id}>
                          <td><span className="code-inline">{u.id}</span></td>
                          <td>{u.email}</td>
                          <td>{u.name || '-'}</td>
                          <td>{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : '-'}</td>
                          <td>
                            <div style={{display: 'flex', gap: 4}}>
                              <button className="btn btn-secondary btn-sm" onClick={() => openEdit(u)}>Edit</button>
                              <button className="btn btn-ghost btn-sm" style={{color: 'var(--error)'}} onClick={() => handleDelete(u)}>Delete</button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.users.length === 0 && !loading && (
                    <div className="empty-state">
                      <div className="empty-title">No users</div>
                      <div className="empty-desc">Create your first user to get started</div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {showModal && (
            <div className="modal-overlay" onClick={() => setShowModal(null)}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">{showModal === 'create' ? 'Create User' : 'Edit User'}</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowModal(null)}>\\u00D7</button>
                </div>
                <div className="modal-body">
                  <div className="input-group">
                    <label className="input-label">Email *</label>
                    <input className="input" type="email" value={formData.email} onChange={e => setFormData({...formData, email: e.target.value})} placeholder="user@example.com" />
                  </div>
                  <div className="input-group">
                    <label className="input-label">Name</label>
                    <input className="input" value={formData.name} onChange={e => setFormData({...formData, name: e.target.value})} placeholder="John Doe" />
                  </div>
                  <div className="input-group">
                    <label className="input-label">Metadata (JSON)</label>
                    <textarea className="input input-mono" style={{minHeight: 80}} value={formData.metadata} onChange={e => setFormData({...formData, metadata: e.target.value})} placeholder='{"role": "admin"}' />
                  </div>
                </div>
                <div className="modal-footer">
                  <button className="btn btn-secondary" onClick={() => setShowModal(null)}>Cancel</button>
                  <button className="btn btn-primary" onClick={showModal === 'create' ? handleCreate : handleUpdate}>
                    {showModal === 'create' ? 'Create' : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Sessions Page
    function SessionsPage() {
      const [data, setData] = useState({ sessions: [], enabled: false });
      const [users, setUsers] = useState([]);
      const [loading, setLoading] = useState(true);
      const [showMint, setShowMint] = useState(false);
      const [mintUserId, setMintUserId] = useState('');
      const [mintExpiresIn, setMintExpiresIn] = useState('86400');
      const [mintedToken, setMintedToken] = useState(null);
      const { updateLastUpdated } = useConnection();
      const addToast = useToast();

      const loadData = async () => {
        try {
          const [sessRes, usersRes] = await Promise.all([
            fetch(API + '/api/sessions'),
            fetch(API + '/api/users')
          ]);
          const [sess, usr] = await Promise.all([sessRes.json(), usersRes.json()]);
          setData(sess);
          setUsers(usr.users || []);
          updateLastUpdated();
        } catch {
          addToast('Failed to load sessions', 'error');
        }
        setLoading(false);
      };

      useEffect(() => { loadData(); }, []);

      const handleMint = async () => {
        try {
          const res = await fetch(API + '/api/sessions', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ userId: mintUserId, expiresIn: parseInt(mintExpiresIn) * 1000 })
          });
          if (!res.ok) throw new Error((await res.json()).error);
          const { session } = await res.json();
          setMintedToken(session);
          addToast('Session created successfully', 'success');
          loadData();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const handleRevoke = async (sessionId) => {
        if (!confirm('Revoke this session?')) return;
        try {
          const res = await fetch(API + '/api/sessions/' + sessionId, { method: 'DELETE' });
          if (!res.ok && res.status !== 204) throw new Error('Revoke failed');
          addToast('Session revoked', 'success');
          loadData();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const handleRevokeAllForUser = async (userId) => {
        if (!confirm('Revoke all sessions for this user?')) return;
        try {
          const res = await fetch(API + '/api/sessions/user/' + userId, { method: 'DELETE' });
          if (!res.ok) throw new Error('Revoke failed');
          const { revokedCount } = await res.json();
          addToast('Revoked ' + revokedCount + ' sessions', 'success');
          loadData();
        } catch (e) {
          addToast(e.message, 'error');
        }
      };

      const getUserEmail = (userId) => users.find(u => u.id === userId)?.email || userId;

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Sessions</h1>
            <p className="page-desc">View and manage user sessions</p>
          </div>

          {!data.enabled ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-icon">&#128274;</div>
                <div className="empty-title">Session management not configured</div>
                <div className="empty-desc">Pass sessionManager config to createAdminUI() to enable</div>
              </div>
            </div>
          ) : (
            <>
              <div style={{marginBottom: 16, display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                <span className="badge badge-neutral">{data.sessions.length} active sessions</span>
                <button className="btn btn-primary" onClick={() => { setShowMint(true); setMintedToken(null); }}>
                  + Mint Session
                </button>
              </div>

              <div className="card">
                <div className="card-body-flush">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Token (prefix)</th>
                        <th>User</th>
                        <th>Created</th>
                        <th>Expires</th>
                        <th>Actions</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map(s => (
                        <tr key={s.sessionToken || s.id}>
                          <td><span className="code-inline">{(s.sessionToken || s.id || '').substring(0, 12)}...</span></td>
                          <td>{getUserEmail(s.userId)}</td>
                          <td>{s.createdAt ? new Date(s.createdAt).toLocaleDateString() : '-'}</td>
                          <td>
                            {s.expires ? (
                              <span className={new Date(s.expires) < new Date() ? 'badge badge-error' : 'badge badge-success'}>
                                {new Date(s.expires).toLocaleDateString()}
                              </span>
                            ) : '-'}
                          </td>
                          <td>
                            <div style={{display: 'flex', gap: 4}}>
                              <button className="btn btn-ghost btn-sm" style={{color: 'var(--error)'}} onClick={() => handleRevoke(s.sessionToken || s.id)}>
                                Revoke
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {data.sessions.length === 0 && !loading && (
                    <div className="empty-state">
                      <div className="empty-title">No active sessions</div>
                      <div className="empty-desc">Mint a session for a user to get started</div>
                    </div>
                  )}
                </div>
              </div>
            </>
          )}

          {showMint && (
            <div className="modal-overlay" onClick={() => setShowMint(false)}>
              <div className="modal" onClick={e => e.stopPropagation()}>
                <div className="modal-header">
                  <span className="modal-title">Mint Session</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowMint(false)}>\\u00D7</button>
                </div>
                <div className="modal-body">
                  {mintedToken ? (
                    <div>
                      <div className="badge badge-success" style={{marginBottom: 12}}>Session created!</div>
                      <div className="input-group">
                        <label className="input-label">Session Token</label>
                        <div className="code" style={{wordBreak: 'break-all'}}>{mintedToken.token}</div>
                      </div>
                      <div className="input-group">
                        <label className="input-label">Expires At</label>
                        <div>{new Date(mintedToken.expiresAt).toLocaleString()}</div>
                      </div>
                      <p style={{fontSize: 12, color: 'var(--warning)', marginTop: 12}}>
                        Copy this token now - it won't be shown again!
                      </p>
                    </div>
                  ) : (
                    <>
                      <div className="input-group">
                        <label className="input-label">User *</label>
                        <select className="input select" value={mintUserId} onChange={e => setMintUserId(e.target.value)}>
                          <option value="">Select user...</option>
                          {users.map(u => <option key={u.id} value={u.id}>{u.email} ({u.id})</option>)}
                        </select>
                      </div>
                      <div className="input-group">
                        <label className="input-label">Expires In (seconds)</label>
                        <select className="input select" value={mintExpiresIn} onChange={e => setMintExpiresIn(e.target.value)}>
                          <option value="3600">1 hour</option>
                          <option value="86400">1 day</option>
                          <option value="604800">1 week</option>
                          <option value="2592000">30 days</option>
                        </select>
                      </div>
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn btn-secondary" onClick={() => setShowMint(false)}>Close</button>
                  {!mintedToken && (
                    <button className="btn btn-primary" onClick={handleMint} disabled={!mintUserId}>
                      Mint Session
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Resources Page
    function ResourcesPage() {
      const [resources, setResources] = useState([]);
      const [expanded, setExpanded] = useState(null);
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        fetch(API + '/api/resources').then(r => r.json()).then(d => {
          setResources(d.resources || []);
          updateLastUpdated();
        }).catch(() => {});
      }, [updateLastUpdated]);

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Resources</h1>
            <p className="page-desc">Registered API resources and their configuration</p>
          </div>

          {resources.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-icon">&#128230;</div>
                <div className="empty-title">No resources registered</div>
                <div className="empty-desc">Use registerResource() to add resources to the admin panel</div>
              </div>
            </div>
          ) : (
            resources.map((r, i) => (
              <div key={i} className="resource-card">
                <div className="resource-header" onClick={() => setExpanded(expanded === i ? null : i)}>
                  <div style={{display: 'flex', alignItems: 'center', gap: 12}}>
                    <span className="resource-path">{r.path}</span>
                    <span className="badge badge-neutral">{r.fields?.length || 0} fields</span>
                    {r.capabilities?.enableSubscriptions !== false && <span className="badge badge-success">SSE</span>}
                    {r.procedures?.length > 0 && <span className="badge badge-info">{r.procedures.length} RPC</span>}
                  </div>
                  <span style={{color: 'var(--text-2)'}}>{expanded === i ? '\\u25B2' : '\\u25BC'}</span>
                </div>
                {expanded === i && (
                  <div className="resource-body">
                    <div className="section">
                      <div className="section-title">Fields</div>
                      <div className="tag-list">
                        {(r.fields || []).map((f, j) => <span key={j} className="tag">{f}</span>)}
                      </div>
                    </div>

                    {r.capabilities && (
                      <div className="section">
                        <div className="section-title">Capabilities</div>
                        <div className="tag-list">
                          {Object.entries(r.capabilities).map(([k, v]) => (
                            <span key={k} className="tag" style={{background: v ? 'var(--success-bg)' : 'var(--bg-2)', color: v ? 'var(--success)' : 'var(--text-2)'}}>
                              {k.replace('enable', '')}
                            </span>
                          ))}
                        </div>
                      </div>
                    )}

                    {r.auth && (
                      <div className="section">
                        <div className="section-title">Auth Configuration</div>
                        <div className="code">{formatJSON(r.auth)}</div>
                      </div>
                    )}

                    {r.procedures?.length > 0 && (
                      <div className="section">
                        <div className="section-title">RPC Procedures</div>
                        <div className="tag-list">
                          {r.procedures.map((p, j) => <span key={j} className="tag">{p}</span>)}
                        </div>
                      </div>
                    )}

                    <div className="section">
                      <div className="section-title">Endpoints</div>
                      <table className="table table-mono">
                        <thead>
                          <tr><th>Method</th><th>Path</th><th>Description</th></tr>
                        </thead>
                        <tbody>
                          <tr><td><span className="method-badge method-get">GET</span></td><td>{r.path}</td><td>List items</td></tr>
                          <tr><td><span className="method-badge method-get">GET</span></td><td>{r.path}/:id</td><td>Get item</td></tr>
                          <tr><td><span className="method-badge method-post">POST</span></td><td>{r.path}</td><td>Create item</td></tr>
                          <tr><td><span className="method-badge method-patch">PATCH</span></td><td>{r.path}/:id</td><td>Update item</td></tr>
                          <tr><td><span className="method-badge method-delete">DELETE</span></td><td>{r.path}/:id</td><td>Delete item</td></tr>
                          <tr><td><span className="method-badge method-get">GET</span></td><td>{r.path}/count</td><td>Count items</td></tr>
                          <tr><td><span className="method-badge method-get">GET</span></td><td>{r.path}/subscribe</td><td>SSE stream</td></tr>
                        </tbody>
                      </table>
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      );
    }

    // Requests Page
    function RequestsPage() {
      const [requests, setRequests] = useState([]);
      const [selected, setSelected] = useState(null);
      const [filter, setFilter] = useState({ method: '', status: '', path: '' });
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        const load = () => fetch(API + '/api/metrics').then(r => r.json()).then(d => {
          setRequests(d.metrics || []);
          updateLastUpdated();
        }).catch(() => {});
        load();
        const interval = setInterval(load, 3000);
        return () => clearInterval(interval);
      }, [updateLastUpdated]);

      const filtered = requests.filter(r => {
        if (filter.method && r.method !== filter.method) return false;
        if (filter.status === 'success' && r.status >= 400) return false;
        if (filter.status === 'error' && r.status < 400) return false;
        if (filter.path && !r.path.includes(filter.path)) return false;
        return true;
      });

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Requests</h1>
            <p className="page-desc">Recent API requests and response times</p>
          </div>

          <div className="toolbar" style={{marginBottom: 16, borderRadius: 'var(--radius)'}}>
            <select className="input select" style={{width: 120}} value={filter.method} onChange={e => setFilter({...filter, method: e.target.value})}>
              <option value="">All Methods</option>
              <option value="GET">GET</option>
              <option value="POST">POST</option>
              <option value="PATCH">PATCH</option>
              <option value="PUT">PUT</option>
              <option value="DELETE">DELETE</option>
            </select>
            <select className="input select" style={{width: 120}} value={filter.status} onChange={e => setFilter({...filter, status: e.target.value})}>
              <option value="">All Status</option>
              <option value="success">Success</option>
              <option value="error">Error</option>
            </select>
            <input
              className="input"
              style={{width: 200}}
              placeholder="Filter by path..."
              value={filter.path}
              onChange={e => setFilter({...filter, path: e.target.value})}
            />
            <div className="toolbar-spacer" />
            <span style={{fontSize: 12, color: 'var(--text-2)'}}>{filtered.length} requests</span>
          </div>

          <div className="card">
            <div className="card-body-flush">
              <div style={{display: 'grid', gridTemplateColumns: '70px 1fr 60px 80px 100px', gap: 12, padding: '8px 12px', background: 'var(--bg-2)', borderBottom: '1px solid var(--border)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', color: 'var(--text-2)'}}>
                <span>Method</span>
                <span>Path</span>
                <span>Status</span>
                <span>Duration</span>
                <span>Time</span>
              </div>
              <div style={{maxHeight: 500, overflow: 'auto'}}>
                {filtered.map((r, i) => (
                  <div
                    key={i}
                    className="request-row"
                    onClick={() => setSelected(selected === i ? null : i)}
                    style={{background: selected === i ? 'var(--accent-light)' : undefined}}
                  >
                    <span className={\`method-badge method-\${r.method?.toLowerCase()}\`}>{r.method}</span>
                    <span className="request-path">{r.path}</span>
                    <span className={\`request-status \${r.status < 400 ? 'success' : 'error'}\`}>{r.status}</span>
                    <span className={\`request-duration \${r.duration < 100 ? 'duration-fast' : r.duration < 500 ? 'duration-medium' : 'duration-slow'}\`}>
                      {formatDuration(r.duration)}
                    </span>
                    <span style={{fontSize: 12, color: 'var(--text-2)'}}>{formatTime(r.timestamp)}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          {selected !== null && filtered[selected] && (
            <div className="card" style={{marginTop: 16}}>
              <div className="card-header">
                <span className="card-title">Request Details</span>
                <button className="btn btn-ghost btn-sm" onClick={() => setSelected(null)}>\\u2715</button>
              </div>
              <div className="card-body">
                <div className="code">{formatJSON(filtered[selected])}</div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Errors Page
    function ErrorsPage() {
      const [errors, setErrors] = useState([]);
      const [selected, setSelected] = useState(null);
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        const load = () => fetch(API + '/api/errors').then(r => r.json()).then(d => {
          setErrors(d.errors || []);
          updateLastUpdated();
        }).catch(() => {});
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
      }, [updateLastUpdated]);

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Errors</h1>
            <p className="page-desc">Recent API errors and exceptions</p>
          </div>

          {errors.length === 0 ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-icon">\\u2713</div>
                <div className="empty-title">No errors</div>
                <div className="empty-desc">Your API is running smoothly</div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-body-flush">
                {errors.map((e, i) => (
                  <div
                    key={i}
                    className="list-item"
                    style={{cursor: 'pointer', flexDirection: 'column', alignItems: 'stretch'}}
                    onClick={() => setSelected(selected === i ? null : i)}
                  >
                    <div style={{display: 'flex', justifyContent: 'space-between', alignItems: 'center'}}>
                      <div style={{display: 'flex', alignItems: 'center', gap: 8}}>
                        <span className="badge badge-error">{e.statusCode}</span>
                        <span className="code-inline">{e.path}</span>
                      </div>
                      <span style={{fontSize: 12, color: 'var(--text-2)'}}>{formatTime(e.timestamp)}</span>
                    </div>
                    <div style={{marginTop: 4, color: 'var(--error)', fontSize: 13}}>{e.error}</div>
                    {selected === i && e.stack && (
                      <div className="code" style={{marginTop: 8, fontSize: 11}}>{e.stack}</div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      );
    }

    // Filter Page
    function FilterPage() {
      const [filter, setFilter] = useState('');
      const [result, setResult] = useState(null);
      const [resources, setResources] = useState([]);
      const [selectedResource, setSelectedResource] = useState('');
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        fetch(API + '/api/resources').then(r => r.json()).then(d => {
          setResources(d.resources || []);
          updateLastUpdated();
        }).catch(() => {});
      }, [updateLastUpdated]);

      const parseFilter = () => {
        if (!filter.trim()) { setResult(null); return; }
        try {
          const ast = parseFilterAST(filter);
          setResult({ success: true, ast, sql: filterToSQL(ast) });
        } catch (e) {
          setResult({ success: false, error: e.message });
        }
      };

      const testFilter = async () => {
        if (!selectedResource || !filter) return;
        const url = \`\${selectedResource}?filter=\${encodeURIComponent(filter)}&limit=5\`;
        window.open(url, '_blank');
      };

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Filter Tester</h1>
            <p className="page-desc">Test and validate filter expressions</p>
          </div>

          <div className="card" style={{marginBottom: 16}}>
            <div className="card-body">
              <div className="input-group">
                <label className="input-label">Filter Expression</label>
                <div style={{display: 'flex', gap: 8}}>
                  <input
                    className="input input-mono"
                    value={filter}
                    onChange={e => setFilter(e.target.value)}
                    placeholder='status=="active";age>18'
                    onKeyDown={e => e.key === 'Enter' && parseFilter()}
                  />
                  <button className="btn btn-primary" onClick={parseFilter}>Parse</button>
                </div>
              </div>

              <div style={{display: 'flex', gap: 8, alignItems: 'center', marginTop: 12}}>
                <select className="input select" style={{width: 200}} value={selectedResource} onChange={e => setSelectedResource(e.target.value)}>
                  <option value="">Select resource...</option>
                  {resources.map((r, i) => <option key={i} value={r.path}>{r.path}</option>)}
                </select>
                <button className="btn btn-secondary" onClick={testFilter} disabled={!selectedResource || !filter}>
                  Test Query \\u2192
                </button>
              </div>
            </div>
          </div>

          {result && (
            <div className="split-pane">
              <div className="card">
                <div className="card-header">
                  <span className="card-title">{result.success ? 'Parsed AST' : 'Parse Error'}</span>
                  <span className={\`badge \${result.success ? 'badge-success' : 'badge-error'}\`}>
                    {result.success ? 'Valid' : 'Invalid'}
                  </span>
                </div>
                <div className="card-body">
                  <div className="code">{result.success ? formatJSON(result.ast) : result.error}</div>
                </div>
              </div>

              {result.success && result.sql && (
                <div className="card">
                  <div className="card-header">
                    <span className="card-title">SQL Equivalent</span>
                  </div>
                  <div className="card-body">
                    <div className="code">{result.sql}</div>
                  </div>
                </div>
              )}
            </div>
          )}

          <div className="card" style={{marginTop: 16}}>
            <div className="card-header">
              <span className="card-title">Operator Reference</span>
            </div>
            <div className="card-body-flush">
              <table className="table">
                <thead>
                  <tr><th>Operator</th><th>Description</th><th>Example</th></tr>
                </thead>
                <tbody>
                  <tr><td><code>==</code></td><td>Equals</td><td><code>status=="active"</code></td></tr>
                  <tr><td><code>!=</code></td><td>Not equals</td><td><code>status!="deleted"</code></td></tr>
                  <tr><td><code>&gt;</code></td><td>Greater than</td><td><code>age&gt;18</code></td></tr>
                  <tr><td><code>&gt;=</code></td><td>Greater or equal</td><td><code>age&gt;=18</code></td></tr>
                  <tr><td><code>&lt;</code></td><td>Less than</td><td><code>price&lt;100</code></td></tr>
                  <tr><td><code>&lt;=</code></td><td>Less or equal</td><td><code>price&lt;=100</code></td></tr>
                  <tr><td><code>=in=</code></td><td>In list</td><td><code>role=in=("admin","user")</code></td></tr>
                  <tr><td><code>=out=</code></td><td>Not in list</td><td><code>status=out=("deleted")</code></td></tr>
                  <tr><td><code>%=</code></td><td>LIKE pattern</td><td><code>name%="John%"</code></td></tr>
                  <tr><td><code>=isnull=</code></td><td>Is null check</td><td><code>deletedAt=isnull=true</code></td></tr>
                  <tr><td><code>;</code></td><td>AND combinator</td><td><code>a==1;b==2</code></td></tr>
                  <tr><td><code>,</code></td><td>OR combinator</td><td><code>a==1,a==2</code></td></tr>
                  <tr><td><code>()</code></td><td>Grouping</td><td><code>(a==1;b==2),c==3</code></td></tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>
      );
    }

    // Filter parser
    function parseFilterAST(filter) {
      const tokens = [];
      let i = 0;
      while (i < filter.length) {
        const c = filter[i];
        if (/\\s/.test(c)) { i++; continue; }
        if ('();,'.includes(c)) { tokens.push({ type: c === ';' ? 'AND' : c === ',' ? 'OR' : c, value: c }); i++; continue; }
        if (c === '"' || c === "'") {
          const q = c; let s = ''; i++;
          while (i < filter.length && filter[i] !== q) { if (filter[i] === '\\\\') i++; s += filter[i++]; }
          i++; tokens.push({ type: 'STRING', value: s }); continue;
        }
        if (/[a-zA-Z_]/.test(c)) {
          let id = ''; while (i < filter.length && /[a-zA-Z0-9_]/.test(filter[i])) id += filter[i++];
          if (id === 'true' || id === 'false') tokens.push({ type: 'BOOLEAN', value: id === 'true' });
          else if (id === 'null') tokens.push({ type: 'NULL', value: null });
          else tokens.push({ type: 'ID', value: id });
          continue;
        }
        if (/[0-9-]/.test(c)) {
          let n = ''; if (c === '-') { n += c; i++; }
          while (i < filter.length && /[0-9.]/.test(filter[i])) n += filter[i++];
          tokens.push({ type: 'NUMBER', value: parseFloat(n) }); continue;
        }
        const ops = ['==', '!=', '>=', '<=', '>', '<', '=in=', '=out=', '=isnull=', '%=', '!%='];
        let found = false;
        for (const op of ops) {
          if (filter.slice(i, i + op.length) === op) { tokens.push({ type: 'OP', value: op }); i += op.length; found = true; break; }
        }
        if (found) continue;
        throw new Error(\`Unexpected: \${c} at \${i}\`);
      }
      let pos = 0;
      const parseOr = () => { let l = parseAnd(); while (pos < tokens.length && tokens[pos].type === 'OR') { pos++; l = { type: 'OR', left: l, right: parseAnd() }; } return l; };
      const parseAnd = () => { let l = parseCmp(); while (pos < tokens.length && tokens[pos].type === 'AND') { pos++; l = { type: 'AND', left: l, right: parseCmp() }; } return l; };
      const parseCmp = () => {
        if (tokens[pos]?.value === '(') { pos++; const e = parseOr(); pos++; return e; }
        const f = tokens[pos++]?.value; const op = tokens[pos++]?.value;
        let v;
        if (tokens[pos]?.value === '(') { pos++; v = []; while (tokens[pos]?.value !== ')') { v.push(tokens[pos++]?.value); if (tokens[pos]?.value === ',') pos++; } pos++; }
        else v = tokens[pos++]?.value;
        return { type: 'CMP', field: f, op, value: v };
      };
      return parseOr();
    }

    function filterToSQL(ast) {
      if (!ast) return '';
      if (ast.type === 'AND') return \`(\${filterToSQL(ast.left)} AND \${filterToSQL(ast.right)})\`;
      if (ast.type === 'OR') return \`(\${filterToSQL(ast.left)} OR \${filterToSQL(ast.right)})\`;
      if (ast.type === 'CMP') {
        const v = typeof ast.value === 'string' ? \`'\${ast.value}'\` : Array.isArray(ast.value) ? \`(\${ast.value.map(x => typeof x === 'string' ? \`'\${x}'\` : x).join(', ')})\` : ast.value;
        const ops = { '==': '=', '!=': '!=', '>': '>', '>=': '>=', '<': '<', '<=': '<=', '=in=': 'IN', '=out=': 'NOT IN', '%=': 'LIKE', '=isnull=': 'IS' };
        const sqlOp = ops[ast.op] || ast.op;
        if (ast.op === '=isnull=') return \`\${ast.field} IS \${ast.value ? 'NULL' : 'NOT NULL'}\`;
        return \`\${ast.field} \${sqlOp} \${v}\`;
      }
      return '';
    }

    // Subscriptions Page
    function SubscriptionsPage() {
      const [resources, setResources] = useState([]);
      const [selected, setSelected] = useState('');
      const [isConnected, setIsConnected] = useState(false);
      const [events, setEvents] = useState([]);
      const [filter, setFilter] = useState('');
      const [selectedEvent, setSelectedEvent] = useState(null);
      const esRef = useRef(null);
      const prevDataRef = useRef({});
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        fetch(API + '/api/resources').then(r => r.json()).then(d => setResources(d.resources || []));
        return () => { if (esRef.current) esRef.current.close(); };
      }, []);

      const analyzeChanges = (type, data, prev) => {
        const changes = [];
        if (type === 'added') {
          changes.push({ type: 'created', message: 'New item created' });
        } else if (type === 'removed') {
          changes.push({ type: 'deleted', message: data.leftScope ? 'Item left filter scope' : 'Item was deleted' });
        } else if (type === 'changed' && data.object && prev) {
          const obj = data.object;
          const prevObj = prev[obj.id];
          if (prevObj) {
            for (const key of Object.keys(obj)) {
              if (JSON.stringify(obj[key]) !== JSON.stringify(prevObj[key])) {
                changes.push({
                  type: 'field_changed',
                  field: key,
                  from: prevObj[key],
                  to: obj[key],
                  message: \`Field '\${key}' changed from '\${JSON.stringify(prevObj[key])}' to '\${JSON.stringify(obj[key])}'\`
                });
              }
            }
          } else {
            changes.push({ type: 'entered_scope', message: 'Item entered filter scope' });
          }
        } else if (type === 'invalidate') {
          changes.push({ type: 'invalidated', message: data.reason || 'Subscription invalidated - client should refetch' });
        }
        return changes.length > 0 ? changes : [{ type: 'unknown', message: 'Event received' }];
      };

      const connect = () => {
        if (esRef.current) esRef.current.close();
        const url = filter ? \`\${selected}/subscribe?filter=\${encodeURIComponent(filter)}\` : \`\${selected}/subscribe\`;
        const es = new EventSource(url);
        esRef.current = es;
        setIsConnected(true);
        setEvents([]);
        prevDataRef.current = {};
        es.onmessage = (e) => {
          updateLastUpdated();
          try {
            const data = JSON.parse(e.data);
            const type = data.type || 'message';
            const changes = analyzeChanges(type, data, prevDataRef.current);

            if (data.object) {
              prevDataRef.current[data.object.id] = { ...data.object };
            }
            if (type === 'existing' && data.object) {
              prevDataRef.current[data.object.id] = { ...data.object };
            }

            setEvents(prev => [{ type, data, time: new Date().toISOString(), changes }, ...prev].slice(0, 100));
          } catch {
            setEvents(prev => [{ type: 'raw', data: e.data, time: new Date().toISOString(), changes: [{ type: 'raw', message: 'Raw message received' }] }, ...prev].slice(0, 100));
          }
        };
        es.onerror = () => setIsConnected(false);
      };

      const disconnect = () => {
        if (esRef.current) { esRef.current.close(); esRef.current = null; }
        setIsConnected(false);
      };

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Subscription Monitor</h1>
            <p className="page-desc">Connect to SSE endpoints and monitor real-time events</p>
          </div>

          <div className="card" style={{marginBottom: 16}}>
            <div className="card-body">
              <div style={{display: 'flex', gap: 8, alignItems: 'flex-end'}}>
                <div style={{flex: 1}}>
                  <label className="input-label">Resource</label>
                  <select className="input select" value={selected} onChange={e => setSelected(e.target.value)} disabled={isConnected}>
                    <option value="">Select resource...</option>
                    {resources.filter(r => r.capabilities?.enableSubscriptions !== false).map((r, i) => (
                      <option key={i} value={r.path}>{r.path}</option>
                    ))}
                  </select>
                </div>
                <div style={{flex: 1}}>
                  <label className="input-label">Filter (optional)</label>
                  <input className="input input-mono" value={filter} onChange={e => setFilter(e.target.value)} placeholder='status=="active"' disabled={isConnected} />
                </div>
                {!isConnected ? (
                  <button className="btn btn-primary" onClick={connect} disabled={!selected}>Connect</button>
                ) : (
                  <button className="btn btn-secondary" onClick={disconnect}>Disconnect</button>
                )}
              </div>
              {isConnected && (
                <div style={{marginTop: 12, display: 'flex', alignItems: 'center', gap: 8}}>
                  <span className="badge badge-success">Connected</span>
                  <span style={{fontSize: 12, color: 'var(--text-2)'}}>{events.length} events received</span>
                </div>
              )}
            </div>
          </div>

          <div style={{display: 'grid', gridTemplateColumns: selectedEvent ? '1fr 350px' : '1fr', gap: 16}}>
            <div className="card">
              <div className="card-header">
                <span className="card-title">Events</span>
                {events.length > 0 && <button className="btn btn-ghost btn-sm" onClick={() => setEvents([])}>Clear</button>}
              </div>
              <div className="event-stream">
                {events.length === 0 ? (
                  <div className="empty-state" style={{padding: 32}}>
                    <div className="empty-title">{isConnected ? 'Waiting for events...' : 'Connect to start'}</div>
                  </div>
                ) : (
                  events.map((e, i) => (
                    <div key={i} className={\`event-item \${selectedEvent === i ? 'selected' : ''}\`} onClick={() => setSelectedEvent(selectedEvent === i ? null : i)} style={{cursor: 'pointer'}}>
                      <div className="event-header">
                        <span className={\`badge \${e.type === 'added' ? 'badge-success' : e.type === 'removed' ? 'badge-error' : e.type === 'changed' ? 'badge-warning' : 'badge-info'}\`}>{e.type}</span>
                        <span className="event-time">{e.time}</span>
                      </div>
                      <div style={{fontSize: 12, color: 'var(--text-2)', marginTop: 4}}>
                        {e.changes?.[0]?.message || 'Click for details'}
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>

            {selectedEvent !== null && events[selectedEvent] && (
              <div className="card">
                <div className="card-header">
                  <span className="card-title">Why Did This Update?</span>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSelectedEvent(null)}>\\u2715</button>
                </div>
                <div className="card-body">
                  <div style={{marginBottom: 16}}>
                    <div style={{fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8}}>EVENT TYPE</div>
                    <span className={\`badge \${events[selectedEvent].type === 'added' ? 'badge-success' : events[selectedEvent].type === 'removed' ? 'badge-error' : events[selectedEvent].type === 'changed' ? 'badge-warning' : 'badge-info'}\`}>
                      {events[selectedEvent].type}
                    </span>
                  </div>

                  <div style={{marginBottom: 16}}>
                    <div style={{fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8}}>CHANGES</div>
                    {events[selectedEvent].changes?.map((c, ci) => (
                      <div key={ci} style={{padding: '8px 12px', background: 'var(--bg-2)', borderRadius: 'var(--radius)', marginBottom: 8}}>
                        <div style={{fontWeight: 500, marginBottom: 4}}>{c.message}</div>
                        {c.field && (
                          <div style={{fontSize: 12, color: 'var(--text-2)'}}>
                            Field: <code style={{background: 'var(--code-bg)', padding: '2px 4px', borderRadius: 2}}>{c.field}</code>
                          </div>
                        )}
                        {c.from !== undefined && (
                          <div style={{fontSize: 12, marginTop: 4}}>
                            <span style={{color: 'var(--error)'}}>- {JSON.stringify(c.from)}</span>
                          </div>
                        )}
                        {c.to !== undefined && (
                          <div style={{fontSize: 12}}>
                            <span style={{color: 'var(--success)'}}>+ {JSON.stringify(c.to)}</span>
                          </div>
                        )}
                      </div>
                    ))}
                  </div>

                  <div>
                    <div style={{fontSize: 12, fontWeight: 600, color: 'var(--text-2)', marginBottom: 8}}>RAW DATA</div>
                    <div className="event-data">{formatJSON(events[selectedEvent].data)}</div>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      );
    }

    // Changelog Page
    function ChangelogPage() {
      const [data, setData] = useState({ entries: [], currentSeq: 0, enabled: false });
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        const load = () => fetch(API + '/api/changelog').then(r => r.json()).then(d => {
          setData(d);
          updateLastUpdated();
        }).catch(() => {});
        load();
        const interval = setInterval(load, 5000);
        return () => clearInterval(interval);
      }, [updateLastUpdated]);

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Changelog</h1>
            <p className="page-desc">Database mutation changelog for subscription replay</p>
          </div>

          <div className="stats-grid" style={{marginBottom: 16}}>
            <div className="stat-card">
              <div className="stat-value">{data.currentSeq}</div>
              <div className="stat-label">Current Sequence</div>
            </div>
            <div className="stat-card">
              <div className="stat-value">{data.entries?.length || 0}</div>
              <div className="stat-label">Entries Shown</div>
            </div>
          </div>

          {!data.enabled ? (
            <div className="card">
              <div className="empty-state">
                <div className="empty-title">Changelog not configured</div>
                <div className="empty-desc">Pass changelog config to createAdminUI()</div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="card-body-flush">
                <table className="table table-mono">
                  <thead>
                    <tr><th>Seq</th><th>Type</th><th>Resource</th><th>ID</th><th>Time</th></tr>
                  </thead>
                  <tbody>
                    {(data.entries || []).map((e, i) => (
                      <tr key={i}>
                        <td>{e.seq}</td>
                        <td><span className={\`badge \${e.type === 'create' ? 'badge-success' : e.type === 'delete' ? 'badge-error' : 'badge-warning'}\`}>{e.type}</span></td>
                        <td>{e.resource}</td>
                        <td>{e.entityId}</td>
                        <td>{formatTime(e.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      );
    }

    // API Explorer Page
    function ExplorerPage() {
      const [resources, setResources] = useState([]);
      const [selected, setSelected] = useState('');
      const [method, setMethod] = useState('GET');
      const [path, setPath] = useState('');
      const [body, setBody] = useState('');
      const [response, setResponse] = useState(null);
      const [loading, setLoading] = useState(false);
      const { updateLastUpdated } = useConnection();

      useEffect(() => {
        fetch(API + '/api/resources').then(r => r.json()).then(d => {
          setResources(d.resources || []);
          updateLastUpdated();
        }).catch(() => {});
      }, [updateLastUpdated]);

      useEffect(() => {
        if (selected) setPath(selected);
      }, [selected]);

      const execute = async () => {
        setLoading(true);
        try {
          const opts = { method, headers: { 'Content-Type': 'application/json' } };
          if (body && method !== 'GET') opts.body = body;
          const start = Date.now();
          const res = await fetch(path, opts);
          const duration = Date.now() - start;
          const data = await res.json().catch(() => ({}));
          setResponse({ status: res.status, duration, data });
          updateLastUpdated();
        } catch (e) {
          setResponse({ status: 0, error: e.message });
        }
        setLoading(false);
      };

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">API Explorer</h1>
            <p className="page-desc">Test API endpoints interactively</p>
          </div>

          <div className="card" style={{marginBottom: 16}}>
            <div className="card-body">
              <div style={{display: 'flex', gap: 8, marginBottom: 12}}>
                <select className="input select" style={{width: 100}} value={method} onChange={e => setMethod(e.target.value)}>
                  <option>GET</option>
                  <option>POST</option>
                  <option>PATCH</option>
                  <option>PUT</option>
                  <option>DELETE</option>
                </select>
                <select className="input select" style={{width: 180}} value={selected} onChange={e => setSelected(e.target.value)}>
                  <option value="">Select resource...</option>
                  {resources.map((r, i) => <option key={i} value={r.path}>{r.path}</option>)}
                </select>
                <input className="input input-mono" style={{flex: 1}} value={path} onChange={e => setPath(e.target.value)} placeholder="/users?limit=10" />
                <button className="btn btn-primary" onClick={execute} disabled={loading || !path}>
                  {loading ? 'Loading...' : 'Send'}
                </button>
              </div>

              {method !== 'GET' && (
                <div>
                  <label className="input-label">Request Body (JSON)</label>
                  <textarea
                    className="input input-mono"
                    style={{minHeight: 100, resize: 'vertical'}}
                    value={body}
                    onChange={e => setBody(e.target.value)}
                    placeholder='{"name": "Test"}'
                  />
                </div>
              )}
            </div>
          </div>

          {response && (
            <div className="card">
              <div className="card-header">
                <span className="card-title">Response</span>
                <div style={{display: 'flex', gap: 8}}>
                  <span className={\`badge \${response.status < 400 ? 'badge-success' : 'badge-error'}\`}>{response.status}</span>
                  {response.duration && <span className="badge badge-neutral">{response.duration}ms</span>}
                </div>
              </div>
              <div className="card-body">
                <div className="code" style={{maxHeight: 400, overflow: 'auto'}}>
                  {response.error || formatJSON(response.data)}
                </div>
              </div>
            </div>
          )}
        </div>
      );
    }

    // Docs Page
    function DocsPage() {
      const [doc, setDoc] = useState(null);
      const errorTypes = [
        { type: 'not-found', title: 'Not Found' },
        { type: 'validation-error', title: 'Validation Error' },
        { type: 'unauthorized', title: 'Unauthorized' },
        { type: 'forbidden', title: 'Forbidden' },
        { type: 'rate-limit-exceeded', title: 'Rate Limit' },
        { type: 'batch-limit-exceeded', title: 'Batch Limit' },
        { type: 'filter-parse-error', title: 'Filter Parse Error' },
        { type: 'conflict', title: 'Conflict' },
        { type: 'precondition-failed', title: 'Precondition Failed' },
        { type: 'cursor-invalid', title: 'Invalid Cursor' },
        { type: 'cursor-expired', title: 'Cursor Expired' },
        { type: 'idempotency-mismatch', title: 'Idempotency Mismatch' },
        { type: 'unsupported-version', title: 'Unsupported Version' },
        { type: 'internal-error', title: 'Internal Error' },
        { type: 'unknown-error', title: 'Unknown Error' },
      ];

      const loadDoc = async (type) => {
        const res = await fetch(\`\${API}/problems/\${type}\`);
        const data = await res.json();
        setDoc({ type, ...data });
      };

      return (
        <div>
          <div className="page-header">
            <h1 className="page-title">Error Documentation</h1>
            <p className="page-desc">Reference for API error types and solutions</p>
          </div>

          <div className="split-pane">
            <div className="card">
              <div className="card-header">
                <span className="card-title">Error Types</span>
              </div>
              <div className="card-body-flush">
                {errorTypes.map((e, i) => (
                  <div
                    key={i}
                    className="list-item"
                    style={{cursor: 'pointer', background: doc?.type === e.type ? 'var(--accent-light)' : undefined}}
                    onClick={() => loadDoc(e.type)}
                  >
                    <span className="code-inline">{e.type}</span>
                    <span style={{color: 'var(--text-2)'}}>{e.title}</span>
                  </div>
                ))}
              </div>
            </div>

            <div className="card">
              {doc ? (
                <>
                  <div className="card-header">
                    <span className="card-title">{doc.title}</span>
                  </div>
                  <div className="card-body">
                    <p style={{marginBottom: 16, color: 'var(--text-1)'}}>{doc.description}</p>
                    <div className="section-title">Solutions</div>
                    <ul style={{paddingLeft: 20}}>
                      {doc.solutions?.map((s, i) => (
                        <li key={i} style={{marginBottom: 4, color: 'var(--text-1)'}}>{s}</li>
                      ))}
                    </ul>
                  </div>
                </>
              ) : (
                <div className="empty-state">
                  <div className="empty-title">Select an error type</div>
                  <div className="empty-desc">Click on an error type to see documentation</div>
                </div>
              )}
            </div>
          </div>
        </div>
      );
    }

    // Render
    ReactDOM.createRoot(document.getElementById('root')).render(<App />);
  </script>
</body>
</html>`;

export default createAdminUI;
