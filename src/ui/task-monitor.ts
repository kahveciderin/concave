import { Router, Request, Response } from "express";
import { TaskScheduler, TaskRegistry, TaskWorker } from "@/tasks";
import { DeadLetterQueue } from "@/tasks/dlq";
import { logAdminAction, getAdminUser, requireAdminUser } from "./admin-auth";

export interface TaskMonitorConfig {
  enabled?: boolean;
  scheduler?: TaskScheduler;
  registry?: TaskRegistry;
  dlq?: DeadLetterQueue;
  workers?: TaskWorker[];
}

export const createTaskMonitorRoutes = (config: TaskMonitorConfig = {}): Router => {
  const router = Router();

  if (!config.enabled) {
    router.use((_req: Request, res: Response) => {
      res.json({ enabled: false });
    });
    return router;
  }

  router.get("/queue", async (req: Request, res: Response) => {
    if (!config.scheduler) {
      res.json({ enabled: false, queueDepth: 0 });
      return;
    }

    const adminUser = getAdminUser(req);

    try {
      const queueDepth = await config.scheduler.getQueueDepth();

      const pendingTasks = await config.scheduler.getTasks({
        status: "pending",
        limit: 50,
      });

      const scheduledTasks = await config.scheduler.getTasks({
        status: "scheduled",
        limit: 50,
      });

      const runningTasks = await config.scheduler.getTasks({
        status: "running",
        limit: 50,
      });

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "task_monitor_view_queue",
          reason: "Admin view task queue",
        });
      }

      res.json({
        enabled: true,
        queueDepth,
        pending: pendingTasks,
        scheduled: scheduledTasks,
        running: runningTasks,
      });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch queue",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/task/:id", async (req: Request, res: Response) => {
    if (!config.scheduler) {
      res.json({ enabled: false });
      return;
    }

    const id = req.params.id as string;

    try {
      const task = await config.scheduler.getTask(id);
      if (!task) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "Task not found",
          status: 404,
        });
        return;
      }

      res.json({ task });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch task",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.post("/task/:id/cancel", async (req: Request, res: Response) => {
    if (!config.scheduler) {
      res.json({ enabled: false });
      return;
    }

    const adminUser = requireAdminUser(req, res);
    if (!adminUser) return;

    const id = req.params.id as string;

    try {
      const cancelled = await config.scheduler.cancel(id);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_cancel",
        resourceId: id,
        reason: "Admin cancelled task",
        details: { success: cancelled },
      });

      res.json({ cancelled });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to cancel task",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/dlq", async (req: Request, res: Response) => {
    if (!config.dlq) {
      res.json({ enabled: false, entries: [] });
      return;
    }

    const adminUser = getAdminUser(req);
    const limit = parseInt((req.query.limit as string) ?? "50", 10);
    const offset = parseInt((req.query.offset as string) ?? "0", 10);

    try {
      const entries = await config.dlq.list(limit, offset);
      const total = await config.dlq.count();

      if (adminUser) {
        logAdminAction({
          userId: adminUser.id,
          userEmail: adminUser.email,
          operation: "task_monitor_view_dlq",
          reason: "Admin view dead letter queue",
        });
      }

      res.json({ enabled: true, entries, total });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch DLQ",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/dlq/:id", async (req: Request, res: Response) => {
    if (!config.dlq) {
      res.json({ enabled: false });
      return;
    }

    const id = req.params.id as string;

    try {
      const entry = await config.dlq.get(id);
      if (!entry) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "DLQ entry not found",
          status: 404,
        });
        return;
      }

      res.json({ entry });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch DLQ entry",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.post("/dlq/:id/retry", async (req: Request, res: Response) => {
    if (!config.dlq) {
      res.json({ enabled: false });
      return;
    }

    const adminUser = requireAdminUser(req, res);
    if (!adminUser) return;

    const id = req.params.id as string;

    try {
      const newTaskId = await config.dlq.retry(id);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_dlq_retry",
        resourceId: id,
        reason: "Admin retried DLQ task",
        details: { newTaskId },
      });

      res.json({ success: !!newTaskId, newTaskId });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to retry task",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.delete("/dlq/:id", async (req: Request, res: Response) => {
    if (!config.dlq) {
      res.json({ enabled: false });
      return;
    }

    const adminUser = requireAdminUser(req, res);
    if (!adminUser) return;

    const id = req.params.id as string;

    try {
      const entry = await config.dlq.get(id);
      if (!entry) {
        res.status(404).json({
          type: "/__concave/problems/not-found",
          title: "DLQ entry not found",
          status: 404,
        });
        return;
      }

      await config.dlq.purge(Date.now() - entry.failedAt + 1000);

      logAdminAction({
        userId: adminUser.id,
        userEmail: adminUser.email,
        operation: "task_dlq_purge",
        resourceId: id,
        reason: "Admin purged DLQ entry",
      });

      res.status(204).send();
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to purge DLQ entry",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/workers", (_req: Request, res: Response) => {
    if (!config.workers || config.workers.length === 0) {
      res.json({ enabled: false, workers: [] });
      return;
    }

    try {
      const workers = config.workers.map((w) => w.getStats());
      res.json({ enabled: true, workers });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch workers",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  router.get("/definitions", (_req: Request, res: Response) => {
    if (!config.registry) {
      res.json({ enabled: false, definitions: [] });
      return;
    }

    try {
      const definitions = config.registry.getAll().map((d) => ({
        name: d.name,
        hasInput: !!d.input,
        hasOutput: !!d.output,
        priority: d.priority,
        timeout: d.timeout,
        maxConcurrency: d.maxConcurrency,
        retry: d.retry,
      }));

      res.json({ enabled: true, definitions });
    } catch (error) {
      res.status(500).json({
        type: "/__concave/problems/internal-error",
        title: "Failed to fetch definitions",
        status: 500,
        detail: error instanceof Error ? error.message : "Unknown error",
      });
    }
  });

  return router;
};
