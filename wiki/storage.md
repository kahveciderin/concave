# Storage (File Uploads)

Concave provides a comprehensive file upload system with support for local filesystem storage, S3-compatible storage, and an in-memory adapter for testing. Files are first-class resources that can be related to other resources.

## Quick Start

```typescript
import express from "express";
import { useFileResource, initializeStorage } from "@kahveciderin/concave";

const app = express();

// Initialize local storage
initializeStorage({
  type: "local",
  local: {
    basePath: "./uploads",
    baseUrl: "/uploads",
  },
});

// Serve uploaded files
app.use("/uploads", express.static("./uploads"));

// Create the file resource
app.use("/api/files", useFileResource(filesTable, {
  db,
  schema: filesTable,
  id: filesTable.id,
  allowedMimeTypes: ["image/jpeg", "image/png", "image/gif"],
  maxFileSize: 5 * 1024 * 1024, // 5MB
}));
```

## Storage Adapters

### Local Storage

For development and simple deployments:

```typescript
import { initializeStorage } from "@kahveciderin/concave";

initializeStorage({
  type: "local",
  local: {
    basePath: "./uploads",
    baseUrl: "/uploads",
    createDirectories: true, // Default: true
  },
});
```

Features:
- Creates nested directories automatically
- Stores metadata in sidecar `.meta.json` files
- Provides direct URLs via configured `baseUrl`
- Does not support presigned URLs

### S3 Storage

For production with S3, MinIO, or compatible services:

```typescript
import { initializeStorage } from "@kahveciderin/concave";

initializeStorage({
  type: "s3",
  s3: {
    bucket: "my-bucket",
    region: "us-east-1",
    accessKeyId: process.env.AWS_ACCESS_KEY_ID,
    secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
    presignedUrlExpiry: 3600, // 1 hour
  },
});
```

For S3-compatible services (MinIO, DigitalOcean Spaces, etc.):

```typescript
initializeStorage({
  type: "s3",
  s3: {
    bucket: "my-bucket",
    endpoint: "https://minio.example.com",
    forcePathStyle: true,
    accessKeyId: "...",
    secretAccessKey: "...",
  },
});
```

Features:
- Supports presigned URLs for direct uploads/downloads
- Automatic multipart uploads for large files
- Works with any S3-compatible service

### Memory Storage

For testing without filesystem/network dependencies:

```typescript
import { initializeStorage } from "@kahveciderin/concave";

initializeStorage({ type: "memory" });
```

Features:
- Stores files in memory
- Useful for unit tests
- No persistence between restarts

## File Resource

The `useFileResource` hook creates an Express router with file upload endpoints.

### Schema Requirements

Your files table must have these columns:

```typescript
import { sqliteTable, text, integer } from "drizzle-orm/sqlite-core";

export const filesTable = sqliteTable("files", {
  id: text("id").primaryKey(),
  userId: text("userId").references(() => usersTable.id),
  filename: text("filename").notNull(),
  mimeType: text("mimeType").notNull(),
  size: integer("size").notNull(),
  storagePath: text("storagePath").notNull(),
  url: text("url"),
  status: text("status").notNull().default("pending"),
  createdAt: integer("createdAt", { mode: "timestamp" }).notNull(),
});
```

### Configuration

```typescript
useFileResource(filesTable, {
  db,                    // Drizzle database instance
  schema: filesTable,    // Table schema
  id: filesTable.id,     // ID column

  // Optional settings
  storage: adapter,      // Override global storage
  allowedMimeTypes: ["image/jpeg", "image/png"],
  maxFileSize: 5 * 1024 * 1024,  // 5MB
  usePresignedUrls: false,       // Use presigned URLs for downloads
  presignedUrlExpiry: 3600,      // Presigned URL expiry in seconds

  // Custom key generation
  generateKey: (filename, userId) => `${userId}/${Date.now()}-${filename}`,

  // Authentication scopes
  auth: {
    read: async (user) => rsql`userId==${user?.id}`,
    create: async (user) => (user ? rsql`*` : rsql``),
    delete: async (user) => rsql`userId==${user?.id}`,
  },
});
```

### Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST /` | Upload file (multipart/form-data) | Returns created file record |
| `GET /upload-url` | Get presigned upload URL (S3 only) | Returns `{ fileId, uploadUrl, expiresAt }` |
| `POST /:id/confirm` | Confirm presigned upload completed | Updates file status to completed |
| `GET /` | List files | Supports filter and pagination |
| `GET /:id` | Get file metadata | Returns file record |
| `GET /:id/download` | Download file | Streams file or redirects to presigned URL |
| `DELETE /:id` | Delete file | Removes file from storage and database |
| `DELETE /batch` | Delete multiple files | Body: `{ ids: [...] }` |

### Upload via Multipart Form Data

```bash
curl -X POST http://localhost:3000/api/files \
  -H "Content-Type: multipart/form-data" \
  -F "file=@photo.jpg"
```

Response:
```json
{
  "data": {
    "id": "abc123",
    "userId": "user1",
    "filename": "photo.jpg",
    "mimeType": "image/jpeg",
    "size": 102400,
    "storagePath": "user1/1705432123456-photo.jpg",
    "url": "/uploads/user1/1705432123456-photo.jpg",
    "status": "completed",
    "createdAt": "2024-01-16T20:15:23.456Z"
  }
}
```

### Upload via Presigned URL (S3)

1. Get upload URL:
```bash
curl "http://localhost:3000/api/files/upload-url?filename=photo.jpg&contentType=image/jpeg"
```

Response:
```json
{
  "data": {
    "fileId": "abc123",
    "uploadUrl": "https://bucket.s3.amazonaws.com/...",
    "key": "user1/photo.jpg",
    "expiresAt": "2024-01-16T21:15:23.456Z"
  }
}
```

2. Upload directly to S3:
```bash
curl -X PUT "$UPLOAD_URL" \
  -H "Content-Type: image/jpeg" \
  --data-binary @photo.jpg
```

3. Confirm upload:
```bash
curl -X POST "http://localhost:3000/api/files/abc123/confirm"
```

## Relating Files to Resources

Files can be related to other resources using standard relations:

```typescript
// Add imageId to your table
export const todosTable = sqliteTable("todos", {
  id: text("id").primaryKey(),
  imageId: text("imageId").references(() => filesTable.id, { onDelete: "set null" }),
  // ...
});

// Configure the relation
app.use("/api/todos", useResource(todosTable, {
  relations: {
    image: {
      resource: "files",
      schema: filesTable,
      type: "belongsTo",
      foreignKey: todosTable.imageId,
      references: filesTable.id,
    },
  },
}));
```

Query with included image:
```bash
GET /api/todos?include=image
```

## Client Library

### Upload Files

```typescript
import { createFileClient } from "@kahveciderin/concave/client";

const files = createFileClient({
  transport: client.transport,
  resourcePath: "/api/files",
});

// Direct upload with progress
const result = await files.upload(file, {
  onProgress: ({ percent }) => console.log(`${percent}%`),
});

// Upload via presigned URL (S3)
const result = await files.uploadWithPresignedUrl(file, {
  onProgress: ({ percent }) => console.log(`${percent}%`),
});

// List files
const { data } = await files.list({ limit: 20 });

// Delete file
await files.delete(fileId);
```

### React Hooks

```tsx
import { useFileUpload, useFile, useFiles } from "@kahveciderin/concave/client/react";

function UploadButton() {
  const { upload, isUploading, progress, error } = useFileUpload({
    resourcePath: "/api/files",
    onSuccess: (file) => console.log("Uploaded:", file.id),
  });

  return (
    <input
      type="file"
      onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])}
      disabled={isUploading}
    />
  );
}

function FileList() {
  const { files, isLoading, deleteFile, getDownloadUrl } = useFiles({
    resourcePath: "/api/files",
  });

  return (
    <ul>
      {files.map((file) => (
        <li key={file.id}>
          <a href={getDownloadUrl(file.id)}>{file.filename}</a>
          <button onClick={() => deleteFile(file.id)}>Delete</button>
        </li>
      ))}
    </ul>
  );
}
```

## API Reference

### Global Functions

#### `initializeStorage(config)`

Initialize and set the global storage adapter.

```typescript
initializeStorage({
  type: "local" | "s3" | "memory",
  local?: { basePath, baseUrl?, createDirectories? },
  s3?: { bucket, region?, endpoint?, accessKeyId?, secretAccessKey?, presignedUrlExpiry? },
});
```

#### `setGlobalStorage(adapter)`

Set a custom storage adapter as the global instance.

#### `getGlobalStorage()`

Get the global storage adapter. Throws if not initialized.

#### `hasGlobalStorage()`

Returns `true` if a storage adapter is initialized.

### Storage Adapter Interface

```typescript
interface StorageAdapter {
  upload(key: string, data: Buffer | Readable, options?: UploadOptions): Promise<UploadResult>;
  download(key: string): Promise<Buffer>;
  downloadStream(key: string): Promise<Readable>;
  delete(key: string): Promise<void>;
  deleteMany(keys: string[]): Promise<void>;
  exists(key: string): Promise<boolean>;
  getMetadata(key: string): Promise<FileMetadata | null>;
  getUrl(key: string): string | null;
  getDownloadUrl(key: string, options?: PresignedUrlOptions): Promise<string | null>;
  getUploadUrl(key: string, options?: PresignedUrlOptions): Promise<PresignedUploadResult | null>;
  supportsPresignedUrls(): boolean;
}
```

### Types

```typescript
interface FileMetadata {
  key: string;
  filename: string;
  mimeType: string;
  size: number;
  createdAt: Date;
  updatedAt?: Date;
  etag?: string;
  customMetadata?: Record<string, string>;
}

interface UploadOptions {
  filename?: string;
  mimeType?: string;
  contentEncoding?: string;
  cacheControl?: string;
  customMetadata?: Record<string, string>;
}

interface PresignedUrlOptions {
  expiresIn?: number;
  contentType?: string;
  contentLength?: number;
  metadata?: Record<string, string>;
}
```
