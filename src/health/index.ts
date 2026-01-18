import { Router, Request, Response } from "express";
import {
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
  runLivenessChecks,
  runReadinessChecks,
} from "./checks";

export interface HealthConfig {
  enabled?: boolean;
  basePath?: string;
  version?: string;
  checks?: {
    kv?: HealthChecks["kv"];
    changelog?: HealthChecks["changelog"];
    tasks?: HealthChecks["tasks"];
    dlq?: HealthChecks["dlq"];
    custom?: HealthChecks["custom"];
  };
  thresholds?: HealthThresholds;
}

export interface HealthResponse {
  status: "healthy" | "unhealthy";
  version?: string;
  timestamp: string;
  uptime: number;
  checks?: HealthCheckResult[];
}

const startTime = Date.now();

const buildResponse = (
  checks: HealthCheckResult[],
  version?: string
): HealthResponse => {
  const allHealthy = checks.every((c) => c.healthy);

  return {
    status: allHealthy ? "healthy" : "unhealthy",
    version,
    timestamp: new Date().toISOString(),
    uptime: Date.now() - startTime,
    checks: checks.length > 0 ? checks : undefined,
  };
};

export const createHealthEndpoints = (config: HealthConfig = {}): Router => {
  const router = Router();
  const basePath = config.basePath || "";

  if (config.enabled === false) {
    return router;
  }

  router.get(`${basePath}/healthz`, async (_req: Request, res: Response) => {
    try {
      const checks = await runLivenessChecks(config.thresholds);
      const response = buildResponse(checks, config.version);

      if (response.status === "healthy") {
        res.status(200).json(response);
      } else {
        res.status(503).json(response);
      }
    } catch (error) {
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: Date.now() - startTime,
        checks: [
          {
            healthy: false,
            name: "liveness",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        ],
      });
    }
  });

  router.get(`${basePath}/readyz`, async (_req: Request, res: Response) => {
    try {
      const checksConfig: HealthChecks = {
        kv: config.checks?.kv,
        changelog: config.checks?.changelog,
        tasks: config.checks?.tasks,
        dlq: config.checks?.dlq,
        custom: config.checks?.custom,
      };

      const checks = await runReadinessChecks(checksConfig, config.thresholds);
      const response = buildResponse(checks, config.version);

      if (response.status === "healthy") {
        res.status(200).json(response);
      } else {
        res.status(503).json(response);
      }
    } catch (error) {
      res.status(503).json({
        status: "unhealthy",
        timestamp: new Date().toISOString(),
        uptime: Date.now() - startTime,
        checks: [
          {
            healthy: false,
            name: "readiness",
            message: error instanceof Error ? error.message : "Unknown error",
          },
        ],
      });
    }
  });

  router.head(`${basePath}/healthz`, async (_req: Request, res: Response) => {
    try {
      const checks = await runLivenessChecks(config.thresholds);
      const allHealthy = checks.every((c) => c.healthy);
      res.status(allHealthy ? 200 : 503).end();
    } catch {
      res.status(503).end();
    }
  });

  router.head(`${basePath}/readyz`, async (_req: Request, res: Response) => {
    try {
      const checksConfig: HealthChecks = {
        kv: config.checks?.kv,
        changelog: config.checks?.changelog,
        tasks: config.checks?.tasks,
        dlq: config.checks?.dlq,
        custom: config.checks?.custom,
      };

      const checks = await runReadinessChecks(checksConfig, config.thresholds);
      const allHealthy = checks.every((c) => c.healthy);
      res.status(allHealthy ? 200 : 503).end();
    } catch {
      res.status(503).end();
    }
  });

  return router;
};

export type {
  HealthCheckResult,
  HealthChecks,
  HealthThresholds,
} from "./checks";
export {
  runLivenessChecks,
  runReadinessChecks,
  checkEventLoop,
  checkMemory,
  checkKV,
  checkChangelog,
  checkTasks,
  checkDLQ,
} from "./checks";
