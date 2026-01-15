import { describe, it, expect, vi, beforeEach } from "vitest";
import { FetchTransport, TransportError } from "@/client/transport";
import { InMemoryOfflineStorage, OfflineManager } from "@/client/offline";

describe("Client Library", () => {
  describe("FetchTransport", () => {
    let transport: FetchTransport;

    beforeEach(() => {
      transport = new FetchTransport({
        baseUrl: "http://localhost:3000",
        headers: { "X-Custom": "test" },
      });
    });

    it("should build URL with params", () => {
      const url = (transport as any).buildUrl("/users", {
        filter: 'status=="active"',
        limit: 20,
      });

      expect(url).toBe(
        'http://localhost:3000/users?filter=status%3D%3D%22active%22&limit=20'
      );
    });

    it("should handle array params", () => {
      const url = (transport as any).buildUrl("/users", {
        select: ["id", "name", "email"],
      });

      expect(url).toContain("select=id%2Cname%2Cemail");
    });

    it("should set and remove headers", () => {
      transport.setHeader("Authorization", "Bearer token");
      expect((transport as any).headers["Authorization"]).toBe("Bearer token");

      transport.removeHeader("Authorization");
      expect((transport as any).headers["Authorization"]).toBeUndefined();
    });
  });

  describe("TransportError", () => {
    it("should identify error types", () => {
      const notFound = new TransportError("Not found", 404, "NOT_FOUND");
      expect(notFound.isNotFound()).toBe(true);
      expect(notFound.isUnauthorized()).toBe(false);

      const unauthorized = new TransportError("Unauthorized", 401, "UNAUTHORIZED");
      expect(unauthorized.isUnauthorized()).toBe(true);

      const forbidden = new TransportError("Forbidden", 403, "FORBIDDEN");
      expect(forbidden.isForbidden()).toBe(true);

      const validation = new TransportError("Bad request", 400, "VALIDATION");
      expect(validation.isValidationError()).toBe(true);

      const rateLimited = new TransportError("Too many requests", 429, "RATE_LIMITED");
      expect(rateLimited.isRateLimited()).toBe(true);

      const serverError = new TransportError("Internal error", 500, "SERVER_ERROR");
      expect(serverError.isServerError()).toBe(true);
    });
  });

  describe("InMemoryOfflineStorage", () => {
    let storage: InMemoryOfflineStorage;

    beforeEach(() => {
      storage = new InMemoryOfflineStorage();
    });

    it("should store and retrieve mutations", async () => {
      const mutation = {
        id: "1",
        type: "create" as const,
        resource: "users",
        data: { name: "John" },
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending" as const,
      };

      await storage.addMutation(mutation);
      const mutations = await storage.getMutations();

      expect(mutations).toHaveLength(1);
      expect(mutations[0]).toEqual(mutation);
    });

    it("should update mutations", async () => {
      const mutation = {
        id: "1",
        type: "create" as const,
        resource: "users",
        data: { name: "John" },
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending" as const,
      };

      await storage.addMutation(mutation);
      await storage.updateMutation("1", { status: "processing" as const });

      const mutations = await storage.getMutations();
      expect(mutations[0].status).toBe("processing");
    });

    it("should remove mutations", async () => {
      await storage.addMutation({
        id: "1",
        type: "create" as const,
        resource: "users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending" as const,
      });

      await storage.addMutation({
        id: "2",
        type: "create" as const,
        resource: "users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending" as const,
      });

      await storage.removeMutation("1");
      const mutations = await storage.getMutations();

      expect(mutations).toHaveLength(1);
      expect(mutations[0].id).toBe("2");
    });

    it("should clear all mutations", async () => {
      await storage.addMutation({
        id: "1",
        type: "create" as const,
        resource: "users",
        timestamp: Date.now(),
        retryCount: 0,
        status: "pending" as const,
      });

      await storage.clear();
      const mutations = await storage.getMutations();

      expect(mutations).toHaveLength(0);
    });
  });

  describe("OfflineManager", () => {
    it("should queue mutations", async () => {
      const storage = new InMemoryOfflineStorage();
      const manager = new OfflineManager({
        config: { storage },
      });

      const id = await manager.queueMutation("create", "/users", { name: "John" });

      expect(id).toBeDefined();
      const pending = await manager.getPendingMutations();
      expect(pending).toHaveLength(1);
    });

    it("should track online status", () => {
      const manager = new OfflineManager({
        config: {},
      });

      expect(manager.getIsOnline()).toBe(true);
    });
  });
});
