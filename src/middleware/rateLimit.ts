import { Request, Response, NextFunction } from "express";
import { RateLimitError } from "@/resource/error";
import { AuthenticatedRequest } from "@/auth/types";
import { getGlobalKV, hasGlobalKV, KVAdapter } from "../kv";

// KV key prefix
const RATE_LIMIT_PREFIX = "concave:ratelimit:";
const SLIDING_WINDOW_PREFIX = "concave:ratelimit:sliding:";

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: Request) => string;
  skip?: (req: Request) => boolean;
  message?: string;
  headers?: boolean;
  store?: RateLimitStore;
}

export interface RateLimitInfo {
  count: number;
  resetAt: number;
}

export interface RateLimitStore {
  increment(key: string, windowMs: number): Promise<RateLimitInfo>;
  decrement(key: string): Promise<void>;
  reset(key: string): Promise<void>;
}

/**
 * In-memory rate limit store for single-process deployments
 */
export class InMemoryRateLimitStore implements RateLimitStore {
  private store = new Map<string, { count: number; resetAt: number }>();
  private cleanupInterval: NodeJS.Timeout | null = null;

  constructor() {
    this.cleanupInterval = setInterval(() => this.cleanup(), 60000);
  }

  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const now = Date.now();
    const entry = this.store.get(key);

    if (!entry || entry.resetAt <= now) {
      const info = { count: 1, resetAt: now + windowMs };
      this.store.set(key, info);
      return info;
    }

    entry.count++;
    return entry;
  }

  async decrement(key: string): Promise<void> {
    const entry = this.store.get(key);
    if (entry && entry.count > 0) {
      entry.count--;
    }
  }

  async reset(key: string): Promise<void> {
    this.store.delete(key);
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [key, entry] of this.store) {
      if (entry.resetAt <= now) {
        this.store.delete(key);
      }
    }
  }

  destroy(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.store.clear();
  }
}

/**
 * KV-backed rate limit store for multi-process deployments
 * Uses the global KV adapter (Redis or memory)
 */
export class KVRateLimitStore implements RateLimitStore {
  async increment(key: string, windowMs: number): Promise<RateLimitInfo> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;

    if (!kv) {
      // Fallback to basic in-memory behavior
      return { count: 1, resetAt: Date.now() + windowMs };
    }

    const kvKey = `${RATE_LIMIT_PREFIX}${key}`;
    const now = Date.now();

    // Get current state
    const data = await kv.hgetall(kvKey);

    let count: number;
    let resetAt: number;

    if (!data.resetAt || parseInt(data.resetAt, 10) <= now) {
      // Window expired or new key, start fresh
      count = 1;
      resetAt = now + windowMs;
    } else {
      // Within window, increment
      count = (parseInt(data.count, 10) || 0) + 1;
      resetAt = parseInt(data.resetAt, 10);
    }

    // Store updated state
    await kv.hmset(kvKey, {
      count: String(count),
      resetAt: String(resetAt),
    });

    // Set expiry to auto-cleanup
    const ttl = Math.ceil((resetAt - now) / 1000) + 1;
    await kv.expire(kvKey, ttl);

    return { count, resetAt };
  }

  async decrement(key: string): Promise<void> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;
    if (!kv) return;

    const kvKey = `${RATE_LIMIT_PREFIX}${key}`;
    const data = await kv.hgetall(kvKey);

    if (data.count) {
      const newCount = Math.max(0, parseInt(data.count, 10) - 1);
      await kv.hset(kvKey, "count", String(newCount));
    }
  }

  async reset(key: string): Promise<void> {
    const kv = hasGlobalKV() ? getGlobalKV() : null;
    if (!kv) return;

    await kv.del(`${RATE_LIMIT_PREFIX}${key}`);
  }
}

const defaultKeyGenerator = (req: Request): string => {
  const authReq = req as AuthenticatedRequest;
  const userId = authReq.user?.id;
  const ip = req.ip ?? req.socket.remoteAddress ?? "unknown";

  if (userId) {
    return `user:${userId}`;
  }
  return `ip:${ip}`;
};

// Default store - uses KV if available, otherwise in-memory
let defaultStore: RateLimitStore | null = null;

const getDefaultStore = (): RateLimitStore => {
  if (!defaultStore) {
    if (hasGlobalKV()) {
      defaultStore = new KVRateLimitStore();
    } else {
      defaultStore = new InMemoryRateLimitStore();
    }
  }
  return defaultStore;
};

export const createRateLimiter = (config: RateLimitConfig) => {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    message = "Too many requests, please try again later",
    headers = true,
    store,
  } = config;

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (skip?.(req)) {
        return next();
      }

      const key = keyGenerator(req);
      const actualStore = store ?? getDefaultStore();
      const info = await actualStore.increment(key, windowMs);

      if (headers) {
        res.setHeader("X-RateLimit-Limit", maxRequests);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - info.count));
        res.setHeader("X-RateLimit-Reset", Math.ceil(info.resetAt / 1000));
      }

      if (info.count > maxRequests) {
        const retryAfter = Math.ceil((info.resetAt - Date.now()) / 1000);

        if (headers) {
          res.setHeader("Retry-After", retryAfter);
        }

        throw new RateLimitError(retryAfter);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

/**
 * Sliding window rate limiter using sorted sets in KV
 * More accurate than fixed window but more expensive
 */
export const createSlidingWindowRateLimiter = (config: RateLimitConfig) => {
  const {
    windowMs,
    maxRequests,
    keyGenerator = defaultKeyGenerator,
    skip,
    headers = true,
  } = config;

  // In-memory fallback
  const localRequests = new Map<string, number[]>();

  const cleanupLocal = (key: string, now: number): number[] => {
    const timestamps = localRequests.get(key) ?? [];
    const cutoff = now - windowMs;
    const valid = timestamps.filter((t) => t > cutoff);
    if (valid.length === 0) {
      localRequests.delete(key);
    } else {
      localRequests.set(key, valid);
    }
    return valid;
  };

  return async (
    req: Request,
    res: Response,
    next: NextFunction
  ): Promise<void> => {
    try {
      if (skip?.(req)) {
        return next();
      }

      const key = keyGenerator(req);
      const now = Date.now();
      const cutoff = now - windowMs;

      const kv = hasGlobalKV() ? getGlobalKV() : null;

      let requestCount: number;
      let oldestTimestamp: number | null = null;

      if (kv) {
        const kvKey = `${SLIDING_WINDOW_PREFIX}${key}`;

        // Remove old entries and add new one atomically using a transaction
        const tx = kv.multi();

        // First, remove old entries (can't do in transaction easily, do separately)
        const oldEntries = await kv.zrangebyscore(kvKey, "-inf", cutoff);
        if (oldEntries.length > 0) {
          await kv.zrem(kvKey, ...oldEntries);
        }

        // Add current request
        await kv.zadd(kvKey, now, `${now}:${Math.random()}`);

        // Set expiry
        await kv.expire(kvKey, Math.ceil(windowMs / 1000) + 1);

        // Get current count
        requestCount = await kv.zcard(kvKey);

        // Get oldest timestamp if at limit
        if (requestCount >= maxRequests) {
          const oldest = await kv.zrange(kvKey, 0, 0);
          if (oldest.length > 0) {
            oldestTimestamp = parseInt(oldest[0].split(":")[0], 10);
          }
        }
      } else {
        // Fallback to local state
        const timestamps = cleanupLocal(key, now);
        requestCount = timestamps.length;

        if (requestCount >= maxRequests) {
          oldestTimestamp = timestamps[0] ?? null;
        } else {
          timestamps.push(now);
          localRequests.set(key, timestamps);
          requestCount = timestamps.length;
        }
      }

      if (headers) {
        res.setHeader("X-RateLimit-Limit", maxRequests);
        res.setHeader("X-RateLimit-Remaining", Math.max(0, maxRequests - requestCount));
      }

      if (requestCount > maxRequests && oldestTimestamp) {
        const retryAfter = Math.ceil((oldestTimestamp + windowMs - now) / 1000);

        if (headers) {
          res.setHeader("Retry-After", retryAfter);
          res.setHeader("X-RateLimit-Reset", Math.ceil((oldestTimestamp + windowMs) / 1000));
        }

        throw new RateLimitError(retryAfter);
      }

      next();
    } catch (error) {
      next(error);
    }
  };
};

export const createResourceRateLimiter = (
  resourceName: string,
  config: RateLimitConfig
) => {
  return createRateLimiter({
    ...config,
    keyGenerator: (req) => {
      const baseKey = config.keyGenerator?.(req) ?? defaultKeyGenerator(req);
      return `${resourceName}:${baseKey}`;
    },
  });
};

export interface OperationRateLimits {
  read?: RateLimitConfig;
  create?: RateLimitConfig;
  update?: RateLimitConfig;
  delete?: RateLimitConfig;
  subscribe?: RateLimitConfig;
}

export const createOperationRateLimiter = (
  resourceName: string,
  limits: OperationRateLimits
) => {
  const limiters: Record<string, ReturnType<typeof createRateLimiter>> = {};

  for (const [op, config] of Object.entries(limits)) {
    if (config) {
      limiters[op] = createResourceRateLimiter(`${resourceName}:${op}`, config);
    }
  }

  return (operation: keyof OperationRateLimits) => {
    return limiters[operation] ?? ((_req: Request, _res: Response, next: NextFunction) => next());
  };
};

export const rateLimitPresets = {
  standard: { windowMs: 60 * 1000, maxRequests: 100 },
  strict: { windowMs: 60 * 1000, maxRequests: 20 },
  lenient: { windowMs: 60 * 1000, maxRequests: 1000 },
  auth: { windowMs: 60 * 1000, maxRequests: 5 },
  subscription: { windowMs: 60 * 1000, maxRequests: 10 },
};

/**
 * Reset the default store (useful for testing)
 */
export const resetDefaultStore = (): void => {
  if (defaultStore instanceof InMemoryRateLimitStore) {
    defaultStore.destroy();
  }
  defaultStore = null;
};
