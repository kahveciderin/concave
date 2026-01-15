import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryRateLimitStore,
  rateLimitPresets,
} from "@/middleware/rateLimit";

describe("Rate Limiting", () => {
  describe("InMemoryRateLimitStore", () => {
    let store: InMemoryRateLimitStore;

    beforeEach(() => {
      store = new InMemoryRateLimitStore();
    });

    afterEach(() => {
      store.destroy();
    });

    it("should increment count for new key", async () => {
      const result = await store.increment("test-key", 60000);

      expect(result.count).toBe(1);
      expect(result.resetAt).toBeGreaterThan(Date.now());
    });

    it("should increment count for existing key", async () => {
      await store.increment("test-key", 60000);
      await store.increment("test-key", 60000);
      const result = await store.increment("test-key", 60000);

      expect(result.count).toBe(3);
    });

    it("should reset count after window expires", async () => {
      vi.useFakeTimers();

      await store.increment("test-key", 1000);
      await store.increment("test-key", 1000);

      vi.advanceTimersByTime(1500);

      const result = await store.increment("test-key", 1000);
      expect(result.count).toBe(1);

      vi.useRealTimers();
    });

    it("should decrement count", async () => {
      await store.increment("test-key", 60000);
      await store.increment("test-key", 60000);
      await store.decrement("test-key");

      const result = await store.increment("test-key", 60000);
      expect(result.count).toBe(2);
    });

    it("should reset key", async () => {
      await store.increment("test-key", 60000);
      await store.increment("test-key", 60000);
      await store.reset("test-key");

      const result = await store.increment("test-key", 60000);
      expect(result.count).toBe(1);
    });
  });

  describe("rateLimitPresets", () => {
    it("should have standard preset", () => {
      expect(rateLimitPresets.standard).toEqual({
        windowMs: 60000,
        maxRequests: 100,
      });
    });

    it("should have strict preset", () => {
      expect(rateLimitPresets.strict).toEqual({
        windowMs: 60000,
        maxRequests: 20,
      });
    });

    it("should have lenient preset", () => {
      expect(rateLimitPresets.lenient).toEqual({
        windowMs: 60000,
        maxRequests: 1000,
      });
    });

    it("should have auth preset", () => {
      expect(rateLimitPresets.auth).toEqual({
        windowMs: 60000,
        maxRequests: 5,
      });
    });

    it("should have subscription preset", () => {
      expect(rateLimitPresets.subscription).toEqual({
        windowMs: 60000,
        maxRequests: 10,
      });
    });
  });
});
