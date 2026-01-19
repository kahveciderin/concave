import { SearchAdapter, SearchQuery, SearchResult, IndexMappings } from "./types";

export const createMemorySearchAdapter = (): SearchAdapter & {
  getIndex(indexName: string): Map<string, Record<string, unknown>> | undefined;
  getAllIndices(): Map<string, Map<string, Record<string, unknown>>>;
} => {
  const indices: Map<string, Map<string, Record<string, unknown>>> = new Map();

  return {
    async index(indexName, id, document) {
      if (!indices.has(indexName)) {
        indices.set(indexName, new Map());
      }
      indices.get(indexName)!.set(id, { ...document });
    },

    async delete(indexName, id) {
      indices.get(indexName)?.delete(id);
    },

    async search<T = Record<string, unknown>>(
      indexName: string,
      query: SearchQuery
    ): Promise<SearchResult<T>> {
      const index = indices.get(indexName);
      if (!index) {
        return { hits: [], total: 0 };
      }

      const allEntries = [...index.entries()];
      const matchingEntries = allEntries.filter(([_, doc]) => {
        const searchFields = query.fields ?? Object.keys(doc);
        return searchFields.some((field) => {
          const value = doc[field];
          if (typeof value === "string") {
            return value.toLowerCase().includes(query.query.toLowerCase());
          }
          if (typeof value === "number") {
            return String(value).includes(query.query);
          }
          return false;
        });
      });

      const from = query.from ?? 0;
      const size = query.size ?? 20;
      const paginatedEntries = matchingEntries.slice(from, from + size);

      const hits = paginatedEntries.map(([id, doc], i) => ({
        id,
        score: 1.0 - i * 0.01,
        source: doc as T,
        highlights: query.highlight
          ? Object.fromEntries(
              Object.entries(doc)
                .filter(
                  ([_, v]) =>
                    typeof v === "string" &&
                    v.toLowerCase().includes(query.query.toLowerCase())
                )
                .map(([k, v]) => [k, [String(v)]])
            )
          : undefined,
      }));

      return {
        hits,
        total: matchingEntries.length,
      };
    },

    async createIndex(indexName: string, _mappings: IndexMappings) {
      if (!indices.has(indexName)) {
        indices.set(indexName, new Map());
      }
    },

    async deleteIndex(indexName: string) {
      indices.delete(indexName);
    },

    async indexExists(indexName: string) {
      return indices.has(indexName);
    },

    getIndex(indexName: string) {
      return indices.get(indexName);
    },

    getAllIndices() {
      return indices;
    },
  };
};
