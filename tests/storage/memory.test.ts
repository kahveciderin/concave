import { describe, it, expect, beforeEach } from "vitest";
import { createMemoryStorage, MemoryStorageAdapter } from "@/storage/memory";
import { Readable } from "stream";

describe("Memory Storage Adapter", () => {
  let storage: MemoryStorageAdapter;

  beforeEach(() => {
    storage = createMemoryStorage() as MemoryStorageAdapter;
  });

  describe("upload", () => {
    it("should upload a buffer", async () => {
      const data = Buffer.from("Hello, World!");
      const result = await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("test.txt");
      expect(result.size).toBe(data.length);
    });

    it("should upload a stream", async () => {
      const data = Buffer.from("Hello, Stream!");
      const stream = Readable.from(data);
      const result = await storage.upload("stream.txt", stream, {
        filename: "stream.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("stream.txt");
      expect(result.size).toBe(data.length);
    });

    it("should use default mime type if not provided", async () => {
      const data = Buffer.from("test");
      await storage.upload("test", data);

      const metadata = await storage.getMetadata("test");
      expect(metadata?.mimeType).toBe("application/octet-stream");
    });

    it("should derive filename from key if not provided", async () => {
      const data = Buffer.from("test");
      await storage.upload("path/to/file.txt", data);

      const metadata = await storage.getMetadata("path/to/file.txt");
      expect(metadata?.filename).toBe("file.txt");
    });

    it("should update existing file", async () => {
      await storage.upload("test.txt", Buffer.from("original"));
      await storage.upload("test.txt", Buffer.from("updated content"));

      const downloaded = await storage.download("test.txt");
      expect(downloaded.toString()).toBe("updated content");
    });

    it("should preserve createdAt on update", async () => {
      await storage.upload("test.txt", Buffer.from("original"));
      const original = await storage.getMetadata("test.txt");

      await new Promise((resolve) => setTimeout(resolve, 10));
      await storage.upload("test.txt", Buffer.from("updated"));
      const updated = await storage.getMetadata("test.txt");

      expect(updated?.createdAt.getTime()).toBe(original?.createdAt.getTime());
      expect(updated?.updatedAt?.getTime()).toBeGreaterThan(original?.createdAt.getTime()!);
    });

    it("should store custom metadata", async () => {
      await storage.upload("test.txt", Buffer.from("data"), {
        customMetadata: { foo: "bar" },
      });

      const metadata = await storage.getMetadata("test.txt");
      expect(metadata?.customMetadata).toEqual({ foo: "bar" });
    });
  });

  describe("download", () => {
    it("should download a file", async () => {
      const data = Buffer.from("Hello, World!");
      await storage.upload("test.txt", data);

      const downloaded = await storage.download("test.txt");
      expect(downloaded.toString()).toBe("Hello, World!");
    });

    it("should throw for non-existent file", async () => {
      await expect(storage.download("nonexistent.txt")).rejects.toThrow(
        "File not found: nonexistent.txt"
      );
    });
  });

  describe("downloadStream", () => {
    it("should return a readable stream", async () => {
      const data = Buffer.from("Hello, Stream!");
      await storage.upload("test.txt", data);

      const stream = await storage.downloadStream("test.txt");
      const chunks: Buffer[] = [];
      for await (const chunk of stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const result = Buffer.concat(chunks);
      expect(result.toString()).toBe("Hello, Stream!");
    });

    it("should throw for non-existent file", async () => {
      await expect(storage.downloadStream("nonexistent.txt")).rejects.toThrow(
        "File not found: nonexistent.txt"
      );
    });
  });

  describe("delete", () => {
    it("should delete a file", async () => {
      await storage.upload("test.txt", Buffer.from("data"));
      await storage.delete("test.txt");

      expect(await storage.exists("test.txt")).toBe(false);
    });

    it("should not throw for non-existent file", async () => {
      await expect(storage.delete("nonexistent.txt")).resolves.not.toThrow();
    });
  });

  describe("deleteMany", () => {
    it("should delete multiple files", async () => {
      await storage.upload("file1.txt", Buffer.from("1"));
      await storage.upload("file2.txt", Buffer.from("2"));
      await storage.upload("file3.txt", Buffer.from("3"));

      await storage.deleteMany(["file1.txt", "file2.txt"]);

      expect(await storage.exists("file1.txt")).toBe(false);
      expect(await storage.exists("file2.txt")).toBe(false);
      expect(await storage.exists("file3.txt")).toBe(true);
    });

    it("should not throw for non-existent files", async () => {
      await expect(storage.deleteMany(["a", "b", "c"])).resolves.not.toThrow();
    });
  });

  describe("exists", () => {
    it("should return true for existing file", async () => {
      await storage.upload("test.txt", Buffer.from("data"));

      expect(await storage.exists("test.txt")).toBe(true);
    });

    it("should return false for non-existent file", async () => {
      expect(await storage.exists("nonexistent.txt")).toBe(false);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata for existing file", async () => {
      const data = Buffer.from("Hello, World!");
      await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      const metadata = await storage.getMetadata("test.txt");
      expect(metadata).toMatchObject({
        key: "test.txt",
        filename: "test.txt",
        mimeType: "text/plain",
        size: data.length,
      });
      expect(metadata?.createdAt).toBeInstanceOf(Date);
    });

    it("should return null for non-existent file", async () => {
      const metadata = await storage.getMetadata("nonexistent.txt");
      expect(metadata).toBeNull();
    });
  });

  describe("getUrl", () => {
    it("should return null (memory adapter has no URLs)", () => {
      expect(storage.getUrl("test.txt")).toBeNull();
    });
  });

  describe("getDownloadUrl", () => {
    it("should return null (memory adapter does not support presigned URLs)", async () => {
      await storage.upload("test.txt", Buffer.from("data"));
      expect(await storage.getDownloadUrl("test.txt")).toBeNull();
    });
  });

  describe("getUploadUrl", () => {
    it("should return null (memory adapter does not support presigned URLs)", async () => {
      expect(await storage.getUploadUrl("test.txt")).toBeNull();
    });
  });

  describe("supportsPresignedUrls", () => {
    it("should return false", () => {
      expect(storage.supportsPresignedUrls()).toBe(false);
    });
  });

  describe("clear", () => {
    it("should remove all files", async () => {
      await storage.upload("file1.txt", Buffer.from("1"));
      await storage.upload("file2.txt", Buffer.from("2"));

      storage.clear();

      expect(await storage.exists("file1.txt")).toBe(false);
      expect(await storage.exists("file2.txt")).toBe(false);
    });
  });

  describe("getKeys", () => {
    it("should return all keys", async () => {
      await storage.upload("file1.txt", Buffer.from("1"));
      await storage.upload("path/file2.txt", Buffer.from("2"));

      const keys = storage.getKeys();
      expect(keys).toContain("file1.txt");
      expect(keys).toContain("path/file2.txt");
    });

    it("should return empty array when no files", () => {
      expect(storage.getKeys()).toEqual([]);
    });
  });
});
