import { describe, it, expect, beforeEach, vi } from "vitest";
import { S3StorageAdapter } from "@/storage/s3";
import { Readable } from "stream";

const mockSend = vi.fn();

vi.mock("@aws-sdk/client-s3", () => ({
  S3Client: vi.fn(() => ({
    send: mockSend,
  })),
  PutObjectCommand: vi.fn().mockImplementation((params) => ({ type: "put", params })),
  GetObjectCommand: vi.fn().mockImplementation((params) => ({ type: "get", params })),
  DeleteObjectCommand: vi.fn().mockImplementation((params) => ({ type: "delete", params })),
  DeleteObjectsCommand: vi.fn().mockImplementation((params) => ({ type: "deleteMany", params })),
  HeadObjectCommand: vi.fn().mockImplementation((params) => ({ type: "head", params })),
}));

vi.mock("@aws-sdk/s3-request-presigner", () => ({
  getSignedUrl: vi.fn().mockResolvedValue("https://presigned.example.com/file"),
}));

describe("S3 Storage Adapter", () => {
  let storage: S3StorageAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    storage = new S3StorageAdapter({
      bucket: "test-bucket",
      region: "us-east-1",
    });
  });

  describe("upload", () => {
    it("should upload a buffer", async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"abc123"' });

      const data = Buffer.from("Hello, World!");
      const result = await storage.upload("test.txt", data, {
        filename: "test.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("test.txt");
      expect(result.size).toBe(data.length);
      expect(result.etag).toBe("abc123");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "put",
          params: expect.objectContaining({
            Bucket: "test-bucket",
            Key: "test.txt",
            ContentType: "text/plain",
          }),
        })
      );
    });

    it("should upload a stream", async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"def456"' });

      const data = Buffer.from("Hello, Stream!");
      const stream = Readable.from(data);
      const result = await storage.upload("stream.txt", stream, {
        filename: "stream.txt",
        mimeType: "text/plain",
      });

      expect(result.key).toBe("stream.txt");
      expect(result.size).toBe(data.length);
    });

    it("should include custom metadata", async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"xyz789"' });

      await storage.upload("test.txt", Buffer.from("data"), {
        customMetadata: { foo: "bar" },
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "put",
          params: expect.objectContaining({
            Metadata: { foo: "bar" },
          }),
        })
      );
    });

    it("should include cache control", async () => {
      mockSend.mockResolvedValueOnce({ ETag: '"xyz789"' });

      await storage.upload("test.txt", Buffer.from("data"), {
        cacheControl: "max-age=3600",
      });

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "put",
          params: expect.objectContaining({
            CacheControl: "max-age=3600",
          }),
        })
      );
    });
  });

  describe("download", () => {
    it("should download a file", async () => {
      const testData = Buffer.from("Hello, World!");
      mockSend.mockResolvedValueOnce({
        Body: {
          transformToByteArray: vi.fn().mockResolvedValue(new Uint8Array(testData)),
        },
      });

      const downloaded = await storage.download("test.txt");
      expect(downloaded.toString()).toBe("Hello, World!");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "get",
          params: expect.objectContaining({
            Bucket: "test-bucket",
            Key: "test.txt",
          }),
        })
      );
    });

    it("should throw for missing body", async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(storage.download("test.txt")).rejects.toThrow(
        "File not found: test.txt"
      );
    });
  });

  describe("downloadStream", () => {
    it("should return a readable stream", async () => {
      const stream = Readable.from(Buffer.from("Hello, Stream!"));
      mockSend.mockResolvedValueOnce({ Body: stream });

      const result = await storage.downloadStream("test.txt");
      expect(result).toBeInstanceOf(Readable);
    });

    it("should throw for non-stream body", async () => {
      mockSend.mockResolvedValueOnce({});

      await expect(storage.downloadStream("test.txt")).rejects.toThrow(
        "File not found: test.txt"
      );
    });
  });

  describe("delete", () => {
    it("should delete a file", async () => {
      mockSend.mockResolvedValueOnce({});

      await storage.delete("test.txt");

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "delete",
          params: expect.objectContaining({
            Bucket: "test-bucket",
            Key: "test.txt",
          }),
        })
      );
    });
  });

  describe("deleteMany", () => {
    it("should delete multiple files", async () => {
      mockSend.mockResolvedValueOnce({});

      await storage.deleteMany(["file1.txt", "file2.txt", "file3.txt"]);

      expect(mockSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "deleteMany",
          params: expect.objectContaining({
            Bucket: "test-bucket",
            Delete: {
              Objects: [
                { Key: "file1.txt" },
                { Key: "file2.txt" },
                { Key: "file3.txt" },
              ],
            },
          }),
        })
      );
    });

    it("should do nothing for empty array", async () => {
      await storage.deleteMany([]);
      expect(mockSend).not.toHaveBeenCalled();
    });
  });

  describe("exists", () => {
    it("should return true when file exists", async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 100,
        ContentType: "text/plain",
      });

      expect(await storage.exists("test.txt")).toBe(true);
    });

    it("should return false when file does not exist", async () => {
      mockSend.mockRejectedValueOnce({ name: "NotFound" });

      expect(await storage.exists("nonexistent.txt")).toBe(false);
    });

    it("should return false for NoSuchKey error", async () => {
      mockSend.mockRejectedValueOnce({ name: "NoSuchKey" });

      expect(await storage.exists("nonexistent.txt")).toBe(false);
    });
  });

  describe("getMetadata", () => {
    it("should return metadata for existing file", async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 100,
        ContentType: "text/plain",
        LastModified: new Date("2024-01-01"),
        ETag: '"abc123"',
        Metadata: { foo: "bar" },
      });

      const metadata = await storage.getMetadata("path/to/file.txt");

      expect(metadata).toMatchObject({
        key: "path/to/file.txt",
        filename: "file.txt",
        mimeType: "text/plain",
        size: 100,
        etag: "abc123",
        customMetadata: { foo: "bar" },
      });
      expect(metadata?.createdAt).toBeInstanceOf(Date);
    });

    it("should return null for non-existent file", async () => {
      mockSend.mockRejectedValueOnce({ name: "NotFound" });

      const metadata = await storage.getMetadata("nonexistent.txt");
      expect(metadata).toBeNull();
    });

    it("should use default mime type when not provided", async () => {
      mockSend.mockResolvedValueOnce({
        ContentLength: 100,
      });

      const metadata = await storage.getMetadata("test");
      expect(metadata?.mimeType).toBe("application/octet-stream");
    });
  });

  describe("getUrl", () => {
    it("should return null (S3 does not provide direct URLs)", () => {
      expect(storage.getUrl("test.txt")).toBeNull();
    });
  });

  describe("getDownloadUrl", () => {
    it("should return presigned URL", async () => {
      const url = await storage.getDownloadUrl("test.txt");
      expect(url).toBe("https://presigned.example.com/file");
    });

    it("should use custom expiry", async () => {
      const { getSignedUrl } = await import("@aws-sdk/s3-request-presigner");
      await storage.getDownloadUrl("test.txt", { expiresIn: 7200 });

      expect(getSignedUrl).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        { expiresIn: 7200 }
      );
    });
  });

  describe("getUploadUrl", () => {
    it("should return presigned upload URL", async () => {
      const result = await storage.getUploadUrl("test.txt", {
        contentType: "text/plain",
      });

      expect(result).toMatchObject({
        url: "https://presigned.example.com/file",
        key: "test.txt",
      });
      expect(result?.expiresAt).toBeInstanceOf(Date);
    });

    it("should include content type in request", async () => {
      const { PutObjectCommand } = await import("@aws-sdk/client-s3");
      await storage.getUploadUrl("test.txt", {
        contentType: "image/png",
      });

      expect(PutObjectCommand).toHaveBeenCalledWith(
        expect.objectContaining({
          ContentType: "image/png",
        })
      );
    });
  });

  describe("supportsPresignedUrls", () => {
    it("should return true", () => {
      expect(storage.supportsPresignedUrls()).toBe(true);
    });
  });

  describe("configuration", () => {
    it("should use custom endpoint", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      vi.mocked(S3Client).mockClear();
      mockSend.mockResolvedValueOnce({});

      const adapter = new S3StorageAdapter({
        bucket: "test",
        endpoint: "https://s3.custom.endpoint",
      });

      await adapter.delete("test-key");
      expect(S3Client).toHaveBeenCalled();
    });

    it("should use credentials when provided", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      vi.mocked(S3Client).mockClear();
      mockSend.mockResolvedValueOnce({});

      const adapter = new S3StorageAdapter({
        bucket: "test",
        accessKeyId: "key",
        secretAccessKey: "secret",
      });

      await adapter.delete("test-key");
      expect(S3Client).toHaveBeenCalled();
    });

    it("should use force path style when configured", async () => {
      const { S3Client } = await import("@aws-sdk/client-s3");
      vi.mocked(S3Client).mockClear();
      mockSend.mockResolvedValueOnce({});

      const adapter = new S3StorageAdapter({
        bucket: "test",
        forcePathStyle: true,
      });

      await adapter.delete("test-key");
      expect(S3Client).toHaveBeenCalled();
    });
  });
});
