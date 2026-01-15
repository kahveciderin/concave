import { describe, it, expect } from "vitest";
import {
  parseSelect,
  applyProjection,
  parseAggregationParams,
  transformAggregationResults,
  mergeProjections,
  isFieldIncluded,
} from "@/resource/query";

describe("Query Utilities", () => {
  describe("parseSelect", () => {
    it("should parse comma-separated fields", () => {
      expect(parseSelect("id,name,email")).toEqual(["id", "name", "email"]);
    });

    it("should handle whitespace", () => {
      expect(parseSelect("id, name , email")).toEqual(["id", "name", "email"]);
    });

    it("should return undefined for empty input", () => {
      expect(parseSelect(undefined)).toBeUndefined();
      expect(parseSelect("")).toBeUndefined();
    });

    it("should filter empty strings", () => {
      expect(parseSelect("id,,name")).toEqual(["id", "name"]);
    });
  });

  describe("applyProjection", () => {
    it("should filter fields", () => {
      const items = [
        { id: "1", name: "John", email: "john@test.com", age: 30 },
        { id: "2", name: "Jane", email: "jane@test.com", age: 25 },
      ];

      const result = applyProjection(items, ["id", "name"]);

      expect(result).toEqual([
        { id: "1", name: "John" },
        { id: "2", name: "Jane" },
      ]);
    });

    it("should return items unchanged with no projection", () => {
      const items = [{ id: "1", name: "John" }];

      expect(applyProjection(items, undefined)).toEqual(items);
      expect(applyProjection(items, [])).toEqual(items);
    });

    it("should handle missing fields gracefully", () => {
      const items = [{ id: "1", name: "John" }];
      const result = applyProjection(items, ["id", "nonexistent"]);

      expect(result).toEqual([{ id: "1" }]);
    });
  });

  describe("parseAggregationParams", () => {
    it("should parse groupBy", () => {
      const params = parseAggregationParams({ groupBy: "role,status" });
      expect(params.groupBy).toEqual(["role", "status"]);
    });

    it("should parse count", () => {
      expect(parseAggregationParams({ count: "true" }).count).toBe(true);
      expect(parseAggregationParams({ count: true }).count).toBe(true);
      expect(parseAggregationParams({ count: "false" }).count).toBe(false);
    });

    it("should parse sum fields", () => {
      const params = parseAggregationParams({ sum: "amount,quantity" });
      expect(params.sum).toEqual(["amount", "quantity"]);
    });

    it("should parse avg fields", () => {
      const params = parseAggregationParams({ avg: "age,salary" });
      expect(params.avg).toEqual(["age", "salary"]);
    });

    it("should parse min/max fields", () => {
      const params = parseAggregationParams({
        min: "price",
        max: "price",
      });
      expect(params.min).toEqual(["price"]);
      expect(params.max).toEqual(["price"]);
    });

    it("should handle missing params", () => {
      const params = parseAggregationParams({});

      expect(params.groupBy).toEqual([]);
      expect(params.sum).toEqual([]);
      expect(params.avg).toEqual([]);
      expect(params.min).toEqual([]);
      expect(params.max).toEqual([]);
      expect(params.count).toBe(false);
    });
  });

  describe("transformAggregationResults", () => {
    it("should transform results with group key", () => {
      const results = [
        { role: "admin", count: 5 },
        { role: "user", count: 100 },
      ];

      const params = {
        groupBy: ["role"],
        sum: [],
        avg: [],
        min: [],
        max: [],
        count: true,
      };

      const transformed = transformAggregationResults(results, params);

      expect(transformed.groups).toEqual([
        { key: { role: "admin" }, count: 5 },
        { key: { role: "user" }, count: 100 },
      ]);
    });

    it("should transform results with aggregations", () => {
      const results = [
        {
          role: "admin",
          count: 5,
          sum_salary: 500000,
          avg_age: 35,
        },
      ];

      const params = {
        groupBy: ["role"],
        sum: ["salary"],
        avg: ["age"],
        min: [],
        max: [],
        count: true,
      };

      const transformed = transformAggregationResults(results, params);

      expect(transformed.groups[0]).toEqual({
        key: { role: "admin" },
        count: 5,
        sum: { salary: 500000 },
        avg: { age: 35 },
      });
    });

    it("should handle null group key when no groupBy", () => {
      const results = [{ count: 100, sum_amount: 5000 }];

      const params = {
        groupBy: [],
        sum: ["amount"],
        avg: [],
        min: [],
        max: [],
        count: true,
      };

      const transformed = transformAggregationResults(results, params);

      expect(transformed.groups[0].key).toBeNull();
      expect(transformed.groups[0].count).toBe(100);
      expect(transformed.groups[0].sum).toEqual({ amount: 5000 });
    });
  });

  describe("mergeProjections", () => {
    it("should merge multiple projections", () => {
      const result = mergeProjections(["id", "name"], ["email", "name"]);

      expect(result).toContain("id");
      expect(result).toContain("name");
      expect(result).toContain("email");
      expect(result).toHaveLength(3);
    });

    it("should return undefined if no projections", () => {
      expect(mergeProjections(undefined, undefined)).toBeUndefined();
    });

    it("should handle mixed undefined and defined", () => {
      const result = mergeProjections(undefined, ["id", "name"]);
      expect(result).toEqual(["id", "name"]);
    });
  });

  describe("isFieldIncluded", () => {
    it("should return true if field is in projection", () => {
      expect(isFieldIncluded("name", ["id", "name"])).toBe(true);
    });

    it("should return false if field is not in projection", () => {
      expect(isFieldIncluded("email", ["id", "name"])).toBe(false);
    });

    it("should return true if no projection", () => {
      expect(isFieldIncluded("any", undefined)).toBe(true);
    });
  });
});
