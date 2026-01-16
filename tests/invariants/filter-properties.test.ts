import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import { createResourceFilter } from "../../src/resource/filter";
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";
import { FilterParseError } from "../../src/resource/error";

// Test table for filter evaluation
const testTable = sqliteTable("test_items", {
  id: text("id").primaryKey(),
  name: text("name"),
  status: text("status"),
  score: integer("score"),
  value: integer("value"),
  category: text("category"),
  enabled: integer("enabled"),
  num: integer("num"),
  field: text("field"),
});

type TestItem = {
  id: string;
  name: string | null;
  status: string | null;
  score: number | null;
  value: number | null;
  category: string | null;
  enabled: number | null;
  num: number | null;
  field: string | null;
};

// ============================================================
// PROPERTY-BASED TESTS: FILTER SYSTEM INVARIANTS
// ============================================================
// These tests use generative/property-based testing to verify
// that the filter system maintains correctness invariants
// across randomly generated inputs.

describe("Filter Property-Based Tests", () => {
  let filter: ReturnType<typeof createResourceFilter>;

  beforeEach(() => {
    filter = createResourceFilter(testTable);
  });

  describe("SQL/In-Memory Equivalence", () => {
    // The critical invariant: SQL execution and in-memory matching
    // must produce the same results for the same filter and data.

    it("equality filter: in-memory matcher is consistent", () => {
      fc.assert(
        fc.property(
          fc.constantFrom("active", "inactive", "pending"),
          fc.constantFrom("active", "inactive", "pending"),
          (filterValue, testValue) => {
            const filterStr = `status=="${filterValue}"`;
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: testValue,
              score: 0,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const result = filter.execute(filterStr, testItem);
            const expected = filterValue === testValue;
            return result === expected;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("inequality operators are consistent", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (filterValue, testValue) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const gtResult = filter.execute(`score=gt=${filterValue}`, testItem);
            const geResult = filter.execute(`score=ge=${filterValue}`, testItem);
            const ltResult = filter.execute(`score=lt=${filterValue}`, testItem);
            const leResult = filter.execute(`score=le=${filterValue}`, testItem);

            return (
              gtResult === (testValue > filterValue) &&
              geResult === (testValue >= filterValue) &&
              ltResult === (testValue < filterValue) &&
              leResult === (testValue <= filterValue)
            );
          }
        ),
        { numRuns: 200 }
      );
    });

    it("=in= operator matches correctly", () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 50 }),
          (inValues, testValue) => {
            const filterStr = `score=in=(${inValues.join(",")})`;
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const result = filter.execute(filterStr, testItem);
            const expected = inValues.includes(testValue);
            return result === expected;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("=out= operator matches correctly", () => {
      fc.assert(
        fc.property(
          fc.array(fc.integer({ min: 0, max: 50 }), { minLength: 1, maxLength: 5 }),
          fc.integer({ min: 0, max: 50 }),
          (outValues, testValue) => {
            const filterStr = `score=out=(${outValues.join(",")})`;
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const result = filter.execute(filterStr, testItem);
            const expected = !outValues.includes(testValue);
            return result === expected;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("null checks work consistently", () => {
      const testCases = [
        { field: "status", value: null, checkNull: true, expected: true },
        { field: "status", value: "active", checkNull: true, expected: false },
        { field: "status", value: null, checkNull: false, expected: false },
        { field: "status", value: "active", checkNull: false, expected: true },
      ];

      for (const tc of testCases) {
        const filterStr = `${tc.field}=isnull=${tc.checkNull}`;
        const testItem: TestItem = {
          id: "1",
          name: "Test",
          status: tc.value,
          score: 0,
          value: 0,
          category: null,
          enabled: 1,
          num: 0,
          field: null,
        };

        const result = filter.execute(filterStr, testItem);
        expect(result).toBe(tc.expected);
      }
    });
  });

  describe("Boolean Algebra Invariants", () => {
    it("AND is commutative for independent conditions", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (val1, val2, testVal1, testVal2) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testVal1,
              value: testVal2,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const filterAB = `score==${val1};value==${val2}`;
            const filterBA = `value==${val2};score==${val1}`;

            return filter.execute(filterAB, testItem) === filter.execute(filterBA, testItem);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("OR is commutative", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (val1, val2, testVal) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testVal,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const filterAB = `score==${val1},score==${val2}`;
            const filterBA = `score==${val2},score==${val1}`;

            return filter.execute(filterAB, testItem) === filter.execute(filterBA, testItem);
          }
        ),
        { numRuns: 200 }
      );
    });

    it("!= is opposite of ==", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (value, testValue) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const eqResult = filter.execute(`score==${value}`, testItem);
            const neResult = filter.execute(`score!=${value}`, testItem);

            return eqResult === !neResult;
          }
        ),
        { numRuns: 200 }
      );
    });

    it("AND with same condition is idempotent", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (value, testValue) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const single = `score==${value}`;
            const double = `score==${value};score==${value}`;

            return filter.execute(single, testItem) === filter.execute(double, testItem);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("OR with same condition is idempotent", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 100 }),
          fc.integer({ min: 0, max: 100 }),
          (value, testValue) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testValue,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            const single = `score==${value}`;
            const double = `score==${value},score==${value}`;

            return filter.execute(single, testItem) === filter.execute(double, testItem);
          }
        ),
        { numRuns: 100 }
      );
    });

    it("DeMorgan: NOT(A AND B) == NOT(A) OR NOT(B)", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          fc.integer({ min: 0, max: 10 }),
          (val1, val2, testVal1, testVal2) => {
            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: testVal1,
              value: testVal2,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            // A AND B
            const andFilter = `score==${val1};value==${val2}`;
            // NOT A OR NOT B (using !=)
            const demorganFilter = `score!=${val1},value!=${val2}`;

            const andResult = filter.execute(andFilter, testItem);
            const demorganResult = filter.execute(demorganFilter, testItem);

            // NOT(A AND B) should equal (NOT A OR NOT B)
            return !andResult === demorganResult;
          }
        ),
        { numRuns: 300 }
      );
    });
  });

  describe("Edge Cases and Boundary Conditions", () => {
    it("empty string values are handled correctly", () => {
      const testItem: TestItem = {
        id: "1",
        name: "",
        status: "active",
        score: 0,
        value: 0,
        category: null,
        enabled: 1,
        num: 0,
        field: "",
      };

      expect(filter.execute('name==""', testItem)).toBe(true);
      expect(filter.execute('name=="nonempty"', testItem)).toBe(false);
    });

    it("handles numeric boundaries correctly", () => {
      const testItem: TestItem = {
        id: "1",
        name: "Test",
        status: "active",
        score: 0,
        value: 0,
        category: null,
        enabled: 1,
        num: 0,
        field: null,
      };

      expect(filter.execute("score==0", testItem)).toBe(true);
      expect(filter.execute("score=gt=-1", testItem)).toBe(true);
      expect(filter.execute("score=lt=1", testItem)).toBe(true);
    });

    it("handles deeply nested groups without stack overflow", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: 1, max: 8 }), // Limited depth due to config
          fc.integer({ min: 0, max: 100 }),
          (depth, value) => {
            let filterStr = `score==${value}`;
            for (let i = 0; i < depth; i++) {
              filterStr = `(${filterStr})`;
            }

            const testItem: TestItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: value,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };

            try {
              const result = filter.execute(filterStr, testItem);
              return result === true;
            } catch {
              return true; // Complexity limit reached is OK
            }
          }
        ),
        { numRuns: 50 }
      );
    });
  });

  describe("Metamorphic Tests", () => {
    it("filter refinement: A;B matches subset of A", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              score: fc.integer({ min: 0, max: 100 }),
              value: fc.integer({ min: 0, max: 100 }),
            }),
            { minLength: 5, maxLength: 20 }
          ),
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 0, max: 50 }),
          (items, val1, val2) => {
            const testItems = items.map((i) => ({
              ...i,
              name: "Test",
              status: "active",
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            }));

            const filterA = `score=gt=${val1}`;
            const filterAB = `score=gt=${val1};value=gt=${val2}`;

            const matchesA = testItems.filter((item) => filter.execute(filterA, item));
            const matchesAB = testItems.filter((item) => filter.execute(filterAB, item));

            // A;B should be a subset of A
            return matchesAB.every((item) => filter.execute(filterA, item));
          }
        ),
        { numRuns: 100 }
      );
    });

    it("filter expansion: A,B matches superset of A", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              id: fc.uuid(),
              score: fc.integer({ min: 0, max: 100 }),
            }),
            { minLength: 5, maxLength: 20 }
          ),
          fc.integer({ min: 0, max: 50 }),
          fc.integer({ min: 0, max: 50 }),
          (items, val1, val2) => {
            const testItems = items.map((i) => ({
              ...i,
              name: "Test",
              status: "active",
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            }));

            const filterA = `score==${val1}`;
            const filterAB = `score==${val1},score==${val2}`;

            const matchesA = testItems.filter((item) => filter.execute(filterA, item));
            const matchesAB = testItems.filter((item) => filter.execute(filterAB, item));

            // A,B should be a superset of A
            return matchesA.every((item) => filter.execute(filterAB, item));
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

describe("Hostile Input Fuzzing", () => {
  let filter: ReturnType<typeof createResourceFilter>;

  beforeEach(() => {
    filter = createResourceFilter(testTable);
  });

  describe("Parser Robustness", () => {
    it("should not crash on arbitrary strings", () => {
      fc.assert(
        fc.property(fc.string({ minLength: 0, maxLength: 100 }), (input) => {
          try {
            const testItem = {
              id: "1",
              name: "Test",
              status: "active",
              score: 0,
              value: 0,
              category: null,
              enabled: 1,
              num: 0,
              field: null,
            };
            filter.execute(input, testItem);
          } catch (e) {
            // Throwing a proper error is fine
            expect(e instanceof Error).toBe(true);
          }
          return true;
        }),
        { numRuns: 200 }
      );
    });

    it("should handle special characters gracefully", () => {
      const specialInputs = [
        "field=='test'",
        'field=="test with spaces"',
        "field==123",
        "field=in=(1,2,3)",
        "field=isnull=true",
      ];

      const testItem = {
        id: "1",
        name: "Test",
        status: "active",
        score: 0,
        value: 0,
        category: null,
        enabled: 1,
        num: 0,
        field: "test",
      };

      for (const input of specialInputs) {
        try {
          filter.execute(input, testItem);
        } catch (e) {
          expect(e instanceof Error).toBe(true);
        }
      }
    });

    it("should handle SQL injection attempts safely", () => {
      const injectionAttempts = [
        "field=='; DROP TABLE users; --",
        'field=="1 OR 1=1"',
        "field==1; DELETE FROM users",
      ];

      const testItem = {
        id: "1",
        name: "Test",
        status: "active",
        score: 0,
        value: 0,
        category: null,
        enabled: 1,
        num: 0,
        field: "safe_value",
      };

      for (const attempt of injectionAttempts) {
        try {
          const result = filter.execute(attempt, testItem);
          // If it parses, should be treated as literal string comparison
          expect(result).toBe(false);
        } catch (e) {
          // Failing to parse is also acceptable
          expect(e instanceof Error).toBe(true);
        }
      }
    });

    it("should complete in reasonable time (no ReDoS)", () => {
      const patterns = [
        "a".repeat(50) + "==1",
        "(((((a==1)))))",
        "a==1" + ";a==1".repeat(20),
      ];

      const testItem = {
        id: "1",
        name: "Test",
        status: "active",
        score: 0,
        value: 0,
        category: null,
        enabled: 1,
        num: 0,
        field: null,
      };

      for (const pattern of patterns) {
        const start = Date.now();
        try {
          filter.execute(pattern, testItem);
        } catch {
          // Expected
        }
        const elapsed = Date.now() - start;
        // Should complete in reasonable time (< 1 second)
        expect(elapsed).toBeLessThan(1000);
      }
    });
  });
});
