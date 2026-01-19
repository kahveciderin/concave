import { Table, TableConfig, getTableColumns } from "drizzle-orm";
import { ResourceCapabilities, FieldPolicies, ProcedureDefinition } from "@/resource/types";
import { CONCAVE_VERSION } from "@/middleware/versioning";

export interface OpenAPIV3Document {
  openapi: string;
  info: {
    title: string;
    version: string;
    description?: string;
  };
  servers?: Array<{ url: string; description?: string }>;
  paths: Record<string, PathItem>;
  components?: {
    schemas?: Record<string, SchemaObject>;
    securitySchemes?: Record<string, SecurityScheme>;
    responses?: Record<string, ResponseObject>;
    parameters?: Record<string, ParameterObject>;
  };
  security?: Array<Record<string, string[]>>;
  tags?: Array<{ name: string; description?: string }>;
}

export interface PathItem {
  get?: OperationObject;
  post?: OperationObject;
  put?: OperationObject;
  patch?: OperationObject;
  delete?: OperationObject;
  parameters?: ParameterObject[];
}

export interface OperationObject {
  summary?: string;
  description?: string;
  operationId?: string;
  tags?: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  security?: Array<Record<string, string[]>>;
}

export interface ParameterObject {
  name: string;
  in: "query" | "path" | "header" | "cookie";
  description?: string;
  required?: boolean;
  schema?: SchemaObject;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, { schema: SchemaObject }>;
}

export interface ResponseObject {
  description: string;
  content?: Record<string, { schema: SchemaObject }>;
  headers?: Record<string, { schema: SchemaObject; description?: string }>;
}

export interface SchemaObject {
  type?: "string" | "number" | "integer" | "boolean" | "array" | "object" | "null";
  format?: string;
  properties?: Record<string, SchemaObject>;
  items?: SchemaObject;
  required?: string[];
  nullable?: boolean;
  description?: string;
  enum?: unknown[];
  $ref?: string;
  allOf?: SchemaObject[];
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
}

export interface SecurityScheme {
  type: "apiKey" | "http" | "oauth2" | "openIdConnect";
  description?: string;
  name?: string;
  in?: "query" | "header" | "cookie";
  scheme?: string;
  bearerFormat?: string;
}

export interface RelationInfo {
  name: string;
  resource: string;
  type: "belongsTo" | "hasOne" | "hasMany" | "manyToMany";
  nullable?: boolean;
}

export interface RegisteredResource {
  name: string;
  path: string;
  schema: Table<TableConfig>;
  capabilities?: ResourceCapabilities;
  fields?: FieldPolicies;
  procedures?: Record<string, ProcedureDefinition>;
  idField?: string;
  relations?: RelationInfo[];
}

export interface OpenAPIConfig {
  title?: string;
  version?: string;
  description?: string;
  servers?: Array<{ url: string; description?: string }>;
  securitySchemes?: Record<string, SecurityScheme>;
  basePath?: string;
}

const mapDrizzleTypeToOpenAPI = (
  columnType: string
): { type: SchemaObject["type"]; format?: string } => {
  const type = columnType.toLowerCase();

  if (type.includes("int") || type.includes("serial")) {
    return { type: "integer" };
  }
  if (type.includes("float") || type.includes("double") || type.includes("decimal") || type.includes("numeric")) {
    return { type: "number" };
  }
  if (type.includes("bool")) {
    return { type: "boolean" };
  }
  if (type.includes("timestamp") || type.includes("datetime")) {
    return { type: "string", format: "date-time" };
  }
  if (type.includes("date")) {
    return { type: "string", format: "date" };
  }
  if (type.includes("time")) {
    return { type: "string", format: "time" };
  }
  if (type.includes("json") || type.includes("jsonb")) {
    return { type: "object" };
  }
  if (type.includes("uuid")) {
    return { type: "string", format: "uuid" };
  }

  return { type: "string" };
};

const getSchemaColumns = <TConfig extends TableConfig>(
  schema: Table<TConfig> | Record<string, unknown>
): Record<string, unknown> | undefined => {
  try {
    const columns = getTableColumns(schema as Table<TConfig>);
    if (columns && Object.keys(columns).length > 0) {
      return columns;
    }
  } catch {
    // Fall through to mock handling
  }

  if (typeof schema === "object" && schema !== null) {
    const entries = Object.entries(schema).filter(
      ([key, value]) =>
        key !== "_" &&
        typeof value === "object" &&
        value !== null &&
        ("dataType" in value || "columnType" in value || "notNull" in value)
    );
    if (entries.length > 0) {
      return Object.fromEntries(entries);
    }
  }

  return undefined;
};

const generateSchemaFromDrizzle = <TConfig extends TableConfig>(
  schema: Table<TConfig> | Record<string, unknown>,
  readableFields?: string[]
): SchemaObject => {
  const columns = getSchemaColumns(schema);
  const properties: Record<string, SchemaObject> = {};
  const required: string[] = [];

  if (!columns) {
    return { type: "object", properties: {} };
  }

  for (const [name, column] of Object.entries(columns)) {
    if (readableFields && !readableFields.includes(name)) {
      continue;
    }

    const col = column as { dataType?: string; notNull?: boolean; columnType?: string };
    const columnType = col.dataType ?? col.columnType ?? "string";
    const { type, format } = mapDrizzleTypeToOpenAPI(columnType);

    const prop: SchemaObject = { type };
    if (format) {
      prop.format = format;
    }

    if (!col.notNull) {
      prop.nullable = true;
    } else {
      required.push(name);
    }

    properties[name] = prop;
  }

  return {
    type: "object",
    properties,
    required: required.length > 0 ? required : undefined,
  };
};

const commonParameters: Record<string, ParameterObject> = {
  filter: {
    name: "filter",
    in: "query",
    description: "RSQL filter expression",
    schema: { type: "string" },
  },
  cursor: {
    name: "cursor",
    in: "query",
    description: "Pagination cursor",
    schema: { type: "string" },
  },
  limit: {
    name: "limit",
    in: "query",
    description: "Number of items to return",
    schema: { type: "integer", format: "int32" },
  },
  orderBy: {
    name: "orderBy",
    in: "query",
    description: "Field to order by (format: field:direction)",
    schema: { type: "string" },
  },
  select: {
    name: "select",
    in: "query",
    description: "Comma-separated list of fields to return",
    schema: { type: "string" },
  },
  totalCount: {
    name: "totalCount",
    in: "query",
    description: "Include total count in response",
    schema: { type: "boolean" },
  },
};

const problemDetailSchema: SchemaObject = {
  type: "object",
  properties: {
    type: { type: "string", format: "uri" },
    title: { type: "string" },
    status: { type: "integer" },
    detail: { type: "string" },
    instance: { type: "string" },
    requestId: { type: "string" },
  },
  required: ["type", "title", "status"],
};

const addResourcePaths = (
  spec: OpenAPIV3Document,
  resource: RegisteredResource,
  basePath: string = ""
): void => {
  const { name, path, schema, capabilities, fields, procedures } = resource;
  const resourcePath = `${basePath}${path}`;
  const resourceSchema = generateSchemaFromDrizzle(schema, fields?.readable);
  const schemaRef = `#/components/schemas/${name}`;

  spec.components!.schemas![name] = resourceSchema;
  spec.components!.schemas![`${name}Input`] = generateSchemaFromDrizzle(schema, fields?.writable);

  spec.paths[resourcePath] = {
    get: {
      summary: `List ${name}`,
      operationId: `list${name}`,
      tags: [name],
      parameters: [
        commonParameters.filter!,
        commonParameters.cursor!,
        commonParameters.limit!,
        commonParameters.orderBy!,
        commonParameters.select!,
        commonParameters.totalCount!,
      ],
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: {
                  items: { type: "array", items: { $ref: schemaRef } },
                  nextCursor: { type: "string", nullable: true },
                  hasMore: { type: "boolean" },
                  totalCount: { type: "integer", nullable: true },
                },
              },
            },
          },
        },
        "400": {
          description: "Bad request",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableCreate !== false) {
    spec.paths[resourcePath]!.post = {
      summary: `Create ${name}`,
      operationId: `create${name}`,
      tags: [name],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "201": {
          description: "Created",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          headers: {
            ETag: { schema: { type: "string" }, description: "Entity tag" },
          },
        },
        "400": {
          description: "Validation error",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    };
  }

  const idPath = `${resourcePath}/{id}`;
  spec.paths[idPath] = {
    parameters: [
      {
        name: "id",
        in: "path",
        required: true,
        schema: { type: "string" },
        description: `${name} ID`,
      },
    ],
    get: {
      summary: `Get ${name} by ID`,
      operationId: `get${name}`,
      tags: [name],
      parameters: [commonParameters.select!],
      responses: {
        "200": {
          description: "Successful response",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
          headers: {
            ETag: { schema: { type: "string" }, description: "Entity tag" },
          },
        },
        "404": {
          description: "Not found",
          content: {
            "application/problem+json": {
              schema: { $ref: "#/components/schemas/ProblemDetail" },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableUpdate !== false) {
    spec.paths[idPath]!.patch = {
      summary: `Update ${name}`,
      operationId: `update${name}`,
      tags: [name],
      parameters: [
        {
          name: "If-Match",
          in: "header",
          description: "ETag for conditional update",
          schema: { type: "string" },
        },
      ],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "200": {
          description: "Updated",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
        },
        "404": { description: "Not found" },
        "412": { description: "Precondition failed" },
      },
    };

    spec.paths[idPath]!.put = {
      summary: `Replace ${name}`,
      operationId: `replace${name}`,
      tags: [name],
      requestBody: {
        required: true,
        content: {
          "application/json": {
            schema: { $ref: `#/components/schemas/${name}Input` },
          },
        },
      },
      responses: {
        "200": {
          description: "Replaced",
          content: {
            "application/json": {
              schema: { $ref: schemaRef },
            },
          },
        },
        "404": { description: "Not found" },
      },
    };
  }

  if (capabilities?.enableDelete !== false) {
    spec.paths[idPath]!.delete = {
      summary: `Delete ${name}`,
      operationId: `delete${name}`,
      tags: [name],
      responses: {
        "204": { description: "Deleted" },
        "404": { description: "Not found" },
      },
    };
  }

  spec.paths[`${resourcePath}/count`] = {
    get: {
      summary: `Count ${name}`,
      operationId: `count${name}`,
      tags: [name],
      parameters: [commonParameters.filter!],
      responses: {
        "200": {
          description: "Count response",
          content: {
            "application/json": {
              schema: {
                type: "object",
                properties: { count: { type: "integer" } },
              },
            },
          },
        },
      },
    },
  };

  if (capabilities?.enableAggregations !== false) {
    spec.paths[`${resourcePath}/aggregate`] = {
      get: {
        summary: `Aggregate ${name}`,
        operationId: `aggregate${name}`,
        tags: [name],
        parameters: [
          commonParameters.filter!,
          { name: "groupBy", in: "query", schema: { type: "string" } },
          { name: "sum", in: "query", schema: { type: "string" } },
          { name: "avg", in: "query", schema: { type: "string" } },
          { name: "min", in: "query", schema: { type: "string" } },
          { name: "max", in: "query", schema: { type: "string" } },
          { name: "count", in: "query", schema: { type: "boolean" } },
        ],
        responses: {
          "200": {
            description: "Aggregation response",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    groups: {
                      type: "array",
                      items: {
                        type: "object",
                        properties: {
                          key: { type: "object", nullable: true },
                          count: { type: "integer" },
                          sum: { type: "object" },
                          avg: { type: "object" },
                          min: { type: "object" },
                          max: { type: "object" },
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  if (capabilities?.enableSubscribe !== false) {
    spec.paths[`${resourcePath}/subscribe`] = {
      get: {
        summary: `Subscribe to ${name} changes`,
        operationId: `subscribe${name}`,
        tags: [name],
        parameters: [
          commonParameters.filter!,
          {
            name: "resumeFrom",
            in: "query",
            schema: { type: "integer" },
            description: "Sequence number to resume from",
          },
        ],
        responses: {
          "200": {
            description: "SSE stream",
            content: {
              "text/event-stream": {
                schema: { type: "string" },
              },
            },
          },
        },
      },
    };
  }

  if (procedures) {
    for (const [procName, _proc] of Object.entries(procedures)) {
      spec.paths[`${resourcePath}/rpc/${procName}`] = {
        post: {
          summary: `Call ${procName} procedure`,
          operationId: `${name}_${procName}`,
          tags: [name],
          requestBody: {
            content: {
              "application/json": {
                schema: { type: "object" },
              },
            },
          },
          responses: {
            "200": {
              description: "Procedure response",
              content: {
                "application/json": {
                  schema: { type: "object" },
                },
              },
            },
          },
        },
      };
    }
  }
};

export const generateOpenAPISpec = (
  resources: RegisteredResource[],
  config: OpenAPIConfig = {}
): OpenAPIV3Document => {
  const spec: OpenAPIV3Document = {
    openapi: "3.0.3",
    info: {
      title: config.title ?? "Concave API",
      version: config.version ?? CONCAVE_VERSION,
      description: config.description,
    },
    servers: config.servers,
    paths: {},
    components: {
      schemas: {
        ProblemDetail: problemDetailSchema,
      },
      securitySchemes: config.securitySchemes ?? {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
        },
      },
    },
    tags: resources.map((r) => ({ name: r.name })),
  };

  for (const resource of resources) {
    addResourcePaths(spec, resource, config.basePath);
  }

  return spec;
};

export const serveOpenAPI = (
  resources: RegisteredResource[],
  config: OpenAPIConfig = {}
) => {
  let cachedSpec: OpenAPIV3Document | null = null;

  return {
    getSpec: () => {
      if (!cachedSpec) {
        cachedSpec = generateOpenAPISpec(resources, config);
      }
      return cachedSpec;
    },
    invalidateCache: () => {
      cachedSpec = null;
    },
  };
};
