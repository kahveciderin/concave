import { Request, Response, NextFunction } from "express";
import { randomUUID } from "crypto";

export interface RequestMetrics {
  requestId: string;
  method: string;
  path: string;
  resource?: string;
  operation?: string;
  status: number;
  duration: number;
  timestamp: number;
  query?: Record<string, unknown>;
  error?: string;
}

export interface SubscriptionMetrics {
  subscriptionId: string;
  resource: string;
  event: "connected" | "disconnected" | "event_sent" | "backpressure" | "invalidate";
  userId?: string;
  duration?: number;
  eventCount?: number;
}

export interface ErrorMetrics {
  requestId?: string;
  method: string;
  path: string;
  status: number;
  errorCode: string;
  errorMessage: string;
  timestamp: number;
}

export interface MetricsConfig {
  onRequest?: (metrics: RequestMetrics) => void;
  onSubscription?: (metrics: SubscriptionMetrics) => void;
  onError?: (metrics: ErrorMetrics) => void;
}

export interface ObservabilityConfig {
  enableRequestId?: boolean;
  enableTiming?: boolean;
  enableSlowQueryLog?: boolean;
  slowQueryThresholdMs?: number;
  requestIdHeader?: string;
  metrics?: MetricsConfig;
  onMetrics?: (metrics: RequestMetrics) => void;
  logger?: Logger;
}

export interface Logger {
  info: (msg: string | object) => void;
  warn: (msg: string | object) => void;
  error: (msg: string | object) => void;
}

const defaultLogger: Logger = {
  info: (msg) => console.log(typeof msg === "string" ? msg : JSON.stringify(msg)),
  warn: (msg) => console.warn(typeof msg === "string" ? msg : JSON.stringify(msg)),
  error: (msg) => console.error(typeof msg === "string" ? msg : JSON.stringify(msg)),
};

const DEFAULT_CONFIG: Required<Omit<ObservabilityConfig, "onMetrics">> & { onMetrics?: (metrics: RequestMetrics) => void } = {
  enableRequestId: true,
  enableTiming: true,
  enableSlowQueryLog: true,
  slowQueryThresholdMs: 1000,
  requestIdHeader: "x-request-id",
  metrics: {},
  onMetrics: undefined,
  logger: defaultLogger,
};

export interface ObservableRequest extends Request {
  requestId?: string;
  startTime?: bigint;
  resource?: string;
  operation?: string;
}

export const observabilityMiddleware = (config: ObservabilityConfig = {}) => {
  const mergedConfig = { ...DEFAULT_CONFIG, ...config };
  const {
    enableRequestId,
    enableTiming,
    enableSlowQueryLog,
    slowQueryThresholdMs,
    requestIdHeader,
    metrics,
    onMetrics,
    logger,
  } = mergedConfig;

  return (req: Request, res: Response, next: NextFunction): void => {
    const observableReq = req as ObservableRequest;

    if (enableRequestId) {
      const requestId =
        (req.headers[requestIdHeader] as string) || randomUUID();
      observableReq.requestId = requestId;
      res.set("X-Request-Id", requestId);
    }

    let startTime: bigint | undefined;
    if (enableTiming) {
      startTime = process.hrtime.bigint();
      observableReq.startTime = startTime;
    }

    res.on("finish", () => {
      if (!enableTiming || !startTime) return;

      const duration = Number(process.hrtime.bigint() - startTime) / 1e6;

      const requestMetrics: RequestMetrics = {
        requestId: observableReq.requestId ?? "unknown",
        method: req.method,
        path: req.path,
        resource: observableReq.resource,
        operation: observableReq.operation,
        status: res.statusCode,
        duration,
        timestamp: Date.now(),
      };

      if (enableSlowQueryLog && duration > slowQueryThresholdMs) {
        logger.warn({
          level: "warn",
          message: "Slow request",
          ...requestMetrics,
        });
      }

      if (req.method !== "GET" || res.statusCode >= 400) {
        logger.info({
          level: "info",
          message: "Request completed",
          ...requestMetrics,
        });
      }

      metrics.onRequest?.(requestMetrics);
      onMetrics?.(requestMetrics);
    });

    next();
  };
};

export const requestIdMiddleware = (headerName: string = "x-request-id") => {
  return (req: Request, res: Response, next: NextFunction): void => {
    const requestId = (req.headers[headerName] as string) || randomUUID();
    (req as ObservableRequest).requestId = requestId;
    res.set("X-Request-Id", requestId);
    next();
  };
};

export const timingMiddleware = (config?: { slowQueryThresholdMs?: number }) => {
  const slowQueryThresholdMs = config?.slowQueryThresholdMs ?? 1000;

  return (req: Request, res: Response, next: NextFunction): void => {
    const startTime = process.hrtime.bigint();
    (req as ObservableRequest).startTime = startTime;

    res.on("finish", () => {
      const duration = Number(process.hrtime.bigint() - startTime) / 1e6;

      res.set("X-Response-Time", `${duration.toFixed(2)}ms`);

      if (duration > slowQueryThresholdMs) {
        console.warn(
          JSON.stringify({
            level: "warn",
            message: "Slow request",
            method: req.method,
            path: req.path,
            duration,
            status: res.statusCode,
            requestId: (req as ObservableRequest).requestId,
          })
        );
      }
    });

    next();
  };
};

export const resourceContextMiddleware = (
  resource: string,
  operation?: string
) => {
  return (req: Request, _res: Response, next: NextFunction): void => {
    (req as ObservableRequest).resource = resource;
    if (operation) {
      (req as ObservableRequest).operation = operation;
    }
    next();
  };
};

export const getRequestId = (req: Request): string | undefined => {
  return (req as ObservableRequest).requestId;
};

export const getRequestDuration = (req: Request): number => {
  const observableReq = req as ObservableRequest;
  if (!observableReq.startTime) return 0;

  return Number(process.hrtime.bigint() - observableReq.startTime) / 1e6;
};

export interface MetricsCollectorConfig {
  maxMetrics?: number;
}

export const createMetricsCollector = (config: MetricsCollectorConfig = {}) => {
  const requestMetrics: RequestMetrics[] = [];
  const subscriptionMetrics: SubscriptionMetrics[] = [];
  const errorMetrics: ErrorMetrics[] = [];

  let maxEntries = config.maxMetrics ?? 1000;

  const pruneOldEntries = <T>(arr: T[]): void => {
    if (arr.length > maxEntries) {
      arr.splice(0, arr.length - maxEntries);
    }
  };

  return {
    setMaxEntries: (max: number) => {
      maxEntries = max;
    },

    record: (metrics: RequestMetrics) => {
      requestMetrics.push(metrics);
      pruneOldEntries(requestMetrics);
    },

    onRequest: (metrics: RequestMetrics) => {
      requestMetrics.push(metrics);
      pruneOldEntries(requestMetrics);
    },

    onSubscription: (metrics: SubscriptionMetrics) => {
      subscriptionMetrics.push(metrics);
      pruneOldEntries(subscriptionMetrics);
    },

    onError: (metrics: ErrorMetrics) => {
      errorMetrics.push(metrics);
      pruneOldEntries(errorMetrics);
    },

    getRecent: (count: number): RequestMetrics[] => {
      return requestMetrics.slice(-count);
    },

    getRequestMetrics: (filter?: Partial<RequestMetrics>): RequestMetrics[] => {
      if (!filter) return [...requestMetrics];

      return requestMetrics.filter((m) => {
        for (const [key, value] of Object.entries(filter)) {
          if (m[key as keyof RequestMetrics] !== value) return false;
        }
        return true;
      });
    },

    getByPath: (path: string): RequestMetrics[] => {
      return requestMetrics.filter((m) => m.path === path);
    },

    getSlow: (thresholdMs: number): RequestMetrics[] => {
      return requestMetrics.filter((m) => m.duration > thresholdMs);
    },

    getSubscriptionMetrics: (): SubscriptionMetrics[] => {
      return [...subscriptionMetrics];
    },

    getErrorMetrics: (): ErrorMetrics[] => {
      return [...errorMetrics];
    },

    getStats: () => {
      const total = requestMetrics.length;
      const avgDuration =
        total > 0
          ? requestMetrics.reduce((sum, m) => sum + m.duration, 0) / total
          : 0;
      const errorCount = requestMetrics.filter((m) => m.status >= 400).length;
      const errorRate = total > 0 ? errorCount / total : 0;

      const now = Date.now();
      const oneMinuteAgo = now - 60000;
      const fiveMinutesAgo = now - 300000;

      const recentRequests = requestMetrics.filter(
        (m) => m.timestamp > oneMinuteAgo
      );
      const last5MinRequests = requestMetrics.filter(
        (m) => m.timestamp > fiveMinutesAgo
      );

      return {
        total,
        avgDuration,
        errorRate,
        requestsPerMinute: recentRequests.length,
        requestsLast5Minutes: last5MinRequests.length,
        activeSubscriptions: subscriptionMetrics.filter(
          (m) => m.event === "connected"
        ).length,
      };
    },

    clear: () => {
      requestMetrics.length = 0;
      subscriptionMetrics.length = 0;
      errorMetrics.length = 0;
    },
  };
};

export type MetricsCollector = ReturnType<typeof createMetricsCollector>;
