import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  setGlobalSearch,
  getGlobalSearch,
  hasGlobalSearch,
  clearGlobalSearch,
  createMemorySearchAdapter,
  SearchAdapter,
} from "@/search";

describe("Global Search Adapter", () => {
  afterEach(() => {
    clearGlobalSearch();
  });

  describe("setGlobalSearch", () => {
    it("should register an adapter", () => {
      const adapter = createMemorySearchAdapter();

      setGlobalSearch(adapter);

      expect(hasGlobalSearch()).toBe(true);
    });

    it("should replace existing adapter", () => {
      const adapter1 = createMemorySearchAdapter();
      const adapter2 = createMemorySearchAdapter();

      setGlobalSearch(adapter1);
      setGlobalSearch(adapter2);

      expect(getGlobalSearch()).toBe(adapter2);
    });
  });

  describe("getGlobalSearch", () => {
    it("should return registered adapter", () => {
      const adapter = createMemorySearchAdapter();
      setGlobalSearch(adapter);

      const result = getGlobalSearch();

      expect(result).toBe(adapter);
    });

    it("should throw when no adapter registered", () => {
      expect(() => getGlobalSearch()).toThrow(
        "No global search adapter configured"
      );
    });
  });

  describe("hasGlobalSearch", () => {
    it("should return false when no adapter registered", () => {
      expect(hasGlobalSearch()).toBe(false);
    });

    it("should return true when adapter registered", () => {
      setGlobalSearch(createMemorySearchAdapter());

      expect(hasGlobalSearch()).toBe(true);
    });
  });

  describe("clearGlobalSearch", () => {
    it("should remove registered adapter", () => {
      setGlobalSearch(createMemorySearchAdapter());
      expect(hasGlobalSearch()).toBe(true);

      clearGlobalSearch();

      expect(hasGlobalSearch()).toBe(false);
    });

    it("should be safe to call multiple times", () => {
      clearGlobalSearch();
      clearGlobalSearch();

      expect(hasGlobalSearch()).toBe(false);
    });
  });

  describe("Custom adapter", () => {
    it("should accept any adapter implementing the interface", () => {
      const customAdapter: SearchAdapter = {
        async index() {},
        async delete() {},
        async search() {
          return { hits: [], total: 0 };
        },
        async createIndex() {},
        async deleteIndex() {},
        async indexExists() {
          return false;
        },
      };

      setGlobalSearch(customAdapter);

      expect(getGlobalSearch()).toBe(customAdapter);
    });
  });
});
