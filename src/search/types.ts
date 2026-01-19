export interface SearchQuery {
  query: string;
  fields?: string[];
  fieldWeights?: Record<string, number>;
  from?: number;
  size?: number;
  highlight?: boolean;
  sort?: Array<{ field: string; order: "asc" | "desc" }>;
}

export interface SearchHit<T = Record<string, unknown>> {
  id: string;
  score: number;
  source: T;
  highlights?: Record<string, string[]>;
}

export interface SearchResult<T = Record<string, unknown>> {
  hits: SearchHit<T>[];
  total: number;
}

export interface FieldMapping {
  type:
    | "text"
    | "keyword"
    | "integer"
    | "long"
    | "float"
    | "double"
    | "boolean"
    | "date";
  analyzer?: string;
  index?: boolean;
}

export interface IndexMappings {
  properties: Record<string, FieldMapping>;
}

export interface SearchAdapter {
  index(
    indexName: string,
    id: string,
    document: Record<string, unknown>
  ): Promise<void>;
  delete(indexName: string, id: string): Promise<void>;
  search<T = Record<string, unknown>>(
    indexName: string,
    query: SearchQuery
  ): Promise<SearchResult<T>>;
  createIndex(indexName: string, mappings: IndexMappings): Promise<void>;
  deleteIndex(indexName: string): Promise<void>;
  indexExists(indexName: string): Promise<boolean>;
}

export interface SearchConfig {
  enabled?: boolean;
  indexName?: string;
  fields?:
    | string[]
    | Record<string, { weight?: number; searchable?: boolean; analyzer?: string }>;
  autoIndex?: boolean;
}
