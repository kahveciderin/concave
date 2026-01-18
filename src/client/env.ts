export interface EnvSchemaField {
  path: string[];
  type: "string" | "number" | "boolean" | "object" | "array" | "unknown";
}

export interface PublicEnvSchema {
  fields: EnvSchemaField[];
  timestamp: string;
}

export interface EnvClientConfig {
  baseUrl: string;
  envPath?: string;
  credentials?: RequestCredentials;
  headers?: Record<string, string>;
}

export interface EnvClient<T = unknown> {
  get(): Promise<T>;
  getSchema(): Promise<PublicEnvSchema>;
  subscribe(callback: (env: T) => void, intervalMs?: number): () => void;
}

export const createEnvClient = <T = unknown>(
  config: EnvClientConfig
): EnvClient<T> => {
  const baseUrl = config.baseUrl.replace(/\/$/, "");
  const envPath = config.envPath ?? "/api/env";
  const fullUrl = `${baseUrl}${envPath}`;

  const fetchOptions: RequestInit = {
    credentials: config.credentials,
    headers: config.headers,
  };

  return {
    async get(): Promise<T> {
      const response = await fetch(fullUrl, fetchOptions);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch public env: ${response.status} ${response.statusText}`
        );
      }
      return response.json();
    },

    async getSchema(): Promise<PublicEnvSchema> {
      const response = await fetch(`${fullUrl}/schema`, fetchOptions);
      if (!response.ok) {
        throw new Error(
          `Failed to fetch env schema: ${response.status} ${response.statusText}`
        );
      }
      return response.json();
    },

    subscribe(callback: (env: T) => void, intervalMs = 60000): () => void {
      let cancelled = false;

      const poll = async () => {
        if (cancelled) return;
        try {
          const env = await this.get();
          if (!cancelled) {
            callback(env);
          }
        } catch (error) {
          console.error("Failed to fetch env:", error);
        }
        if (!cancelled) {
          setTimeout(poll, intervalMs);
        }
      };

      poll();

      return () => {
        cancelled = true;
      };
    },
  };
};

export const fetchPublicEnv = async <T = unknown>(
  serverUrl: string,
  envPath = "/api/env"
): Promise<T> => {
  const client = createEnvClient<T>({ baseUrl: serverUrl, envPath });
  return client.get();
};

export const fetchEnvSchema = async (
  serverUrl: string,
  envPath = "/api/env"
): Promise<PublicEnvSchema> => {
  const client = createEnvClient({ baseUrl: serverUrl, envPath });
  return client.getSchema();
};

const schemaTypeToTS = (
  type: EnvSchemaField["type"]
): string => {
  switch (type) {
    case "string":
      return "string";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "array":
      return "unknown[]";
    case "object":
      return "Record<string, unknown>";
    default:
      return "unknown";
  }
};

export const generateEnvTypeScript = (schema: PublicEnvSchema): string => {
  if (schema.fields.length === 0) {
    return "export type PublicEnv = Record<string, never>;\n";
  }

  const buildNestedType = (
    fields: EnvSchemaField[],
    depth: number = 0
  ): string => {
    const indent = "  ".repeat(depth);
    const groups: Record<string, EnvSchemaField[]> = {};
    const leafFields: EnvSchemaField[] = [];

    for (const field of fields) {
      if (field.path.length === 1) {
        leafFields.push(field);
      } else {
        const [first, ...rest] = field.path;
        if (!groups[first]) {
          groups[first] = [];
        }
        groups[first].push({ ...field, path: rest });
      }
    }

    let output = "{\n";

    for (const field of leafFields) {
      output += `${indent}  ${field.path[0]}: ${schemaTypeToTS(field.type)};\n`;
    }

    for (const [key, nestedFields] of Object.entries(groups)) {
      output += `${indent}  ${key}: ${buildNestedType(nestedFields, depth + 1)};\n`;
    }

    output += `${indent}}`;
    return output;
  };

  return `export type PublicEnv = ${buildNestedType(schema.fields)};\n`;
};
