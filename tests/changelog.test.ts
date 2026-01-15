import { describe, it, expect, beforeEach, beforeAll, afterAll } from "vitest";
import {
  ChangelogManager,
  recordCreate,
  recordUpdate,
  recordDelete,
  changelog,
} from "@/resource/changelog";
import { createMemoryKV, setGlobalKV, KVAdapter } from "@/kv";

let kv: KVAdapter;

describe("Changelog", () => {
  beforeAll(async () => {
    kv = createMemoryKV("test-changelog");
    await kv.connect();
    setGlobalKV(kv);
  });

  afterAll(async () => {
    await kv.disconnect();
  });

  describe("ChangelogManager", () => {
    let manager: ChangelogManager;

    beforeEach(async () => {
      manager = new ChangelogManager({ maxEntries: 100 });
      await manager.clear();
    });

    it("should append entries with incrementing sequence numbers", async () => {
      const entry1 = await manager.append({
        resource: "users",
        type: "create",
        objectId: "1",
        object: { id: "1", name: "John" },
        timestamp: Date.now(),
      });

      const entry2 = await manager.append({
        resource: "users",
        type: "create",
        objectId: "2",
        object: { id: "2", name: "Jane" },
        timestamp: Date.now(),
      });

      expect(entry1.seq).toBe(1);
      expect(entry2.seq).toBe(2);
    });

    it("should get entries since a specific sequence", async () => {
      await manager.append({
        resource: "users",
        type: "create",
        objectId: "1",
        timestamp: Date.now(),
      });

      await manager.append({
        resource: "posts",
        type: "create",
        objectId: "1",
        timestamp: Date.now(),
      });

      await manager.append({
        resource: "users",
        type: "update",
        objectId: "1",
        timestamp: Date.now(),
      });

      const userEntries = await manager.getEntriesSince("users", 0);
      expect(userEntries).toHaveLength(2);

      const postEntries = await manager.getEntriesSince("posts", 0);
      expect(postEntries).toHaveLength(1);

      const entriesSince1 = await manager.getEntriesSince("users", 1);
      expect(entriesSince1).toHaveLength(1);
    });

    it("should prune old entries when exceeding maxEntries", async () => {
      const smallManager = new ChangelogManager({ maxEntries: 3 });
      await smallManager.clear();

      for (let i = 0; i < 5; i++) {
        await smallManager.append({
          resource: "users",
          type: "create",
          objectId: String(i),
          timestamp: Date.now(),
        });
      }

      const count = await smallManager.getEntryCount();
      expect(count).toBe(3);

      const minSeq = await smallManager.getMinAvailableSequence();
      expect(minSeq).toBe(3);
    });

    it("should detect when invalidation is needed", async () => {
      for (let i = 0; i < 5; i++) {
        await manager.append({
          resource: "users",
          type: "create",
          objectId: String(i),
          timestamp: Date.now(),
        });
      }

      expect(await manager.needsInvalidation(0)).toBe(false);
      expect(await manager.needsInvalidation(3)).toBe(false);

      const smallManager = new ChangelogManager({ maxEntries: 2 });
      await smallManager.clear();

      for (let i = 0; i < 5; i++) {
        await smallManager.append({
          resource: "users",
          type: "create",
          objectId: String(i),
          timestamp: Date.now(),
        });
      }

      expect(await smallManager.needsInvalidation(1)).toBe(true);
      expect(await smallManager.needsInvalidation(4)).toBe(false);
    });

    it("should get current sequence", async () => {
      // Note: sequence is shared with previous tests via KV, so we clear first
      await manager.clear();

      expect(await manager.getCurrentSequence()).toBe(0);

      await manager.append({
        resource: "users",
        type: "create",
        objectId: "1",
        timestamp: Date.now(),
      });

      expect(await manager.getCurrentSequence()).toBe(1);
    });

    it("should clear entries", async () => {
      await manager.append({
        resource: "users",
        type: "create",
        objectId: "1",
        timestamp: Date.now(),
      });

      await manager.clear();

      const count = await manager.getEntryCount();
      expect(count).toBe(0);
    });
  });

  describe("Helper functions", () => {
    beforeEach(async () => {
      await changelog.clear();
    });

    it("should record create", async () => {
      const entry = await recordCreate("users", "1", { id: "1", name: "John" });

      expect(entry.type).toBe("create");
      expect(entry.resource).toBe("users");
      expect(entry.objectId).toBe("1");
      expect(entry.object).toEqual({ id: "1", name: "John" });
    });

    it("should record update", async () => {
      const entry = await recordUpdate(
        "users",
        "1",
        { id: "1", name: "John Updated" },
        { id: "1", name: "John" }
      );

      expect(entry.type).toBe("update");
      expect(entry.object).toEqual({ id: "1", name: "John Updated" });
      expect(entry.previousObject).toEqual({ id: "1", name: "John" });
    });

    it("should record delete", async () => {
      const entry = await recordDelete("users", "1", { id: "1", name: "John" });

      expect(entry.type).toBe("delete");
      expect(entry.previousObject).toEqual({ id: "1", name: "John" });
    });
  });
});
