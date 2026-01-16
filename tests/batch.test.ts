import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  generateConfirmToken,
  validateConfirmToken,
  createDryRunResult,
  checkBatchGuard,
  validateBatchOperation,
  BatchOperation,
  BatchGuardConfig,
  CONFIRM_TOKEN_HEADER,
  DANGEROUS_OPERATION_HEADER,
} from "@/resource/batch";
import { ValidationError } from "@/resource/error";

describe("Batch Safety System", () => {
  describe("generateConfirmToken", () => {
    it("should generate valid token", () => {
      const token = generateConfirmToken(
        "batch_delete",
        "status==inactive",
        ["1", "2", "3"]
      );

      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(0);
    });

    it("should generate different tokens for different operations", () => {
      const token1 = generateConfirmToken("batch_delete", "filter1", ["1"]);
      const token2 = generateConfirmToken("batch_update", "filter1", ["1"]);

      expect(token1).not.toBe(token2);
    });

    it("should generate different tokens for different filters", () => {
      const token1 = generateConfirmToken("batch_delete", "status==active", ["1"]);
      const token2 = generateConfirmToken("batch_delete", "status==inactive", ["1"]);

      expect(token1).not.toBe(token2);
    });
  });

  describe("validateConfirmToken", () => {
    it("should validate correct token", () => {
      const operation: BatchOperation = "batch_delete";
      const filter = "status==inactive";
      const affectedIds = ["1", "2", "3"];

      const token = generateConfirmToken(operation, filter, affectedIds);
      const result = validateConfirmToken(token, operation, filter);

      expect(result.valid).toBe(true);
      expect(result.payload?.affectedIds).toEqual(affectedIds);
    });

    it("should reject token with wrong operation", () => {
      const token = generateConfirmToken("batch_delete", "filter", ["1"]);
      const result = validateConfirmToken(token, "batch_update", "filter");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("operation_mismatch");
    });

    it("should reject token with wrong filter", () => {
      const token = generateConfirmToken("batch_delete", "filter1", ["1"]);
      const result = validateConfirmToken(token, "batch_delete", "filter2");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("filter_mismatch");
    });

    it("should reject malformed token", () => {
      const result = validateConfirmToken("invalid-token", "batch_delete", "filter");

      expect(result.valid).toBe(false);
      expect(result.error).toBe("malformed");
    });

    it("should handle undefined filter", () => {
      const token = generateConfirmToken("batch_delete", undefined, ["1"]);
      const result = validateConfirmToken(token, "batch_delete", undefined);

      expect(result.valid).toBe(true);
    });
  });

  describe("createDryRunResult", () => {
    it("should create dry run result with all fields", () => {
      const items = [
        { id: "1", name: "Item 1" },
        { id: "2", name: "Item 2" },
        { id: "3", name: "Item 3" },
      ];

      const result = createDryRunResult(
        "batch_delete",
        "status==inactive",
        items,
        (item) => item.id
      );

      expect(result.count).toBe(3);
      expect(result.sampleIds).toEqual(["1", "2", "3"]);
      expect(result.confirmToken).toBeDefined();
      expect(result.message).toContain("3 records");
      expect(result.operation).toBe("batch_delete");
      expect(result.filter).toBe("status==inactive");
    });

    it("should limit sample IDs to specified size", () => {
      const items = Array.from({ length: 20 }, (_, i) => ({ id: String(i) }));
      
      const result = createDryRunResult(
        "batch_delete",
        "filter",
        items,
        (item) => item.id,
        10
      );

      expect(result.sampleIds).toHaveLength(10);
      expect(result.sampleItems).toHaveLength(10);
    });

    it("should include correct message", () => {
      const items = [{ id: "1" }, { id: "2" }];
      
      const result = createDryRunResult(
        "batch_delete",
        "filter",
        items,
        (item) => item.id
      );

      expect(result.message).toContain("2 records");
      expect(result.message).toContain("confirmToken");
    });
  });

  describe("checkBatchGuard", () => {
    it("should allow operation with confirm token", () => {
      const token = generateConfirmToken("batch_delete", "filter", ["1"]);

      expect(() => checkBatchGuard(token, false, 5)).not.toThrow();
    });

    it("should allow operation with dangerous header", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      expect(() => checkBatchGuard(undefined, true, 100)).not.toThrow();

      consoleSpy.mockRestore();
    });

    it("should reject operation without confirmation", () => {
      expect(() => checkBatchGuard(undefined, false, 100)).toThrow(ValidationError);
    });

    it("should reject operation exceeding max records", () => {
      const token = generateConfirmToken("batch_delete", "filter", ["1"]);

      expect(() =>
        checkBatchGuard(token, false, 2000, { maxAffectedRecords: 1000 })
      ).toThrow(ValidationError);
    });

    it("should allow operation when confirmation not required", () => {
      expect(() =>
        checkBatchGuard(undefined, false, 100, { requireConfirmation: false })
      ).not.toThrow();
    });
  });

  describe("validateBatchOperation", () => {
    it("should not require dry run for operations without filter", () => {
      const result = validateBatchOperation(
        "batch_delete",
        undefined,
        undefined,
        false
      );

      expect(result.requiresDryRun).toBe(false);
    });

    it("should require dry run for filter-based operations", () => {
      const result = validateBatchOperation(
        "batch_delete",
        "status==inactive",
        undefined,
        false
      );

      expect(result.requiresDryRun).toBe(true);
    });

    it("should allow with valid confirm token", () => {
      const token = generateConfirmToken("batch_delete", "filter", ["1"]);

      const result = validateBatchOperation(
        "batch_delete",
        "filter",
        token,
        false
      );

      expect(result.requiresDryRun).toBe(false);
      expect(result.validatedPayload).toBeDefined();
    });

    it("should allow with dangerous header", () => {
      const consoleSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

      const result = validateBatchOperation(
        "batch_delete",
        "filter",
        undefined,
        true
      );

      expect(result.requiresDryRun).toBe(false);

      consoleSpy.mockRestore();
    });

    it("should throw for invalid token", () => {
      expect(() =>
        validateBatchOperation(
          "batch_delete",
          "filter",
          "invalid-token",
          false
        )
      ).toThrow(ValidationError);
    });
  });

  describe("Constants", () => {
    it("should export correct header names", () => {
      expect(CONFIRM_TOKEN_HEADER).toBe("x-confirm-token");
      expect(DANGEROUS_OPERATION_HEADER).toBe("x-dangerous-operation");
    });
  });
});
