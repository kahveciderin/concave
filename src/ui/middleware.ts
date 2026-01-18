import { Router, Request, Response } from "express";
import { eq, and, count, getTableColumns } from "drizzle-orm";
import { getResourceSchema, getSchemaInfo, getAllResourcesForDisplay } from "./schema-registry";
import { createResourceFilter } from "@/resource/filter";
import { createPagination, decodeCursorLegacy, parseOrderBy } from "@/resource/pagination";
import {
  createAdminAuthMiddleware,
  AdminSecurityConfig,
  AdminUser,
  getAdminAuditLog,
  getAdminUser,
  detectEnvironment,
  EnvironmentMode,
} from "./admin-auth";
import { createDataExplorerRoutes, DataExplorerConfig } from "./data-explorer";
import { createTaskMonitorRoutes, TaskMonitorConfig } from "./task-monitor";
import { createKVInspectorRoutes, KVInspectorConfig } from "./kv-inspector";
import { layout } from "./html/layout";
import * as pages from "./html/pages";
import { html, escapeHtml, formatRelativeTime, formatDuration, formatJson } from "./html/utils";
import { badge, emptyState, card } from "./html/components";

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
  security?: AdminSecurityConfig;
  dataExplorer?: DataExplorerConfig;
  taskMonitor?: TaskMonitorConfig;
  kvInspector?: KVInspectorConfig;
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
  const mode = config.security?.mode ?? detectEnvironment();

  // Admin auth middleware for protected routes
  const adminAuth = createAdminAuthMiddleware(config.security ?? {});

  // Mount sub-routers for new features
  if (config.dataExplorer?.enabled !== false) {
    const dataExplorerRouter = createDataExplorerRoutes(
      config.dataExplorer ?? {},
      config.security ?? {}
    );
    router.use("/api/explorer", adminAuth, dataExplorerRouter);
  }

  if (config.taskMonitor?.enabled) {
    const taskMonitorRouter = createTaskMonitorRoutes(config.taskMonitor);
    router.use("/api/tasks", adminAuth, taskMonitorRouter);
  }

  if (config.kvInspector?.enabled) {
    const kvInspectorRouter = createKVInspectorRoutes(
      config.kvInspector,
      config.security ?? {}
    );
    router.use("/api/kv", adminAuth, kvInspectorRouter);
  }

  // Admin audit log endpoint
  router.get("/api/admin-audit", adminAuth, (req: Request, res: Response) => {
    const limit = parseInt(String(req.query.limit)) || 100;
    const offset = parseInt(String(req.query.offset)) || 0;
    const entries = getAdminAuditLog(limit, offset);
    res.json({ entries, mode });
  });

  // Admin audit export endpoint
  router.get("/api/admin-audit/export", adminAuth, (req: Request, res: Response) => {
    const format = req.query.format || 'json';
    const entries = getAdminAuditLog(1000, 0);

    if (format === 'csv') {
      const headers = ['timestamp', 'userId', 'userEmail', 'operation', 'resource', 'resourceId', 'reason'];
      const csvRows = [headers.join(',')];
      for (const entry of entries) {
        const row = headers.map(h => {
          const val = (entry as any)[h];
          if (val === undefined || val === null) return '';
          const str = String(val);
          return str.includes(',') || str.includes('"') ? `"${str.replace(/"/g, '""')}"` : str;
        });
        csvRows.push(row.join(','));
      }
      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.csv"');
      res.send(csvRows.join('\n'));
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', 'attachment; filename="audit-log.json"');
      res.json(entries);
    }
  });

  // Environment info endpoint
  router.get("/api/environment", (_req: Request, res: Response) => {
    const dataExplorerEnabled = config.dataExplorer?.enabled !== false;
    const dataExplorerReadOnly =
      config.dataExplorer?.readOnly ?? (mode === "production" ? true : false);

    res.json({
      mode,
      version: process.env.npm_package_version ?? "unknown",
      features: {
        dataExplorer: dataExplorerEnabled,
        dataExplorerReadOnly,
        taskMonitor: config.taskMonitor?.enabled ?? false,
        kvInspector: config.kvInspector?.enabled ?? false,
        authRequired: config.security?.auth?.disabled !== true,
      },
    });
  });

  // API endpoints
  router.get("/api/resources", (_req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay();
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

  // Helper to get layout props
  const getLayoutProps = (activePage: string) => ({
    title,
    mode,
    activePage,
  });

  // Helper to check if this is an HTMX request
  const isHtmxRequest = (req: Request) => req.headers['hx-request'] === 'true';

  // Helper to send HTML response (full page or fragment for HTMX)
  const sendHtml = (req: Request, res: Response, activePage: string, content: string) => {
    res.setHeader("Content-Type", "text/html");
    if (isHtmxRequest(req)) {
      res.send(content);
    } else {
      res.send(layout(getLayoutProps(activePage), content));
    }
  };

  // ============================================
  // HTMX UI Routes - Full Page Renders
  // ============================================

  // Dashboard
  router.get("/ui", async (req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay();
    const recentRequests = requestLogs.slice(0, 10).map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
    }));

    let currentSeq = 0;
    let changelogCount = 0;
    if (config.changelog) {
      try {
        currentSeq = await config.changelog.getCurrentSequence();
        changelogCount = currentSeq;
      } catch {}
    }

    const subscriptions = config.getActiveSubscriptions?.() || [];

    const content = pages.dashboardPage({
      stats: {
        resources: resources.length,
        requests: requestLogs.length,
        errors: errorLogs.length,
        subscriptions: subscriptions.length,
        changelog: changelogCount,
      },
      recentRequests,
      mode,
    });

    sendHtml(req, res, 'dashboard', content);
  });

  router.get("/ui/dashboard", async (req: Request, res: Response) => {
    // Redirect to main UI
    res.redirect(`${basePath}/ui`);
  });

  // Resources
  router.get("/ui/resources", (req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay();
    const content = pages.resourcesPage({ resources });
    sendHtml(req, res, 'resources', content);
  });

  // Data Explorer
  router.get("/ui/data-explorer", (req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    const content = pages.dataExplorerPage({
      resources,
      readOnly,
      mode,
    });

    sendHtml(req, res, 'data-explorer', content);
  });

  // Requests
  router.get("/ui/requests", (req: Request, res: Response) => {
    const requests = requestLogs.slice(0, 200).map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
      error: r.error,
    }));

    const content = pages.requestsPage({ requests });
    sendHtml(req, res, 'requests', content);
  });

  // Errors
  router.get("/ui/errors", (req: Request, res: Response) => {
    const errors = errorLogs.slice(0, 100).map(e => ({
      id: e.id,
      status: e.statusCode,
      path: e.path,
      message: e.error,
      stack: e.stack,
      timestamp: new Date(e.timestamp).toISOString(),
    }));

    const content = pages.errorsPage({ errors });
    sendHtml(req, res, 'errors', content);
  });

  // Users
  router.get("/ui/users", async (req: Request, res: Response) => {
    let users: any[] = [];
    let totalCount = 0;

    if (config.userManager) {
      try {
        const result = await config.userManager.listUsers(50, 0);
        users = result.users;
        totalCount = result.total;
      } catch {}
    }

    const content = pages.usersPage({ users, totalCount });
    sendHtml(req, res, 'users', content);
  });

  // Sessions
  router.get("/ui/sessions", async (req: Request, res: Response) => {
    let sessions: any[] = [];

    if (config.sessionManager) {
      try {
        sessions = await config.sessionManager.listSessions(100);
      } catch {}
    }

    const content = pages.sessionsPage({
      sessions,
      totalCount: sessions.length,
    });

    sendHtml(req, res, 'sessions', content);
  });

  // Subscriptions
  router.get("/ui/subscriptions", (req: Request, res: Response) => {
    const subscriptions = config.getActiveSubscriptions?.() || [];

    const byResource: Record<string, number> = {};
    for (const sub of subscriptions) {
      byResource[sub.resource] = (byResource[sub.resource] || 0) + 1;
    }

    const content = pages.subscriptionsPage({
      subscriptions,
      stats: {
        active: subscriptions.length,
        totalEvents: subscriptions.reduce((sum: number, s: any) => sum + (s.eventCount || 0), 0),
        byResource,
      },
    });

    sendHtml(req, res, 'subscriptions', content);
  });

  // Changelog
  router.get("/ui/changelog", async (req: Request, res: Response) => {
    let entries: any[] = [];
    let stats = { total: 0, creates: 0, updates: 0, deletes: 0, currentSeq: 0 };

    if (config.changelog) {
      try {
        stats.currentSeq = await config.changelog.getCurrentSequence();
        entries = await config.changelog.getEntries(Math.max(0, stats.currentSeq - 100), 100);
        stats.total = entries.length;
        for (const e of entries) {
          if (e.operation === 'create') stats.creates++;
          else if (e.operation === 'update') stats.updates++;
          else if (e.operation === 'delete') stats.deletes++;
        }
      } catch {}
    }

    const content = pages.changelogPage({ entries, stats });
    sendHtml(req, res, 'changelog', content);
  });

  // Tasks
  router.get("/ui/tasks", async (req: Request, res: Response) => {
    const content = pages.tasksPage({
      stats: { pending: 0, scheduled: 0, running: 0, completed: 0, failed: 0, dlq: 0 },
      scheduled: [],
      dlq: [],
      workers: [],
    });

    sendHtml(req, res, 'tasks', content);
  });

  // KV Inspector
  router.get("/ui/kv-inspector", (req: Request, res: Response) => {
    const enabled = config.kvInspector?.enabled ?? false;
    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    const content = pages.kvInspectorPage({ enabled, readOnly, mode });
    sendHtml(req, res, 'kv-inspector', content);
  });

  // Admin Audit
  router.get("/ui/admin-audit", (req: Request, res: Response) => {
    const entries = getAdminAuditLog(100, 0);

    const content = pages.adminAuditPage({ entries });
    sendHtml(req, res, 'admin-audit', content);
  });

  // Filter Tester
  router.get("/ui/filter-tester", (req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);

    const content = pages.filterTesterPage({ resources });
    sendHtml(req, res, 'filter-tester', content);
  });

  // API Explorer
  router.get("/ui/api-explorer", (req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay();
    const endpoints: pages.EndpointInfo[] = [];

    for (const resource of resources) {
      const caps = resource.capabilities || {};

      // GET list
      endpoints.push({
        method: 'GET',
        path: resource.name,
        description: `List ${resource.name} with filtering and pagination`,
        parameters: [
          { name: 'filter', in: 'query', type: 'string', description: 'RSQL filter expression' },
          { name: 'limit', in: 'query', type: 'number', description: 'Max results (default: 50)' },
          { name: 'cursor', in: 'query', type: 'string', description: 'Pagination cursor' },
          { name: 'orderBy', in: 'query', type: 'string', description: 'Sort field:direction' },
        ],
      });

      // GET single
      endpoints.push({
        method: 'GET',
        path: `${resource.name}/:id`,
        description: `Get a single ${resource.name} by ID`,
        parameters: [
          { name: 'id', in: 'path', type: 'string', required: true },
        ],
      });

      if (caps.enableCreate) {
        endpoints.push({
          method: 'POST',
          path: resource.name,
          description: `Create a new ${resource.name}`,
          requestBody: { contentType: 'application/json' },
        });
      }

      if (caps.enableUpdate) {
        endpoints.push({
          method: 'PATCH',
          path: `${resource.name}/:id`,
          description: `Update a ${resource.name}`,
          parameters: [{ name: 'id', in: 'path', type: 'string', required: true }],
          requestBody: { contentType: 'application/json' },
        });
      }

      if (caps.enableDelete) {
        endpoints.push({
          method: 'DELETE',
          path: `${resource.name}/:id`,
          description: `Delete a ${resource.name}`,
          parameters: [{ name: 'id', in: 'path', type: 'string', required: true }],
        });
      }
    }

    const content = pages.apiExplorerPage({ endpoints, baseUrl: '' });
    sendHtml(req, res, 'api-explorer', content);
  });

  // ============================================
  // HTMX Partial Routes - For dynamic updates
  // ============================================

  // Empty fragment (for closing modals, etc.)
  router.get("/ui/empty", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send('');
  });

  // Request list partial
  router.get("/ui/requests/list", (req: Request, res: Response) => {
    let requests = requestLogs.slice(0, 200);

    const method = req.query.method as string;
    const status = req.query.status as string;
    const path = req.query.path as string;

    if (method) {
      requests = requests.filter(r => r.method === method);
    }
    if (status === 'success') {
      requests = requests.filter(r => r.status >= 200 && r.status < 400);
    } else if (status === 'error') {
      requests = requests.filter(r => r.status >= 400);
    }
    if (path) {
      requests = requests.filter(r => r.path.includes(path));
    }

    const mapped = requests.map(r => ({
      id: r.id,
      method: r.method,
      path: r.path,
      status: r.status,
      duration: r.duration,
      timestamp: new Date(r.timestamp).toISOString(),
      error: r.error,
    }));

    res.setHeader("Content-Type", "text/html");
    res.send(pages.requestList(mapped));
  });

  // Request detail partial
  router.get("/ui/requests/:id", (req: Request, res: Response) => {
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const request = requestLogs.find(r => r.id === id);

    if (!request) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u2715', 'Request not found', 'The request may have been purged from logs'));
      return;
    }

    res.setHeader("Content-Type", "text/html");
    res.send(pages.requestDetail({
      request: {
        id: request.id,
        method: request.method,
        path: request.path,
        status: request.status,
        duration: request.duration,
        timestamp: new Date(request.timestamp).toISOString(),
        error: request.error,
        headers: request.headers,
        body: request.requestBody,
        response: request.responseBody,
      },
    }));
  });

  // Users list partial
  router.get("/ui/users/list", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.setHeader("Content-Type", "text/html");
      res.send(pages.usersList([]));
      return;
    }

    try {
      const search = req.query.search as string;
      const result = await config.userManager.listUsers(50, 0);
      let users = result.users;

      if (search) {
        const term = search.toLowerCase();
        users = users.filter((u: any) =>
          u.email?.toLowerCase().includes(term) ||
          u.name?.toLowerCase().includes(term)
        );
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.usersList(users));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // User create form partial
  router.get("/ui/users/new", (_req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/html");
    res.send(pages.userForm());
  });

  // User detail partial
  router.get("/ui/users/:id", async (req: Request, res: Response) => {
    if (!config.userManager) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u2715', 'User management not configured', ''));
      return;
    }

    try {
      const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const user = await config.userManager.getUser(id);

      if (!user) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'User not found', ''));
        return;
      }

      let sessions: any[] = [];
      if (config.sessionManager) {
        try {
          sessions = await config.sessionManager.getSessionsByUser(id);
        } catch {}
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.userDetail({ user: { ...user, sessions } }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Session create form partial
  router.get("/ui/sessions/new", async (_req: Request, res: Response) => {
    let users: { id: string; email: string }[] = [];

    if (config.userManager) {
      try {
        const result = await config.userManager.listUsers(100, 0);
        users = result.users.map((u: any) => ({ id: u.id, email: u.email }));
      } catch {}
    }

    res.setHeader("Content-Type", "text/html");
    res.send(pages.sessionForm({ users }));
  });

  // Sessions list partial
  router.get("/ui/sessions/list", async (_req: Request, res: Response) => {
    if (!config.sessionManager) {
      res.setHeader("Content-Type", "text/html");
      res.send(pages.sessionsList([]));
      return;
    }

    try {
      const sessions = await config.sessionManager.listSessions(100);
      res.setHeader("Content-Type", "text/html");
      res.send(pages.sessionsList(sessions));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Subscriptions list partial
  router.get("/ui/subscriptions/list", (_req: Request, res: Response) => {
    const subscriptions = config.getActiveSubscriptions?.() || [];
    res.setHeader("Content-Type", "text/html");
    res.send(pages.subscriptionsList(subscriptions));
  });

  // Changelog list partial
  router.get("/ui/changelog/list", async (req: Request, res: Response) => {
    if (!config.changelog) {
      res.setHeader("Content-Type", "text/html");
      res.send(pages.changelogList([]));
      return;
    }

    try {
      const resource = req.query.resource as string;
      const fromSeq = parseInt(req.query.fromSeq as string) || 0;

      const currentSeq = await config.changelog.getCurrentSequence();
      let entries = await config.changelog.getEntries(fromSeq || Math.max(0, currentSeq - 100), 100);

      if (resource) {
        entries = entries.filter((e: any) => e.resource?.includes(resource));
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.changelogList(entries));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Changelog detail partial
  router.get("/ui/changelog/:seq", async (req: Request, res: Response) => {
    if (!config.changelog) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u2715', 'Changelog not configured', ''));
      return;
    }

    try {
      const seq = parseInt(Array.isArray(req.params.seq) ? req.params.seq[0] : req.params.seq);
      const entries = await config.changelog.getEntries(seq, 1);
      const entry = entries[0];

      if (!entry) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Entry not found', ''));
        return;
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.changelogDetail({ entry }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Audit list partial
  router.get("/ui/audit/list", (req: Request, res: Response) => {
    let entries = getAdminAuditLog(100, 0);

    const operation = req.query.operation as string;
    const user = req.query.user as string;

    if (operation) {
      entries = entries.filter(e => e.operation?.includes(operation));
    }
    if (user) {
      entries = entries.filter(e =>
        e.userEmail?.toLowerCase().includes(user.toLowerCase()) ||
        e.userId?.includes(user)
      );
    }

    res.setHeader("Content-Type", "text/html");
    res.send(pages.auditList(entries));
  });

  // Audit detail partial
  router.get("/ui/audit/:index", (req: Request, res: Response) => {
    const index = parseInt(Array.isArray(req.params.index) ? req.params.index[0] : req.params.index);
    const entries = getAdminAuditLog(100, 0);
    const entry = entries[index];

    if (!entry) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u2715', 'Entry not found', ''));
      return;
    }

    res.setHeader("Content-Type", "text/html");
    res.send(pages.auditDetail({ entry }));
  });

  // KV keys partial
  router.get("/ui/kv/keys", async (req: Request, res: Response) => {
    if (!config.kvInspector?.enabled) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u26C1', 'KV Inspector Disabled', ''));
      return;
    }

    const pattern = req.query.pattern as string || '*';
    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    // This would need to be implemented with actual KV access
    // For now, return empty
    res.setHeader("Content-Type", "text/html");
    res.send(pages.kvKeysList({ keys: [], readOnly }));
  });

  // KV value partial
  router.get("/ui/kv/value/:key", async (req: Request, res: Response) => {
    if (!config.kvInspector?.enabled) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u26C1', 'KV Inspector Disabled', ''));
      return;
    }

    const key = decodeURIComponent(Array.isArray(req.params.key) ? req.params.key[0] : req.params.key);
    const readOnly = config.kvInspector?.readOnly ?? (mode === "production");

    // This would need to be implemented with actual KV access
    res.setHeader("Content-Type", "text/html");
    res.send(pages.kvValueView({
      key,
      type: 'string',
      value: '',
      readOnly,
    }));
  });

  // Data explorer partials
  router.get("/ui/data/resources", (_req: Request, res: Response) => {
    const resources = getAllResourcesForDisplay().map(r => r.name);
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    res.setHeader("Content-Type", "text/html");
    res.send(pages.resourceSelector({ resources, readOnly }));
  });

  // Data table partial for a resource
  router.get("/ui/data/:resource/table", async (req: Request, res: Response) => {
    const resource = Array.isArray(req.params.resource) ? req.params.resource[0] : req.params.resource;
    const filter = req.query.filter as string || '';
    const limit = parseInt(req.query.limit as string) || 50;
    const cursor = req.query.cursor as string || '';
    const orderBy = req.query.orderBy as string || '';
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    try {
      const schemaInfo = getSchemaInfo(resource);

      if (!schemaInfo) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Resource not found', `Resource '${resource}' is not registered`));
        return;
      }

      const entry = getResourceSchema(resource);
      if (!entry) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Resource not found', ''));
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const idColumnName = entry.idColumn.name;

      const filterer = createResourceFilter(schema, {});
      const pagination = createPagination(schema, entry.idColumn, {
        defaultLimit: 20,
        maxLimit: config.dataExplorer?.maxLimit ?? 100,
      });

      const orderByFields = parseOrderBy(orderBy || idColumnName);

      let sqlFilter: any;
      if (filter) {
        sqlFilter = filterer.convert(filter);
      }

      let query = db.select().from(schema);
      if (sqlFilter) {
        query = query.where(sqlFilter);
      }

      if (cursor) {
        const cursorData = decodeCursorLegacy(cursor);
        if (cursorData) {
          const cursorCondition = pagination.buildCursorCondition(cursorData, orderByFields);
          if (cursorCondition) {
            query = query.where(sqlFilter ? and(sqlFilter, cursorCondition) : cursorCondition);
          }
        }
      }

      const orderByClauses = pagination.buildOrderBy(orderByFields);
      if (orderByClauses.length > 0) {
        query = query.orderBy(...orderByClauses);
      }

      query = query.limit(limit + 1);
      let items = await query;

      // Get total count
      const [countResult] = await db
        .select({ count: count() })
        .from(schema)
        .where(sqlFilter);
      const totalCount = countResult?.count ?? 0;

      const result = pagination.processResults(
        items as Record<string, unknown>[],
        limit,
        idColumnName,
        orderByFields,
        totalCount
      );

      res.setHeader("Content-Type", "text/html");
      res.send(pages.dataTable({
        resource,
        schema: schemaInfo,
        items: result.items,
        totalCount: result.totalCount,
        hasMore: result.hasMore,
        nextCursor: result.nextCursor ?? undefined,
        filter,
        orderBy: orderBy || undefined,
        limit,
        readOnly,
      }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Row detail partial
  router.get("/ui/data/:resource/row/:id", async (req: Request, res: Response) => {
    const resource = Array.isArray(req.params.resource) ? req.params.resource[0] : req.params.resource;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;

    try {
      const entry = getResourceSchema(resource);
      if (!entry) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Resource not found', ''));
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Record not found', ''));
        return;
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.recordDetail({ resource, item: item as Record<string, unknown> }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Edit form partial
  router.get("/ui/data/:resource/edit/:id", async (req: Request, res: Response) => {
    const resource = Array.isArray(req.params.resource) ? req.params.resource[0] : req.params.resource;
    const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    if (readOnly) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u26A0', 'Read-only mode', 'Data editing is disabled in this environment'));
      return;
    }

    try {
      const entry = getResourceSchema(resource);
      const schemaInfo = getSchemaInfo(resource);
      if (!entry || !schemaInfo) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Resource not found', ''));
        return;
      }

      const db = entry.db;
      const schema = entry.schema;
      const columns = getTableColumns(schema);
      const idColumn = columns[entry.idColumn.name];

      const [item] = await db.select().from(schema).where(eq(idColumn, id));

      if (!item) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Record not found', ''));
        return;
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.recordForm({
        resource,
        schema: schemaInfo,
        item: item as Record<string, unknown>,
        isEdit: true,
      }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // New record form partial
  router.get("/ui/data/new", (req: Request, res: Response) => {
    const resource = req.query.resource as string;
    const readOnly = config.dataExplorer?.readOnly ?? (mode === "production");

    if (readOnly) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u26A0', 'Read-only mode', 'Data editing is disabled in this environment'));
      return;
    }

    if (!resource) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u26A0', 'No resource selected', 'Select a resource first'));
      return;
    }

    try {
      const schemaInfo = getSchemaInfo(resource);

      if (!schemaInfo) {
        res.setHeader("Content-Type", "text/html");
        res.send(emptyState('\u2715', 'Resource not found', ''));
        return;
      }

      res.setHeader("Content-Type", "text/html");
      res.send(pages.recordForm({
        resource,
        schema: schemaInfo,
        isEdit: false,
      }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(html`<div class="alert alert-error">${escapeHtml(e.message)}</div>`);
    }
  });

  // Filter tester parse partial
  router.post("/ui/filter/parse", (req: Request, res: Response) => {
    const filter = req.body.filter || '';

    try {
      // Use createResourceFilter with a minimal dummy to parse the filter
      // This validates the syntax without needing a real schema
      const dummySchema = {} as any;
      const filterer = createResourceFilter(dummySchema, {});
      // compile() returns the parsed AST and throws on syntax errors
      const ast = filterer.compile(filter);

      res.setHeader("Content-Type", "text/html");
      res.send(pages.filterParseResult({ filter, ast: ast.toString() }));
    } catch (e: any) {
      res.setHeader("Content-Type", "text/html");
      res.send(pages.filterParseResult({ filter, error: e.message }));
    }
  });

  // API explorer endpoint detail partial
  router.get("/ui/api-explorer/endpoint/:index", (req: Request, res: Response) => {
    const index = parseInt(Array.isArray(req.params.index) ? req.params.index[0] : req.params.index);
    const resources = getAllResourcesForDisplay();
    const endpoints: pages.EndpointInfo[] = [];

    for (const resource of resources) {
      const caps = resource.capabilities || {};

      endpoints.push({
        method: 'GET',
        path: resource.name,
        description: `List ${resource.name} with filtering and pagination`,
        parameters: [
          { name: 'filter', in: 'query', type: 'string', description: 'RSQL filter expression' },
          { name: 'limit', in: 'query', type: 'number', description: 'Max results (default: 50)' },
          { name: 'cursor', in: 'query', type: 'string', description: 'Pagination cursor' },
          { name: 'orderBy', in: 'query', type: 'string', description: 'Sort field:direction' },
        ],
      });

      endpoints.push({
        method: 'GET',
        path: `${resource.name}/:id`,
        description: `Get a single ${resource.name} by ID`,
        parameters: [{ name: 'id', in: 'path', type: 'string', required: true }],
      });

      if (caps.enableCreate) {
        endpoints.push({
          method: 'POST',
          path: resource.name,
          description: `Create a new ${resource.name}`,
          requestBody: { contentType: 'application/json' },
        });
      }

      if (caps.enableUpdate) {
        endpoints.push({
          method: 'PATCH',
          path: `${resource.name}/:id`,
          description: `Update a ${resource.name}`,
          parameters: [{ name: 'id', in: 'path', type: 'string', required: true }],
          requestBody: { contentType: 'application/json' },
        });
      }

      if (caps.enableDelete) {
        endpoints.push({
          method: 'DELETE',
          path: `${resource.name}/:id`,
          description: `Delete a ${resource.name}`,
          parameters: [{ name: 'id', in: 'path', type: 'string', required: true }],
        });
      }
    }

    const endpoint = endpoints[index];
    if (!endpoint) {
      res.setHeader("Content-Type", "text/html");
      res.send(emptyState('\u2715', 'Endpoint not found', ''));
      return;
    }

    res.setHeader("Content-Type", "text/html");
    res.send(pages.endpointDetail({ endpoint, baseUrl: '' }));
  });

  return router;
};

export default createAdminUI;
