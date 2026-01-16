import type { ConcaveClient } from "./types";

let globalClient: ConcaveClient | null = null;
let globalAuthErrorHandler: (() => void) | null = null;

export const getClient = (): ConcaveClient => {
  // Check globalThis first for HMR stability
  if (typeof globalThis !== "undefined" && (globalThis as Record<string, unknown>).__concaveClient) {
    return (globalThis as Record<string, unknown>).__concaveClient as ConcaveClient;
  }
  if (!globalClient) {
    throw new Error("Concave client not initialized. Call createClient() first.");
  }
  return globalClient;
};

export const setGlobalClient = (client: ConcaveClient): void => {
  globalClient = client;
  if (typeof globalThis !== "undefined") {
    (globalThis as Record<string, unknown>).__concaveClient = client;
  }
};

export const getAuthErrorHandler = (): (() => void) | null => globalAuthErrorHandler;

export const setAuthErrorHandler = (handler: () => void): void => {
  globalAuthErrorHandler = handler;
};
