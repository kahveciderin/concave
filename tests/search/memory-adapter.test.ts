import { describe, it, expect, beforeEach } from "vitest";
import { createMemorySearchAdapter } from "@/search";

describe("Memory Search Adapter", () => {
  let adapter: ReturnType<typeof createMemorySearchAdapter>;

  beforeEach(() => {
    adapter = createMemorySearchAdapter();
  });

  describe("index", () => {
    it("should index a document", async () => {
      await adapter.index("items", "1", { id: "1", title: "Hello World" });

      const index = adapter.getIndex("items");
      expect(index?.get("1")).toEqual({ id: "1", title: "Hello World" });
    });

    it("should create index if not exists", async () => {
      expect(adapter.getIndex("items")).toBeUndefined();

      await adapter.index("items", "1", { id: "1" });

      expect(adapter.getIndex("items")).toBeDefined();
    });

    it("should update existing document", async () => {
      await adapter.index("items", "1", { id: "1", title: "Original" });
      await adapter.index("items", "1", { id: "1", title: "Updated" });

      const index = adapter.getIndex("items");
      expect(index?.get("1")).toEqual({ id: "1", title: "Updated" });
    });

    it("should store document copy (not reference)", async () => {
      const doc = { id: "1", title: "Hello" };
      await adapter.index("items", "1", doc);

      doc.title = "Modified";

      const index = adapter.getIndex("items");
      expect(index?.get("1")?.title).toBe("Hello");
    });
  });

  describe("delete", () => {
    it("should remove document from index", async () => {
      await adapter.index("items", "1", { id: "1" });
      await adapter.delete("items", "1");

      const index = adapter.getIndex("items");
      expect(index?.get("1")).toBeUndefined();
    });

    it("should not throw for non-existent document", async () => {
      await expect(adapter.delete("items", "999")).resolves.not.toThrow();
    });

    it("should not throw for non-existent index", async () => {
      await expect(adapter.delete("nonexistent", "1")).resolves.not.toThrow();
    });
  });

  describe("search", () => {
    beforeEach(async () => {
      await adapter.index("items", "1", { id: "1", title: "Important Task", description: "Do this now" });
      await adapter.index("items", "2", { id: "2", title: "Normal Task", description: "Do this later" });
      await adapter.index("items", "3", { id: "3", title: "Another Important Item", description: "Critical" });
    });

    it("should find documents matching query", async () => {
      const result = await adapter.search("items", { query: "important" });

      expect(result.hits).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it("should return empty results for no matches", async () => {
      const result = await adapter.search("items", { query: "nonexistent" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("should return empty results for non-existent index", async () => {
      const result = await adapter.search("nonexistent", { query: "test" });

      expect(result.hits).toHaveLength(0);
      expect(result.total).toBe(0);
    });

    it("should search all fields by default", async () => {
      const result = await adapter.search("items", { query: "critical" });

      expect(result.hits).toHaveLength(1);
      expect(result.hits[0]?.source.id).toBe("3");
    });

    it("should search only specified fields", async () => {
      const result = await adapter.search("items", { query: "critical", fields: ["title"] });

      expect(result.hits).toHaveLength(0);
    });

    it("should match case-insensitively", async () => {
      const result = await adapter.search("items", { query: "IMPORTANT" });

      expect(result.hits).toHaveLength(2);
    });

    it("should match partial strings", async () => {
      const result = await adapter.search("items", { query: "import" });

      expect(result.hits).toHaveLength(2);
    });

    describe("pagination", () => {
      it("should respect size parameter", async () => {
        const result = await adapter.search("items", { query: "task", size: 1 });

        expect(result.hits).toHaveLength(1);
      });

      it("should respect from parameter", async () => {
        const result1 = await adapter.search("items", { query: "task", size: 1, from: 0 });
        const result2 = await adapter.search("items", { query: "task", size: 1, from: 1 });

        expect(result1.hits[0]?.id).not.toBe(result2.hits[0]?.id);
      });

      it("should return correct total with pagination", async () => {
        const result = await adapter.search("items", { query: "task", size: 1 });

        expect(result.hits).toHaveLength(1);
        expect(result.total).toBe(2);
      });
    });

    describe("highlights", () => {
      it("should return highlights when requested", async () => {
        const result = await adapter.search("items", { query: "important", highlight: true });

        expect(result.hits[0]?.highlights).toBeDefined();
      });

      it("should not return highlights by default", async () => {
        const result = await adapter.search("items", { query: "important" });

        expect(result.hits[0]?.highlights).toBeUndefined();
      });
    });

    describe("hit structure", () => {
      it("should include id, score, and source", async () => {
        const result = await adapter.search("items", { query: "important" });
        const hit = result.hits[0];

        expect(hit).toHaveProperty("id");
        expect(hit).toHaveProperty("score");
        expect(hit).toHaveProperty("source");
      });

      it("should have positive scores", async () => {
        const result = await adapter.search("items", { query: "important" });

        for (const hit of result.hits) {
          expect(hit.score).toBeGreaterThan(0);
        }
      });
    });

    describe("number field search", () => {
      beforeEach(async () => {
        await adapter.index("numbers", "1", { id: "1", count: 123 });
        await adapter.index("numbers", "2", { id: "2", count: 456 });
      });

      it("should match number fields as strings", async () => {
        const result = await adapter.search("numbers", { query: "123" });

        expect(result.hits).toHaveLength(1);
        expect(result.hits[0]?.source.count).toBe(123);
      });
    });
  });

  describe("createIndex", () => {
    it("should create an empty index", async () => {
      await adapter.createIndex("items", { properties: {} });

      expect(adapter.getIndex("items")).toBeDefined();
      expect(adapter.getIndex("items")?.size).toBe(0);
    });

    it("should not overwrite existing index", async () => {
      await adapter.index("items", "1", { id: "1" });
      await adapter.createIndex("items", { properties: {} });

      const index = adapter.getIndex("items");
      expect(index?.size).toBe(1);
    });
  });

  describe("deleteIndex", () => {
    it("should remove the entire index", async () => {
      await adapter.index("items", "1", { id: "1" });
      await adapter.deleteIndex("items");

      expect(adapter.getIndex("items")).toBeUndefined();
    });

    it("should not throw for non-existent index", async () => {
      await expect(adapter.deleteIndex("nonexistent")).resolves.not.toThrow();
    });
  });

  describe("indexExists", () => {
    it("should return false for non-existent index", async () => {
      expect(await adapter.indexExists("items")).toBe(false);
    });

    it("should return true for existing index", async () => {
      await adapter.index("items", "1", { id: "1" });

      expect(await adapter.indexExists("items")).toBe(true);
    });

    it("should return true after createIndex", async () => {
      await adapter.createIndex("items", { properties: {} });

      expect(await adapter.indexExists("items")).toBe(true);
    });

    it("should return false after deleteIndex", async () => {
      await adapter.index("items", "1", { id: "1" });
      await adapter.deleteIndex("items");

      expect(await adapter.indexExists("items")).toBe(false);
    });
  });

  describe("getAllIndices", () => {
    it("should return all indices", async () => {
      await adapter.index("items1", "1", { id: "1" });
      await adapter.index("items2", "1", { id: "1" });

      const indices = adapter.getAllIndices();
      expect(indices.has("items1")).toBe(true);
      expect(indices.has("items2")).toBe(true);
    });

    it("should return empty map when no indices", () => {
      const indices = adapter.getAllIndices();

      expect(indices.size).toBe(0);
    });
  });
});
