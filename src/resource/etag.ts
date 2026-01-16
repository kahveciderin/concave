import { createHash } from "crypto";
import { Response } from "express";
import { PreconditionFailedError } from "./error";

export interface ETagConfig {
  versionField?: string;
  updatedAtField?: string;
  idField?: string;
  algorithm?: "weak" | "strong";
}

const DEFAULT_CONFIG: ETagConfig = {
  updatedAtField: "updatedAt",
  idField: "id",
  algorithm: "weak",
};

export const generateETag = (
  item: Record<string, unknown>,
  config: ETagConfig = DEFAULT_CONFIG
): string => {
  const { versionField, updatedAtField, idField, algorithm } = {
    ...DEFAULT_CONFIG,
    ...config,
  };

  let tag: string;

  if (versionField && item[versionField] !== undefined) {
    tag = `${item[versionField]}`;
  } else if (updatedAtField && item[updatedAtField]) {
    const timestamp =
      item[updatedAtField] instanceof Date
        ? (item[updatedAtField] as Date).getTime()
        : typeof item[updatedAtField] === "string"
          ? new Date(item[updatedAtField] as string).getTime()
          : item[updatedAtField];

    const id = idField && item[idField] ? item[idField] : "";
    tag = `${timestamp}-${id}`;
  } else {
    const hash = createHash("md5")
      .update(JSON.stringify(item))
      .digest("hex")
      .slice(0, 16);
    tag = hash;
  }

  return algorithm === "weak" ? `W/"${tag}"` : `"${tag}"`;
};

export const generateStrongETag = (
  item: Record<string, unknown>
): string => {
  const hash = createHash("sha256")
    .update(JSON.stringify(item))
    .digest("hex")
    .slice(0, 32);
  return `"${hash}"`;
};

export const parseETag = (etag: string): { value: string; weak: boolean } | null => {
  if (!etag || typeof etag !== "string") {
    return null;
  }

  const trimmed = etag.trim();

  if (trimmed.startsWith('W/"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(3, -1),
      weak: true,
    };
  }

  if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return {
      value: trimmed.slice(1, -1),
      weak: false,
    };
  }

  return null;
};

export const compareETags = (
  clientETag: string,
  serverETag: string,
  weakComparison: boolean = true
): boolean => {
  const client = parseETag(clientETag);
  const server = parseETag(serverETag);

  if (!client || !server) {
    return false;
  }

  if (!weakComparison && (client.weak || server.weak)) {
    return false;
  }

  return client.value === server.value;
};

export const validateIfMatch = (
  ifMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): void => {
  if (!ifMatch) {
    return;
  }

  const currentETag = generateETag(item, config);

  if (ifMatch === "*") {
    return;
  }

  const eTags = ifMatch.split(",").map((e) => e.trim());

  const matches = eTags.some((tag) => compareETags(tag, currentETag, true));

  if (!matches) {
    throw new PreconditionFailedError(currentETag);
  }
};

export const validateIfNoneMatch = (
  ifNoneMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): boolean => {
  if (!ifNoneMatch) {
    return false;
  }

  const currentETag = generateETag(item, config);

  if (ifNoneMatch === "*") {
    return true;
  }

  const eTags = ifNoneMatch.split(",").map((e) => e.trim());

  return eTags.some((tag) => compareETags(tag, currentETag, true));
};

export const setETagHeader = (
  res: Response,
  item: Record<string, unknown>,
  config?: ETagConfig
): void => {
  const etag = generateETag(item, config);
  res.set("ETag", etag);
};

export const handleConditionalGet = (
  res: Response,
  ifNoneMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): boolean => {
  const etag = generateETag(item, config);
  res.set("ETag", etag);

  if (ifNoneMatch && compareETags(ifNoneMatch, etag, true)) {
    res.status(304).end();
    return true;
  }

  return false;
};

export interface ConditionalWriteResult {
  shouldProceed: boolean;
  currentETag?: string;
}

export const checkConditionalWrite = (
  ifMatch: string | undefined,
  item: Record<string, unknown>,
  config?: ETagConfig
): ConditionalWriteResult => {
  const currentETag = generateETag(item, config);

  if (!ifMatch) {
    return { shouldProceed: true, currentETag };
  }

  if (ifMatch === "*") {
    return { shouldProceed: true, currentETag };
  }

  const eTags = ifMatch.split(",").map((e) => e.trim());
  const matches = eTags.some((tag) => compareETags(tag, currentETag, true));

  return { shouldProceed: matches, currentETag };
};

export const addETagsToList = <T extends Record<string, unknown>>(
  items: T[],
  config?: ETagConfig
): (T & { _etag: string })[] => {
  return items.map((item) => ({
    ...item,
    _etag: generateETag(item, config),
  }));
};

export type ReturnPreference = "representation" | "minimal";

export const parseReturnPreference = (
  query: Record<string, unknown>
): ReturnPreference => {
  const returnParam = query.return as string | undefined;
  if (returnParam === "minimal") {
    return "minimal";
  }
  return "representation";
};

export const handleReturnPreference = (
  res: Response,
  item: Record<string, unknown>,
  preference: ReturnPreference,
  config?: ETagConfig
): void => {
  const etag = generateETag(item, config);
  res.set("ETag", etag);

  if (preference === "minimal") {
    res.status(204).end();
  } else {
    res.json(item);
  }
};
