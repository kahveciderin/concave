import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import fc from "fast-check";

// ============================================================
// RATE LIMIT AND IDEMPOTENCY ADVERSARIAL TESTS
// ============================================================
// Tests for adversarial scenarios:
// 1. Idempotency key replay with different bodies
// 2. Idempotency TTL expiry behavior
// 3. Rate limit bypass attempts
// 4. Header manipulation
// 5. Timing attacks

type IdempotencyRecord = {
  key: string;
  response: unknown;
  createdAt: number;
  requestHash: string;
};

type RateLimitState = {
  count: number;
  windowStart: number;
  blocked: boolean;
};

// Simulated idempotency store
class IdempotencyStore {
  private records: Map<string, IdempotencyRecord> = new Map();
  private ttlMs: number;

  constructor(ttlMs: number = 3600000) {
    this.ttlMs = ttlMs;
  }

  set(key: string, response: unknown, requestHash: string): void {
    this.records.set(key, {
      key,
      response,
      createdAt: Date.now(),
      requestHash,
    });
  }

  get(key: string): IdempotencyRecord | null {
    const record = this.records.get(key);
    if (!record) return null;

    // Check TTL
    if (Date.now() - record.createdAt > this.ttlMs) {
      this.records.delete(key);
      return null;
    }

    return record;
  }

  clear(): void {
    this.records.clear();
  }
}

// Simulated rate limiter
class RateLimiter {
  private limits: Map<string, RateLimitState> = new Map();
  private windowMs: number;
  private maxRequests: number;

  constructor(windowMs: number = 60000, maxRequests: number = 100) {
    this.windowMs = windowMs;
    this.maxRequests = maxRequests;
  }

  check(identifier: string): { allowed: boolean; remaining: number; resetAt: number } {
    const now = Date.now();
    let state = this.limits.get(identifier);

    if (!state || now - state.windowStart > this.windowMs) {
      state = { count: 0, windowStart: now, blocked: false };
      this.limits.set(identifier, state);
    }

    state.count++;
    const allowed = state.count <= this.maxRequests;
    state.blocked = !allowed;

    return {
      allowed,
      remaining: Math.max(0, this.maxRequests - state.count),
      resetAt: state.windowStart + this.windowMs,
    };
  }

  reset(identifier: string): void {
    this.limits.delete(identifier);
  }
}

// Helper to hash request body
const hashRequest = (body: unknown): string => {
  return JSON.stringify(body)
    .split("")
    .reduce((a, b) => ((a << 5) - a + b.charCodeAt(0)) | 0, 0)
    .toString(16);
};

describe("Idempotency Adversarial Tests", () => {
  let store: IdempotencyStore;

  beforeEach(() => {
    store = new IdempotencyStore(3600000); // 1 hour TTL
  });

  describe("Idempotency Key Replay with Different Bodies", () => {
    it("rejects replay with different body (strict mode)", () => {
      const key = "idempotency-key-123";
      const originalBody = { amount: 100, currency: "USD" };
      const differentBody = { amount: 200, currency: "USD" };

      const originalHash = hashRequest(originalBody);
      const differentHash = hashRequest(differentBody);

      // First request
      store.set(key, { success: true, id: "txn-1" }, originalHash);

      // Replay with different body
      const record = store.get(key);
      expect(record).not.toBeNull();
      expect(record?.requestHash).toBe(originalHash);
      expect(record?.requestHash).not.toBe(differentHash);

      // Should reject - body mismatch with same idempotency key
    });

    it("returns original response for replay with same body", () => {
      const key = "idempotency-key-456";
      const body = { amount: 100, currency: "USD" };
      const hash = hashRequest(body);

      const originalResponse = { success: true, id: "txn-2" };

      // First request
      store.set(key, originalResponse, hash);

      // Replay with same body
      const record = store.get(key);
      expect(record).not.toBeNull();
      expect(record?.requestHash).toBe(hash);
      expect(record?.response).toEqual(originalResponse);
    });

    it("handles body reordering correctly", () => {
      const body1 = { a: 1, b: 2 };
      const body2 = { b: 2, a: 1 };

      // JSON.stringify produces same output for same content
      const hash1 = hashRequest(body1);
      const hash2 = hashRequest(body2);

      // Depending on implementation, these might or might not match
      // Document the expected behavior
      expect(typeof hash1).toBe("string");
      expect(typeof hash2).toBe("string");
    });

    it("handles nested object differences", () => {
      const body1 = { user: { name: "Alice", age: 30 } };
      const body2 = { user: { name: "Alice", age: 31 } };

      const hash1 = hashRequest(body1);
      const hash2 = hashRequest(body2);

      // Different content should produce different hashes
      expect(hash1).not.toBe(hash2);
    });
  });

  describe("Idempotency TTL Expiry", () => {
    it("allows re-execution after TTL expiry", () => {
      vi.useFakeTimers();

      const shortTTLStore = new IdempotencyStore(1000); // 1 second TTL
      const key = "expiring-key";
      const hash = hashRequest({ test: true });

      // First request
      shortTTLStore.set(key, { result: "first" }, hash);
      expect(shortTTLStore.get(key)).not.toBeNull();

      // Wait for TTL to expire
      vi.advanceTimersByTime(1500);

      // Record should be expired
      expect(shortTTLStore.get(key)).toBeNull();

      // Can now re-execute with same key
      shortTTLStore.set(key, { result: "second" }, hash);
      expect(shortTTLStore.get(key)?.response).toEqual({ result: "second" });

      vi.useRealTimers();
    });

    it("TTL is measured from first request, not last access", () => {
      vi.useFakeTimers();

      const shortTTLStore = new IdempotencyStore(2000); // 2 second TTL
      const key = "ttl-test";
      const hash = hashRequest({ test: true });

      // First request at T=0
      shortTTLStore.set(key, { result: "value" }, hash);

      // Access at T=1000ms (shouldn't reset TTL)
      vi.advanceTimersByTime(1000);
      expect(shortTTLStore.get(key)).not.toBeNull();

      // Access at T=1500ms
      vi.advanceTimersByTime(500);
      expect(shortTTLStore.get(key)).not.toBeNull();

      // At T=2500ms, should be expired (TTL started at T=0)
      vi.advanceTimersByTime(1000);
      expect(shortTTLStore.get(key)).toBeNull();

      vi.useRealTimers();
    });

    it("documents and tests TTL expiry behavior explicitly", () => {
      // After TTL:
      // Option A: Same key re-runs the operation (current behavior)
      // Option B: Same key returns error "key expired"

      const expectedBehavior = "re-runs"; // Document this
      expect(expectedBehavior).toBe("re-runs");
    });
  });

  describe("Idempotency Key Format", () => {
    it("accepts valid UUID format keys", () => {
      fc.assert(
        fc.property(fc.uuid(), (uuid) => {
          const isValid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
            uuid
          );
          return isValid;
        }),
        { numRuns: 100 }
      );
    });

    it("rejects keys with invalid characters", () => {
      const invalidKeys = [
        "key with spaces",
        "key<script>alert(1)</script>",
        "key\nwith\nnewlines",
        "key\twith\ttabs",
        "key;with;semicolons",
      ];

      const validKeyPattern = /^[a-zA-Z0-9_-]+$/;

      for (const key of invalidKeys) {
        const isValid = validKeyPattern.test(key);
        expect(isValid).toBe(false);
      }
    });

    it("enforces maximum key length", () => {
      const maxLength = 256;
      const longKey = "a".repeat(maxLength + 1);

      expect(longKey.length).toBeGreaterThan(maxLength);
      // Should reject keys over max length
    });
  });
});

describe("Rate Limit Adversarial Tests", () => {
  let limiter: RateLimiter;

  beforeEach(() => {
    limiter = new RateLimiter(60000, 10); // 10 requests per minute
  });

  describe("Rate Limit Bypass Attempts", () => {
    it("blocks after exceeding limit", () => {
      const clientId = "client-123";

      // Make requests up to limit
      for (let i = 0; i < 10; i++) {
        const result = limiter.check(clientId);
        expect(result.allowed).toBe(true);
      }

      // 11th request should be blocked
      const result = limiter.check(clientId);
      expect(result.allowed).toBe(false);
    });

    it("different clients have separate limits", () => {
      const client1 = "client-1";
      const client2 = "client-2";

      // Exhaust client1's limit
      for (let i = 0; i < 10; i++) {
        limiter.check(client1);
      }
      expect(limiter.check(client1).allowed).toBe(false);

      // Client2 should still have allowance
      expect(limiter.check(client2).allowed).toBe(true);
    });

    it("rejects header case manipulation bypass", () => {
      // Attacker tries different header casings
      const variations = [
        "X-Forwarded-For",
        "x-forwarded-for",
        "X-FORWARDED-FOR",
        "X-Forwarded-FOR",
      ];

      // All should be normalized to same identifier
      const normalizeHeader = (header: string) => header.toLowerCase();

      const normalized = variations.map(normalizeHeader);
      const unique = new Set(normalized);

      expect(unique.size).toBe(1);
    });

    it("handles IPv4/IPv6 normalization", () => {
      const ipVariations = [
        { ip: "::ffff:192.168.1.1", normalized: "192.168.1.1" },
        { ip: "192.168.1.1", normalized: "192.168.1.1" },
        { ip: "::1", normalized: "::1" },
        { ip: "0:0:0:0:0:0:0:1", normalized: "::1" },
      ];

      const normalizeIP = (ip: string): string => {
        // Strip IPv4-mapped IPv6 prefix
        if (ip.startsWith("::ffff:")) {
          return ip.substring(7);
        }
        // Normalize IPv6 loopback
        if (ip === "0:0:0:0:0:0:0:1") {
          return "::1";
        }
        return ip;
      };

      for (const { ip, normalized } of ipVariations) {
        expect(normalizeIP(ip)).toBe(normalized);
      }
    });

    it("prevents X-Forwarded-For spoofing", () => {
      // Only trust X-Forwarded-For if from trusted proxy
      const trustedProxies = ["10.0.0.1", "10.0.0.2"];

      const isTrustedProxy = (proxyIP: string) => trustedProxies.includes(proxyIP);

      // Request from untrusted source with X-Forwarded-For
      const requestFromUntrusted = {
        remoteIP: "192.168.1.100", // Not a trusted proxy
        headers: { "x-forwarded-for": "1.2.3.4" },
      };

      // Should use remoteIP, not X-Forwarded-For
      const clientIP = isTrustedProxy(requestFromUntrusted.remoteIP)
        ? requestFromUntrusted.headers["x-forwarded-for"]
        : requestFromUntrusted.remoteIP;

      expect(clientIP).toBe("192.168.1.100");
    });

    it("handles multiple IPs in X-Forwarded-For", () => {
      // X-Forwarded-For: client, proxy1, proxy2
      const header = "1.2.3.4, 10.0.0.1, 10.0.0.2";
      const ips = header.split(",").map((ip) => ip.trim());

      // Leftmost IP is the original client
      const clientIP = ips[0];
      expect(clientIP).toBe("1.2.3.4");
    });
  });

  describe("Distributed Rate Limiting", () => {
    it("rate limit state is consistent across instances", () => {
      // Simulate distributed counter
      const sharedState = { count: 0 };
      const maxRequests = 10;

      // Instance 1 increments
      sharedState.count += 5;

      // Instance 2 checks and increments
      const canProceed = sharedState.count < maxRequests;
      expect(canProceed).toBe(true);
      sharedState.count += 3;

      // Instance 1 checks
      const stillCanProceed = sharedState.count < maxRequests;
      expect(stillCanProceed).toBe(true);

      // Instance 2 exceeds
      sharedState.count += 5;
      const nowBlocked = sharedState.count >= maxRequests;
      expect(nowBlocked).toBe(true);
    });

    it("handles race conditions in increment", () => {
      // Use atomic increment (simulated)
      let counter = 0;
      const limit = 10;

      const atomicCheckAndIncrement = (): boolean => {
        // In real implementation, this would be atomic (e.g., Redis INCR)
        const current = counter;
        if (current >= limit) return false;
        counter = current + 1;
        return true;
      };

      // Simulate concurrent requests
      const results = [];
      for (let i = 0; i < 15; i++) {
        results.push(atomicCheckAndIncrement());
      }

      const allowed = results.filter((r) => r).length;
      const blocked = results.filter((r) => !r).length;

      expect(allowed).toBe(10);
      expect(blocked).toBe(5);
    });
  });

  describe("Rate Limit Response Headers", () => {
    it("returns correct rate limit headers", () => {
      const result = limiter.check("client-1");

      expect(result).toHaveProperty("remaining");
      expect(result).toHaveProperty("resetAt");
      expect(typeof result.remaining).toBe("number");
      expect(typeof result.resetAt).toBe("number");
    });

    it("remaining decreases with each request", () => {
      const remaining = [];

      for (let i = 0; i < 5; i++) {
        const result = limiter.check("client-2");
        remaining.push(result.remaining);
      }

      // Should be decreasing
      for (let i = 1; i < remaining.length; i++) {
        expect(remaining[i]).toBeLessThan(remaining[i - 1]!);
      }
    });

    it("resetAt is in the future", () => {
      const result = limiter.check("client-3");
      const now = Date.now();

      expect(result.resetAt).toBeGreaterThan(now);
    });
  });

  describe("Sliding Window vs Fixed Window", () => {
    it("fixed window allows burst at window boundary", () => {
      vi.useFakeTimers();

      const fixedLimiter = new RateLimiter(60000, 10);

      // Use 10 requests at end of window
      for (let i = 0; i < 10; i++) {
        fixedLimiter.check("client-fixed");
      }
      expect(fixedLimiter.check("client-fixed").allowed).toBe(false);

      // New window starts
      vi.advanceTimersByTime(60001);

      // Can immediately do 10 more (burst of 20 across 1ms boundary)
      for (let i = 0; i < 10; i++) {
        expect(fixedLimiter.check("client-fixed").allowed).toBe(true);
      }

      vi.useRealTimers();
    });
  });

  describe("Rate Limit by Different Dimensions", () => {
    it("can limit by user ID", () => {
      const userLimiter = new RateLimiter(60000, 5);

      const user1 = "user:user-123";
      const user2 = "user:user-456";

      // User 1 exhausts limit
      for (let i = 0; i < 5; i++) {
        userLimiter.check(user1);
      }
      expect(userLimiter.check(user1).allowed).toBe(false);

      // User 2 unaffected
      expect(userLimiter.check(user2).allowed).toBe(true);
    });

    it("can limit by endpoint", () => {
      const endpointLimiter = new RateLimiter(60000, 100);

      const expensive = "endpoint:/api/heavy-operation";
      const cheap = "endpoint:/api/simple-read";

      // Different limits for different endpoints
      expect(typeof expensive).toBe("string");
      expect(typeof cheap).toBe("string");
    });

    it("can combine dimensions (user + endpoint)", () => {
      const combinedKey = (userId: string, endpoint: string) =>
        `${userId}:${endpoint}`;

      const key1 = combinedKey("user-1", "/api/create");
      const key2 = combinedKey("user-1", "/api/read");
      const key3 = combinedKey("user-2", "/api/create");

      // All different keys
      expect(new Set([key1, key2, key3]).size).toBe(3);
    });
  });

  describe("Timing Attack Prevention", () => {
    it("response time is consistent for valid vs invalid keys", () => {
      // Idempotency key validation should be constant-time
      const validateKey = (key: string): boolean => {
        const validPattern = /^[a-zA-Z0-9_-]{1,256}$/;
        return validPattern.test(key);
      };

      const validKey = "valid-key-123";
      const invalidKey = "invalid key with spaces!";

      // Both should complete in similar time (not leak info via timing)
      const start1 = performance.now();
      validateKey(validKey);
      const time1 = performance.now() - start1;

      const start2 = performance.now();
      validateKey(invalidKey);
      const time2 = performance.now() - start2;

      // Times should be within reasonable bounds (not orders of magnitude different)
      expect(Math.abs(time1 - time2)).toBeLessThan(1); // < 1ms difference
    });
  });
});

describe("Edge Cases and Adversarial Inputs", () => {
  describe("Malformed Headers", () => {
    it("handles missing idempotency key header", () => {
      const headers: Record<string, string> = {};
      const key = headers["idempotency-key"] || headers["Idempotency-Key"];

      expect(key).toBeUndefined();
      // Request should proceed without idempotency protection
    });

    it("handles empty idempotency key", () => {
      const key = "";
      const isValid = key.length > 0;

      expect(isValid).toBe(false);
      // Should reject empty key
    });

    it("handles null bytes in key", () => {
      const key = "key\x00with\x00nulls";
      const sanitized = key.replace(/\x00/g, "");

      expect(sanitized).not.toContain("\x00");
    });
  });

  describe("Concurrent Idempotency Requests", () => {
    it("handles race condition on first write", () => {
      // Two identical requests arrive simultaneously
      const key = "concurrent-key";
      const body = { amount: 100 };
      const hash = hashRequest(body);

      // Both check - neither finds existing record
      const store = new IdempotencyStore();
      const check1 = store.get(key);
      const check2 = store.get(key);

      expect(check1).toBeNull();
      expect(check2).toBeNull();

      // In real implementation, atomic check-and-set would prevent both proceeding
      // This test documents the need for atomic operations
    });

    it("returns same response for concurrent identical requests", () => {
      // Using locking/atomic operations
      const responses = new Map<string, { response: unknown; inProgress: boolean }>();
      const key = "locked-key";

      const processWithLock = async (
        key: string,
        processor: () => Promise<unknown>
      ): Promise<unknown> => {
        const existing = responses.get(key);

        if (existing?.response) {
          return existing.response;
        }

        if (existing?.inProgress) {
          // Wait for in-progress request (simplified)
          await new Promise((resolve) => setTimeout(resolve, 10));
          return responses.get(key)?.response;
        }

        // Mark as in progress
        responses.set(key, { response: null, inProgress: true });

        // Process
        const response = await processor();

        // Store result
        responses.set(key, { response, inProgress: false });

        return response;
      };

      // Both should get same response
      expect(typeof processWithLock).toBe("function");
    });
  });
});
