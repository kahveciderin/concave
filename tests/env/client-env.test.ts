import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import express, { Express } from "express";
import { Server } from "http";
import { z } from "zod";
import {
  createEnvClient,
  fetchPublicEnv,
  fetchEnvSchema,
  generateEnvTypeScript,
} from "../../src/client/env";
import { createEnv, envVariable, usePublicEnv } from "../../src/env";

describe("Client Environment Variables", () => {
  let app: Express;
  let server: Server;
  let baseUrl: string;

  beforeEach(async () => {
    app = express();
    app.use(express.json());

    const env = createEnv({
      PUBLIC_API_URL: envVariable("https://api.example.com", z.string(), {
        public: true,
      }),
      PUBLIC_VERSION: envVariable("1.0.0", z.string(), { public: true }),
      SECRET: envVariable("hidden", z.string()),
      CONFIG: {
        NAME: envVariable("MyApp", z.string(), { public: true }),
        DEBUG: envVariable("false", z.string()),
      },
    });

    app.use("/api/env", usePublicEnv(env));

    await new Promise<void>((resolve) => {
      server = app.listen(0, () => {
        const addr = server.address();
        if (addr && typeof addr === "object") {
          baseUrl = `http://localhost:${addr.port}`;
        }
        resolve();
      });
    });
  });

  afterEach(async () => {
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
    });
  });

  describe("createEnvClient", () => {
    it("should fetch public environment variables", async () => {
      const client = createEnvClient({ baseUrl });
      const env = await client.get();

      expect(env).toEqual({
        PUBLIC_API_URL: "https://api.example.com",
        PUBLIC_VERSION: "1.0.0",
        CONFIG: {
          NAME: "MyApp",
        },
      });
    });

    it("should fetch environment schema", async () => {
      const client = createEnvClient({ baseUrl });
      const schema = await client.getSchema();

      expect(schema.fields).toHaveLength(3);
      expect(schema.fields).toContainEqual({
        path: ["PUBLIC_API_URL"],
        type: "string",
      });
      expect(schema.fields).toContainEqual({
        path: ["PUBLIC_VERSION"],
        type: "string",
      });
      expect(schema.fields).toContainEqual({
        path: ["CONFIG", "NAME"],
        type: "string",
      });
      expect(schema.timestamp).toBeDefined();
    });

    it("should use custom env path", async () => {
      const customApp = express();
      const customEnv = createEnv({
        PUBLIC_VALUE: envVariable("custom", z.string(), { public: true }),
      });
      customApp.use("/custom/env", usePublicEnv(customEnv));

      const customServer = await new Promise<Server>((resolve) => {
        const s = customApp.listen(0, () => resolve(s));
      });
      const addr = customServer.address();
      const customUrl = `http://localhost:${
        addr && typeof addr === "object" ? addr.port : 0
      }`;

      const client = createEnvClient({
        baseUrl: customUrl,
        envPath: "/custom/env",
      });
      const env = await client.get();

      expect(env).toEqual({
        PUBLIC_VALUE: "custom",
      });

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });

    it("should subscribe to env changes", async () => {
      const client = createEnvClient({ baseUrl });
      const callback = vi.fn();

      const unsubscribe = client.subscribe(callback, 100);

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(callback).toHaveBeenCalledWith({
        PUBLIC_API_URL: "https://api.example.com",
        PUBLIC_VERSION: "1.0.0",
        CONFIG: {
          NAME: "MyApp",
        },
      });

      unsubscribe();

      const callCount = callback.mock.calls.length;
      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(callback.mock.calls.length).toBe(callCount);
    });

    it("should throw on fetch error", async () => {
      const client = createEnvClient({ baseUrl: "http://localhost:99999" });

      await expect(client.get()).rejects.toThrow();
    });
  });

  describe("fetchPublicEnv", () => {
    it("should fetch public env vars", async () => {
      const env = await fetchPublicEnv(baseUrl);

      expect(env).toEqual({
        PUBLIC_API_URL: "https://api.example.com",
        PUBLIC_VERSION: "1.0.0",
        CONFIG: {
          NAME: "MyApp",
        },
      });
    });
  });

  describe("fetchEnvSchema", () => {
    it("should fetch env schema", async () => {
      const schema = await fetchEnvSchema(baseUrl);

      expect(schema.fields).toHaveLength(3);
    });
  });

  describe("generateEnvTypeScript", () => {
    it("should generate TypeScript types from flat schema", () => {
      const schema = {
        fields: [
          { path: ["API_URL"], type: "string" as const },
          { path: ["PORT"], type: "number" as const },
          { path: ["DEBUG"], type: "boolean" as const },
        ],
        timestamp: new Date().toISOString(),
      };

      const code = generateEnvTypeScript(schema);

      expect(code).toContain("export type PublicEnv = {");
      expect(code).toContain("API_URL: string;");
      expect(code).toContain("PORT: number;");
      expect(code).toContain("DEBUG: boolean;");
    });

    it("should generate TypeScript types from nested schema", () => {
      const schema = {
        fields: [
          { path: ["PUBLIC_VERSION"], type: "string" as const },
          { path: ["CONFIG", "NAME"], type: "string" as const },
          { path: ["CONFIG", "PORT"], type: "number" as const },
          { path: ["CONFIG", "NESTED", "VALUE"], type: "boolean" as const },
        ],
        timestamp: new Date().toISOString(),
      };

      const code = generateEnvTypeScript(schema);

      expect(code).toContain("export type PublicEnv = {");
      expect(code).toContain("PUBLIC_VERSION: string;");
      expect(code).toContain("CONFIG: {");
      expect(code).toContain("NAME: string;");
      expect(code).toContain("PORT: number;");
      expect(code).toContain("NESTED: {");
      expect(code).toContain("VALUE: boolean;");
    });

    it("should handle array and object types", () => {
      const schema = {
        fields: [
          { path: ["ITEMS"], type: "array" as const },
          { path: ["DATA"], type: "object" as const },
          { path: ["OTHER"], type: "unknown" as const },
        ],
        timestamp: new Date().toISOString(),
      };

      const code = generateEnvTypeScript(schema);

      expect(code).toContain("ITEMS: unknown[];");
      expect(code).toContain("DATA: Record<string, unknown>;");
      expect(code).toContain("OTHER: unknown;");
    });

    it("should handle empty schema", () => {
      const schema = {
        fields: [],
        timestamp: new Date().toISOString(),
      };

      const code = generateEnvTypeScript(schema);

      expect(code).toContain(
        "export type PublicEnv = Record<string, never>;"
      );
    });
  });

  describe("usePublicEnv schema endpoint", () => {
    it("should expose schema endpoint by default", async () => {
      const response = await fetch(`${baseUrl}/api/env/schema`);
      expect(response.status).toBe(200);
      const schema = await response.json();
      expect(schema.fields).toBeDefined();
      expect(schema.timestamp).toBeDefined();
    });

    it("should hide schema endpoint when exposeSchema is false", async () => {
      const customApp = express();
      const customEnv = createEnv({
        PUBLIC_VALUE: envVariable("test", z.string(), { public: true }),
      });
      customApp.use("/env", usePublicEnv(customEnv, { exposeSchema: false }));

      const customServer = await new Promise<Server>((resolve) => {
        const s = customApp.listen(0, () => resolve(s));
      });
      const addr = customServer.address();
      const customUrl = `http://localhost:${
        addr && typeof addr === "object" ? addr.port : 0
      }`;

      const response = await fetch(`${customUrl}/env/schema`);
      expect(response.status).toBe(404);

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });
  });

  describe("schema type inference", () => {
    it("should infer string type", async () => {
      const schema = await fetchEnvSchema(baseUrl);
      const apiUrlField = schema.fields.find(
        (f) => f.path.join(".") === "PUBLIC_API_URL"
      );
      expect(apiUrlField?.type).toBe("string");
    });

    it("should infer number type", async () => {
      const customApp = express();
      const customEnv = createEnv({
        PUBLIC_PORT: envVariable(
          "3000",
          z.string().transform(Number),
          { public: true }
        ),
      });
      customApp.use("/env", usePublicEnv(customEnv));

      const customServer = await new Promise<Server>((resolve) => {
        const s = customApp.listen(0, () => resolve(s));
      });
      const addr = customServer.address();
      const customUrl = `http://localhost:${
        addr && typeof addr === "object" ? addr.port : 0
      }`;

      const schema = await fetchEnvSchema(customUrl, "/env");
      const portField = schema.fields.find(
        (f) => f.path.join(".") === "PUBLIC_PORT"
      );
      expect(portField?.type).toBe("number");

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });

    it("should infer boolean type", async () => {
      const customApp = express();
      const customEnv = createEnv({
        PUBLIC_DEBUG: envVariable(
          "true",
          z.string().transform((v) => v === "true"),
          { public: true }
        ),
      });
      customApp.use("/env", usePublicEnv(customEnv));

      const customServer = await new Promise<Server>((resolve) => {
        const s = customApp.listen(0, () => resolve(s));
      });
      const addr = customServer.address();
      const customUrl = `http://localhost:${
        addr && typeof addr === "object" ? addr.port : 0
      }`;

      const schema = await fetchEnvSchema(customUrl, "/env");
      const debugField = schema.fields.find(
        (f) => f.path.join(".") === "PUBLIC_DEBUG"
      );
      expect(debugField?.type).toBe("boolean");

      await new Promise<void>((resolve) => customServer.close(() => resolve()));
    });
  });
});
