import { describe, it, expect } from "vitest";
import {
  getAllowedFields,
  validateFieldAccess,
  validateFieldAccessOrThrow,
  applyReadablePolicy,
  stripNonWritableFields,
  isCapabilityEnabled,
  validateCapabilityOrThrow,
  DEFAULT_CAPABILITIES,
  FieldOperation,
} from "@/resource/capabilities";
import { FieldPolicies, ResourceCapabilities } from "@/resource/types";
import { ValidationError } from "@/resource/error";

describe("Capabilities System", () => {
  const mockColumns = ["id", "name", "email", "password", "createdAt"];

  describe("getAllowedFields", () => {
    it("should return all columns when no policy specified", () => {
      const result = getAllowedFields(undefined, "read", mockColumns);

      expect(result).toEqual(mockColumns);
    });

    it("should return readable fields for read operation", () => {
      const policies: FieldPolicies = {
        readable: ["id", "name", "email"],
      };

      const result = getAllowedFields(policies, "read", mockColumns);

      expect(result).toEqual(["id", "name", "email"]);
    });

    it("should return writable fields for write operation", () => {
      const policies: FieldPolicies = {
        writable: ["name", "email"],
      };

      const result = getAllowedFields(policies, "write", mockColumns);

      expect(result).toEqual(["name", "email"]);
    });

    it("should return filterable fields for filter operation", () => {
      const policies: FieldPolicies = {
        filterable: ["id", "name", "createdAt"],
      };

      const result = getAllowedFields(policies, "filter", mockColumns);

      expect(result).toEqual(["id", "name", "createdAt"]);
    });

    it("should return sortable fields for sort operation", () => {
      const policies: FieldPolicies = {
        sortable: ["name", "createdAt"],
      };

      const result = getAllowedFields(policies, "sort", mockColumns);

      expect(result).toEqual(["name", "createdAt"]);
    });

    it("should return aggregatable groupBy fields", () => {
      const policies: FieldPolicies = {
        aggregatable: {
          groupBy: ["status", "type"],
        },
      };

      const result = getAllowedFields(policies, "groupBy", mockColumns);

      expect(result).toEqual(["status", "type"]);
    });

    it("should return aggregatable metric fields", () => {
      const policies: FieldPolicies = {
        aggregatable: {
          metrics: ["price", "quantity"],
        },
      };

      const result = getAllowedFields(policies, "metric", mockColumns);

      expect(result).toEqual(["price", "quantity"]);
    });
  });

  describe("validateFieldAccess", () => {
    it("should return valid for allowed fields", () => {
      const policies: FieldPolicies = {
        readable: ["id", "name"],
      };

      const result = validateFieldAccess(
        policies,
        "read",
        ["id", "name"],
        mockColumns
      );

      expect(result.valid).toBe(true);
      expect(result.invalidFields).toHaveLength(0);
    });

    it("should return invalid for disallowed fields", () => {
      const policies: FieldPolicies = {
        readable: ["id"],
      };

      const result = validateFieldAccess(
        policies,
        "read",
        ["id", "name", "email"],
        mockColumns
      );

      expect(result.valid).toBe(false);
      expect(result.invalidFields).toContain("name");
      expect(result.invalidFields).toContain("email");
    });
  });

  describe("validateFieldAccessOrThrow", () => {
    it("should not throw for valid fields", () => {
      expect(() =>
        validateFieldAccessOrThrow(undefined, "read", ["id", "name"], mockColumns)
      ).not.toThrow();
    });

    it("should throw ValidationError for invalid fields", () => {
      const policies: FieldPolicies = {
        readable: ["id"],
      };

      expect(() =>
        validateFieldAccessOrThrow(policies, "read", ["name"], mockColumns)
      ).toThrow(ValidationError);
    });
  });

  describe("applyReadablePolicy", () => {
    it("should filter items to only readable fields", () => {
      const items = [
        { id: "1", name: "John", password: "secret" },
        { id: "2", name: "Jane", password: "hidden" },
      ];
      const policies: FieldPolicies = {
        readable: ["id", "name"],
      };

      const result = applyReadablePolicy(items, policies);

      expect(result[0]).toEqual({ id: "1", name: "John" });
      expect(result[1]).toEqual({ id: "2", name: "Jane" });
      expect(result[0]).not.toHaveProperty("password");
    });

    it("should return all fields when no policy", () => {
      const items = [{ id: "1", name: "John" }];

      const result = applyReadablePolicy(items, undefined);

      expect(result).toEqual(items);
    });
  });

  describe("stripNonWritableFields", () => {
    it("should remove non-writable fields from input", () => {
      const data = { id: "1", name: "John", role: "admin" };
      const policies: FieldPolicies = {
        writable: ["name"],
      };

      const result = stripNonWritableFields(data, policies);

      expect(result).toEqual({ name: "John" });
    });

    it("should return all fields when no policy", () => {
      const data = { id: "1", name: "John" };

      const result = stripNonWritableFields(data, undefined);

      expect(result).toEqual(data);
    });
  });

  describe("isCapabilityEnabled", () => {
    it("should return true for enabled capabilities", () => {
      const capabilities: ResourceCapabilities = {
        enableCreate: true,
        enableUpdate: true,
      };

      expect(isCapabilityEnabled(capabilities, "enableCreate")).toBe(true);
      expect(isCapabilityEnabled(capabilities, "enableUpdate")).toBe(true);
    });

    it("should return false for disabled capabilities", () => {
      const capabilities: ResourceCapabilities = {
        enableDelete: false,
        enableBatch: false,
      };

      expect(isCapabilityEnabled(capabilities, "enableDelete")).toBe(false);
      expect(isCapabilityEnabled(capabilities, "enableBatch")).toBe(false);
    });

    it("should return default true when not specified", () => {
      const capabilities: ResourceCapabilities = {};

      expect(isCapabilityEnabled(capabilities, "enableCreate")).toBe(true);
      expect(isCapabilityEnabled(capabilities, "enableAggregations")).toBe(true);
    });

    it("should use DEFAULT_CAPABILITIES when undefined", () => {
      expect(isCapabilityEnabled(undefined, "enableCreate")).toBe(true);
    });
  });

  describe("validateCapabilityOrThrow", () => {
    it("should not throw for enabled capability", () => {
      const capabilities: ResourceCapabilities = {
        enableCreate: true,
      };

      expect(() =>
        validateCapabilityOrThrow(capabilities, "enableCreate", "users")
      ).not.toThrow();
    });

    it("should throw ValidationError for disabled capability", () => {
      const capabilities: ResourceCapabilities = {
        enableCreate: false,
      };

      expect(() =>
        validateCapabilityOrThrow(capabilities, "enableCreate", "users")
      ).toThrow(ValidationError);
    });
  });

  describe("DEFAULT_CAPABILITIES", () => {
    it("should have all capabilities enabled by default", () => {
      expect(DEFAULT_CAPABILITIES.enableCreate).toBe(true);
      expect(DEFAULT_CAPABILITIES.enableUpdate).toBe(true);
      expect(DEFAULT_CAPABILITIES.enableDelete).toBe(true);
      expect(DEFAULT_CAPABILITIES.enableBatch).toBe(true);
      expect(DEFAULT_CAPABILITIES.enableAggregations).toBe(true);
      expect(DEFAULT_CAPABILITIES.enableSubscribe).toBe(true);
    });
  });
});
