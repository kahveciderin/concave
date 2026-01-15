import { describe, it, expect, vi } from "vitest";
import { z } from "zod";
import {
  executeProcedure,
  defineProcedure,
  createTimestampHooks,
  composeHooks,
  executeBeforeCreate,
  executeAfterCreate,
} from "@/resource/procedures";
import { ProcedureContext, LifecycleHooks } from "@/resource/types";

describe("Procedures", () => {
  describe("executeProcedure", () => {
    it("should execute procedure with valid input", async () => {
      const procedure = defineProcedure({
        input: z.object({ name: z.string() }),
        output: z.object({ greeting: z.string() }),
        handler: async (ctx, input) => ({
          greeting: `Hello, ${input.name}!`,
        }),
      });

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      const result = await executeProcedure(procedure, ctx, { name: "World" });

      expect(result).toEqual({ greeting: "Hello, World!" });
    });

    it("should throw validation error for invalid input", async () => {
      const procedure = defineProcedure({
        input: z.object({ name: z.string() }),
        handler: async (ctx, input) => input,
      });

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      await expect(executeProcedure(procedure, ctx, { name: 123 })).rejects.toThrow();
    });

    it("should work without input schema", async () => {
      const procedure = defineProcedure({
        handler: async () => ({ success: true }),
      });

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      const result = await executeProcedure(procedure, ctx, undefined);

      expect(result).toEqual({ success: true });
    });

    it("should validate output if schema provided", async () => {
      const procedure = defineProcedure({
        output: z.object({ count: z.number() }),
        handler: async () => ({ count: "not a number" as any }),
      });

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      await expect(executeProcedure(procedure, ctx, undefined)).rejects.toThrow();
    });
  });

  describe("defineProcedure", () => {
    it("should create procedure definition", () => {
      const procedure = defineProcedure({
        input: z.object({ id: z.string() }),
        output: z.object({ success: z.boolean() }),
        writeEffects: [{ type: "update", resource: "users" }],
        handler: async () => ({ success: true }),
      });

      expect(procedure.input).toBeDefined();
      expect(procedure.output).toBeDefined();
      expect(procedure.writeEffects).toHaveLength(1);
      expect(typeof procedure.handler).toBe("function");
    });
  });

  describe("createTimestampHooks", () => {
    it("should add createdAt and updatedAt on create", async () => {
      const hooks = createTimestampHooks();
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      const result = await hooks.onBeforeCreate!(ctx, { name: "Test" } as any);

      expect(result).toHaveProperty("createdAt");
      expect(result).toHaveProperty("updatedAt");
      expect(result.createdAt).toBeInstanceOf(Date);
      expect(result.updatedAt).toBeInstanceOf(Date);
    });

    it("should add updatedAt on update", async () => {
      const hooks = createTimestampHooks();
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      const result = await hooks.onBeforeUpdate!(ctx, "1", { name: "Updated" } as any);

      expect(result).toHaveProperty("updatedAt");
      expect(result.updatedAt).toBeInstanceOf(Date);
    });
  });

  describe("composeHooks", () => {
    it("should compose multiple hook sets", async () => {
      const hook1: LifecycleHooks = {
        onBeforeCreate: async (ctx, data) => ({ ...data, hook1: true }),
      };

      const hook2: LifecycleHooks = {
        onBeforeCreate: async (ctx, data) => ({ ...data, hook2: true }),
      };

      const composed = composeHooks(hook1, hook2);
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      const result = await composed.onBeforeCreate!(ctx, { name: "Test" } as any);

      expect(result).toHaveProperty("hook1", true);
      expect(result).toHaveProperty("hook2", true);
    });

    it("should compose after hooks", async () => {
      const afterCalls: string[] = [];

      const hook1: LifecycleHooks = {
        onAfterCreate: async () => {
          afterCalls.push("hook1");
        },
      };

      const hook2: LifecycleHooks = {
        onAfterCreate: async () => {
          afterCalls.push("hook2");
        },
      };

      const composed = composeHooks(hook1, hook2);
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      await composed.onAfterCreate!(ctx, { id: "1" } as any);

      expect(afterCalls).toEqual(["hook1", "hook2"]);
    });

    it("should handle undefined hooks", async () => {
      const composed = composeHooks(undefined, { onBeforeCreate: async (ctx, data) => data });
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      const result = await composed.onBeforeCreate!(ctx, { name: "Test" } as any);
      expect(result).toEqual({ name: "Test" });
    });
  });

  describe("executeBeforeCreate", () => {
    it("should execute hook and return modified data", async () => {
      const hooks: LifecycleHooks = {
        onBeforeCreate: async (ctx, data) => ({ ...data, modified: true }),
      };

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      const result = await executeBeforeCreate(hooks, ctx, { name: "Test" } as any);

      expect(result).toHaveProperty("modified", true);
    });

    it("should return original data if no hook", async () => {
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      const data = { name: "Test" } as any;
      const result = await executeBeforeCreate(undefined, ctx, data);

      expect(result).toEqual(data);
    });

    it("should return original data if hook returns void", async () => {
      const hooks: LifecycleHooks = {
        onBeforeCreate: async () => {},
      };

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      const data = { name: "Test" } as any;
      const result = await executeBeforeCreate(hooks, ctx, data);

      expect(result).toEqual(data);
    });
  });

  describe("executeAfterCreate", () => {
    it("should execute hook", async () => {
      const afterMock = vi.fn();
      const hooks: LifecycleHooks = {
        onAfterCreate: afterMock,
      };

      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;
      await executeAfterCreate(hooks, ctx, { id: "1", name: "Test" } as any);

      expect(afterMock).toHaveBeenCalledTimes(1);
    });

    it("should not throw if no hook", async () => {
      const ctx = { db: {}, schema: {}, user: null, req: {} } as ProcedureContext;

      await expect(
        executeAfterCreate(undefined, ctx, { id: "1" } as any)
      ).resolves.toBeUndefined();
    });
  });
});
