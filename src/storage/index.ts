export type {
  StorageAdapter,
  FileMetadata,
  UploadOptions,
  UploadResult,
  PresignedUrlOptions,
  PresignedUploadResult,
  LocalStorageConfig,
  S3StorageConfig,
  StorageConfig,
} from "./types";

export {
  setGlobalStorage,
  getGlobalStorage,
  hasGlobalStorage,
  clearGlobalStorage,
} from "./types";

export { MemoryStorageAdapter, createMemoryStorage } from "./memory";

export { LocalStorageAdapter, createLocalStorage } from "./local";

export { S3StorageAdapter, createS3Storage } from "./s3";

import { StorageAdapter, StorageConfig, setGlobalStorage } from "./types";
import { createMemoryStorage } from "./memory";
import { createLocalStorage } from "./local";
import { createS3Storage } from "./s3";

export const createStorage = (config: StorageConfig): StorageAdapter => {
  switch (config.type) {
    case "memory":
      return createMemoryStorage();
    case "local":
      if (!config.local) {
        throw new Error("Local storage configuration required when type is 'local'");
      }
      return createLocalStorage(config.local);
    case "s3":
      if (!config.s3) {
        throw new Error("S3 storage configuration required when type is 's3'");
      }
      return createS3Storage(config.s3);
    default:
      throw new Error(`Unknown storage type: ${(config as StorageConfig).type}`);
  }
};

export const initializeStorage = (config: StorageConfig): StorageAdapter => {
  const storage = createStorage(config);
  setGlobalStorage(storage);
  return storage;
};
