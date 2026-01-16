import { describe, it, expect } from "vitest";
import { sql } from "drizzle-orm";
import {
  testOperatorEquivalence,
  fuzzOperatorEquivalence,
  validateOperatorEquivalence,
  defineOperator,
  BUILTIN_TEST_VALUES,
  createOperatorTestSuite,
  OperatorDefinition,
} from "@/resource/operator-equivalence";

describe("Operator Equivalence", () => {
  describe("testOperatorEquivalence", () => {
    it("should test equality operator", () => {
      const operator: OperatorDefinition = {
        op: "==",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (lhs, rhs) => String(lhs) === String(rhs),
      };

      const result = testOperatorEquivalence({
        operator,
        testValues: [
          { lhs: "test", rhs: "test", description: "Equal strings" },
          { lhs: "test", rhs: "other", description: "Different strings" },
          { lhs: 1, rhs: 1, description: "Equal numbers" },
          { lhs: "1", rhs: 1, description: "String vs number" },
        ],
      });

      expect(result.passed).toBe(true);
      expect(result.totalTests).toBe(4);
    });

    it("should detect JS execute returning wrong type", () => {
      const badOperator: OperatorDefinition = {
        op: "bad",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (_lhs, _rhs) => "true" as unknown as boolean,
      };

      const result = fuzzOperatorEquivalence(badOperator, 10);
      expect(result.passed).toBe(false);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe("fuzzOperatorEquivalence", () => {
    it("should run fuzz tests successfully for good operator", () => {
      const operator: OperatorDefinition = {
        op: "==",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (lhs, rhs) => String(lhs) === String(rhs),
      };

      const result = fuzzOperatorEquivalence(operator, 100);
      expect(result.passed).toBe(true);
      expect(result.iterations).toBe(100);
      expect(result.duration).toBeGreaterThanOrEqual(0);
    });

    it("should catch operators that throw on edge cases", () => {
      const throwingOperator: OperatorDefinition = {
        op: "throws",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (lhs, rhs) => {
          if (lhs === null) throw new Error("Cannot handle null");
          return String(lhs) === String(rhs);
        },
      };

      const result = fuzzOperatorEquivalence(throwingOperator, 100);
      expect(result.mismatches.length).toBeGreaterThan(0);
    });
  });

  describe("validateOperatorEquivalence", () => {
    it("should validate a well-formed operator", () => {
      const operator: OperatorDefinition = {
        op: "==",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (lhs, rhs) => String(lhs) === String(rhs),
      };

      const result = validateOperatorEquivalence(operator);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it("should reject operator without op", () => {
      const operator = {
        op: "",
        convert: (lhs: any, rhs: any) => sql`${lhs} = ${rhs}`,
        execute: (_lhs: any, _rhs: any) => true,
      } as OperatorDefinition;

      const result = validateOperatorEquivalence(operator);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Operator must have a non-empty 'op' string");
    });

    it("should reject operator without convert function", () => {
      const operator = {
        op: "test",
        convert: "not a function",
        execute: () => true,
      } as unknown as OperatorDefinition;

      const result = validateOperatorEquivalence(operator);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Operator must have a 'convert' function");
    });

    it("should reject operator without execute function", () => {
      const operator = {
        op: "test",
        convert: (lhs: any, rhs: any) => sql`${lhs} = ${rhs}`,
        execute: "not a function",
      } as unknown as OperatorDefinition;

      const result = validateOperatorEquivalence(operator);
      expect(result.valid).toBe(false);
      expect(result.errors).toContain("Operator must have an 'execute' function");
    });

    it("should detect execute returning non-boolean in strict mode", () => {
      const operator: OperatorDefinition = {
        op: "bad",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: () => 1 as unknown as boolean,
      };

      const result = validateOperatorEquivalence(operator, { strictMode: false });
      expect(result.valid).toBe(false);
    });
  });

  describe("defineOperator", () => {
    it("should create equality operator", () => {
      const op = defineOperator({
        name: "=eq=",
        comparator: "eq",
      });

      expect(op.op).toBe("=eq=");
      expect(op.execute("test", "test")).toBe(true);
      expect(op.execute("test", "other")).toBe(false);
    });

    it("should create case-insensitive operator", () => {
      const op = defineOperator({
        name: "=ieq=",
        comparator: "eq",
        caseSensitive: false,
      });

      expect(op.execute("TEST", "test")).toBe(true);
      expect(op.execute("Apple", "apple")).toBe(true);
    });

    it("should create greater than operator", () => {
      const op = defineOperator({
        name: "=gt=",
        comparator: "gt",
      });

      expect(op.execute(5, 3)).toBe(true);
      expect(op.execute(3, 5)).toBe(false);
      expect(op.execute(5, 5)).toBe(false);
    });

    it("should create less than operator", () => {
      const op = defineOperator({
        name: "=lt=",
        comparator: "lt",
      });

      expect(op.execute(3, 5)).toBe(true);
      expect(op.execute(5, 3)).toBe(false);
      expect(op.execute(5, 5)).toBe(false);
    });

    it("should create contains operator", () => {
      const op = defineOperator({
        name: "=contains=",
        comparator: "contains",
      });

      expect(op.execute("hello world", "world")).toBe(true);
      expect(op.execute("hello world", "foo")).toBe(false);
    });

    it("should create startsWith operator", () => {
      const op = defineOperator({
        name: "=startswith=",
        comparator: "startsWith",
      });

      expect(op.execute("hello world", "hello")).toBe(true);
      expect(op.execute("hello world", "world")).toBe(false);
    });

    it("should create endsWith operator", () => {
      const op = defineOperator({
        name: "=endswith=",
        comparator: "endsWith",
      });

      expect(op.execute("hello world", "world")).toBe(true);
      expect(op.execute("hello world", "hello")).toBe(false);
    });

    it("should create like operator", () => {
      const op = defineOperator({
        name: "=like=",
        comparator: "like",
      });

      expect(op.execute("hello world", "hello%")).toBe(true);
      expect(op.execute("hello world", "%world")).toBe(true);
      expect(op.execute("hello world", "%lo wo%")).toBe(true);
      expect(op.execute("hello world", "h_llo%")).toBe(true);
      expect(op.execute("hello world", "foo%")).toBe(false);
    });

    it("should create in operator", () => {
      const op = defineOperator({
        name: "=in=",
        comparator: "in",
      });

      expect(op.execute("apple", ["apple", "banana", "cherry"])).toBe(true);
      expect(op.execute("orange", ["apple", "banana", "cherry"])).toBe(false);
    });

    it("should support transform function", () => {
      const op = defineOperator({
        name: "=trimmed=",
        comparator: "eq",
        transform: (val) => String(val).trim(),
      });

      expect(op.execute("  test  ", "test")).toBe(true);
      expect(op.execute("test", "  test  ")).toBe(true);
    });
  });

  describe("BUILTIN_TEST_VALUES", () => {
    it("should have comprehensive test values", () => {
      expect(BUILTIN_TEST_VALUES.length).toBeGreaterThan(10);
      
      const hasNullTests = BUILTIN_TEST_VALUES.some(
        (v) => v.lhs === null || v.rhs === null
      );
      expect(hasNullTests).toBe(true);

      const hasStringTests = BUILTIN_TEST_VALUES.some(
        (v) => typeof v.lhs === "string" && typeof v.rhs === "string"
      );
      expect(hasStringTests).toBe(true);

      const hasNumberTests = BUILTIN_TEST_VALUES.some(
        (v) => typeof v.lhs === "number" && typeof v.rhs === "number"
      );
      expect(hasNumberTests).toBe(true);

      const hasMixedTypeTests = BUILTIN_TEST_VALUES.some(
        (v) => typeof v.lhs !== typeof v.rhs
      );
      expect(hasMixedTypeTests).toBe(true);
    });
  });

  describe("createOperatorTestSuite", () => {
    it("should create test suite for multiple operators", () => {
      const operators: OperatorDefinition[] = [
        {
          op: "==",
          convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
          execute: (lhs, rhs) => String(lhs) === String(rhs),
        },
        {
          op: "!=",
          convert: (lhs, rhs) => sql`${lhs} != ${rhs}`,
          execute: (lhs, rhs) => String(lhs) !== String(rhs),
        },
      ];

      const results = createOperatorTestSuite(operators);

      expect(results.size).toBe(2);
      expect(results.has("==")).toBe(true);
      expect(results.has("!=")).toBe(true);

      const eqResult = results.get("==")!;
      expect(eqResult.totalTests).toBe(BUILTIN_TEST_VALUES.length);
    });
  });

  describe("Builtin operators validation", () => {
    const builtinOperators: OperatorDefinition[] = [
      {
        op: "==",
        convert: (lhs, rhs) => sql`${lhs} = ${rhs}`,
        execute: (lhs, rhs) => String(lhs) === String(rhs),
      },
      {
        op: "!=",
        convert: (lhs, rhs) => sql`${lhs} != ${rhs}`,
        execute: (lhs, rhs) => String(lhs) !== String(rhs),
      },
      {
        op: ">=",
        convert: (lhs, rhs) => sql`${lhs} >= ${rhs}`,
        execute: (lhs, rhs) => {
          const tryNumber = (v: unknown) => {
            if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
            if (typeof v === "string") {
              const n = parseFloat(v.trim());
              return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
          };

          const aNum = tryNumber(lhs);
          const bNum = tryNumber(rhs);

          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            return aNum >= bNum;
          }

          return String(lhs).localeCompare(String(rhs)) >= 0;
        },
      },
      {
        op: "<=",
        convert: (lhs, rhs) => sql`${lhs} <= ${rhs}`,
        execute: (lhs, rhs) => {
          const tryNumber = (v: unknown) => {
            if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
            if (typeof v === "string") {
              const n = parseFloat(v.trim());
              return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
          };

          const aNum = tryNumber(lhs);
          const bNum = tryNumber(rhs);

          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            return aNum <= bNum;
          }

          return String(lhs).localeCompare(String(rhs)) <= 0;
        },
      },
      {
        op: ">",
        convert: (lhs, rhs) => sql`${lhs} > ${rhs}`,
        execute: (lhs, rhs) => {
          const tryNumber = (v: unknown) => {
            if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
            if (typeof v === "string") {
              const n = parseFloat(v.trim());
              return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
          };

          const aNum = tryNumber(lhs);
          const bNum = tryNumber(rhs);

          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            return aNum > bNum;
          }

          return String(lhs).localeCompare(String(rhs)) > 0;
        },
      },
      {
        op: "<",
        convert: (lhs, rhs) => sql`${lhs} < ${rhs}`,
        execute: (lhs, rhs) => {
          const tryNumber = (v: unknown) => {
            if (typeof v === "number") return Number.isFinite(v) ? v : NaN;
            if (typeof v === "string") {
              const n = parseFloat(v.trim());
              return Number.isFinite(n) ? n : NaN;
            }
            return NaN;
          };

          const aNum = tryNumber(lhs);
          const bNum = tryNumber(rhs);

          if (!Number.isNaN(aNum) && !Number.isNaN(bNum)) {
            return aNum < bNum;
          }

          return String(lhs).localeCompare(String(rhs)) < 0;
        },
      },
    ];

    it("should validate all builtin operators", () => {
      for (const op of builtinOperators) {
        const result = validateOperatorEquivalence(op);
        expect(result.valid).toBe(true);
        if (!result.valid) {
          console.error(`Operator ${op.op} failed:`, result.errors);
        }
      }
    });

    it("should pass fuzz testing for all builtin operators", () => {
      for (const op of builtinOperators) {
        const result = fuzzOperatorEquivalence(op, 50);
        expect(result.passed).toBe(true);
        if (!result.passed) {
          console.error(`Operator ${op.op} fuzz failed:`, result.mismatches);
        }
      }
    });
  });
});
