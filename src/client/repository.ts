import {
  ResourceClient,
  PaginatedResponse,
  AggregationResponse,
  ListOptions,
  GetOptions,
  AggregateOptions,
  CreateOptions,
  UpdateOptions,
  DeleteOptions,
  SubscribeOptions,
  SubscriptionCallbacks,
  Subscription,
} from "./types";
import { Transport, TransportError } from "./transport";
import { createSubscription, SubscriptionManager } from "./subscription-manager";
import { OfflineManager } from "./offline";

export interface RepositoryConfig {
  transport: Transport;
  resourcePath: string;
  idField?: string;
  offline?: OfflineManager;
}

export class Repository<T extends { id: string }> implements ResourceClient<T> {
  private transport: Transport;
  private resourcePath: string;
  private idField: keyof T;
  private offline?: OfflineManager;

  constructor(config: RepositoryConfig) {
    this.transport = config.transport;
    this.resourcePath = config.resourcePath;
    this.idField = (config.idField ?? "id") as keyof T;
    this.offline = config.offline;
  }

  async list(options: ListOptions = {}): Promise<PaginatedResponse<T>> {
    const params: Record<string, string | number | boolean | string[]> = {};

    if (options.filter) params.filter = options.filter;
    if (options.select) params.select = options.select.join(",");
    if (options.cursor) params.cursor = options.cursor;
    if (options.limit) params.limit = options.limit;
    if (options.orderBy) params.orderBy = options.orderBy;
    if (options.totalCount) params.totalCount = true;

    const response = await this.transport.request<PaginatedResponse<T>>({
      method: "GET",
      path: this.resourcePath,
      params,
    });

    return response.data;
  }

  async get(id: string, options: GetOptions = {}): Promise<T> {
    const params: Record<string, string | string[]> = {};

    if (options.select) params.select = options.select.join(",");

    const response = await this.transport.request<T>({
      method: "GET",
      path: `${this.resourcePath}/${id}`,
      params,
    });

    return response.data;
  }

  async count(filter?: string): Promise<number> {
    const params: Record<string, string> = {};
    if (filter) params.filter = filter;

    const response = await this.transport.request<{ count: number }>({
      method: "GET",
      path: `${this.resourcePath}/count`,
      params,
    });

    return response.data.count;
  }

  async aggregate(options: AggregateOptions): Promise<AggregationResponse> {
    const params: Record<string, string | boolean> = {};

    if (options.filter) params.filter = options.filter;
    if (options.groupBy) params.groupBy = options.groupBy.join(",");
    if (options.count) params.count = true;
    if (options.sum) params.sum = options.sum.join(",");
    if (options.avg) params.avg = options.avg.join(",");
    if (options.min) params.min = options.min.join(",");
    if (options.max) params.max = options.max.join(",");

    const response = await this.transport.request<AggregationResponse>({
      method: "GET",
      path: `${this.resourcePath}/aggregate`,
      params,
    });

    return response.data;
  }

  async create(data: Omit<T, "id">, options: CreateOptions = {}): Promise<T> {
    if (this.offline && !this.offline.getIsOnline() && options.optimistic) {
      await this.offline.queueMutation("create", this.resourcePath, data);
      return { ...data, id: `optimistic_${Date.now()}` } as T;
    }

    const response = await this.transport.request<T>({
      method: "POST",
      path: this.resourcePath,
      body: data,
    });

    return response.data;
  }

  async update(id: string, data: Partial<T>, options: UpdateOptions = {}): Promise<T> {
    if (this.offline && !this.offline.getIsOnline() && options.optimistic) {
      await this.offline.queueMutation("update", this.resourcePath, data, id);
      return { ...data, id } as T;
    }

    const response = await this.transport.request<T>({
      method: "PATCH",
      path: `${this.resourcePath}/${id}`,
      body: data,
    });

    return response.data;
  }

  async replace(id: string, data: Omit<T, "id">, options: UpdateOptions = {}): Promise<T> {
    if (this.offline && !this.offline.getIsOnline() && options.optimistic) {
      await this.offline.queueMutation("update", this.resourcePath, data, id);
      return { ...data, id } as T;
    }

    const response = await this.transport.request<T>({
      method: "PUT",
      path: `${this.resourcePath}/${id}`,
      body: data,
    });

    return response.data;
  }

  async delete(id: string, options: DeleteOptions = {}): Promise<void> {
    if (this.offline && !this.offline.getIsOnline() && options.optimistic) {
      await this.offline.queueMutation("delete", this.resourcePath, undefined, id);
      return;
    }

    await this.transport.request<void>({
      method: "DELETE",
      path: `${this.resourcePath}/${id}`,
    });
  }

  async batchCreate(items: Omit<T, "id">[]): Promise<T[]> {
    const response = await this.transport.request<{ items: T[] }>({
      method: "POST",
      path: `${this.resourcePath}/batch`,
      body: { items },
    });

    return response.data.items;
  }

  async batchUpdate(filter: string, data: Partial<T>): Promise<{ count: number }> {
    const response = await this.transport.request<{ count: number }>({
      method: "PATCH",
      path: `${this.resourcePath}/batch`,
      params: { filter },
      body: data,
    });

    return response.data;
  }

  async batchDelete(filter: string): Promise<{ count: number }> {
    const response = await this.transport.request<{ count: number }>({
      method: "DELETE",
      path: `${this.resourcePath}/batch`,
      params: { filter },
    });

    return response.data;
  }

  subscribe(
    options: SubscribeOptions = {},
    callbacks: SubscriptionCallbacks<T> = {}
  ): Subscription<T> {
    return createSubscription({
      transport: this.transport,
      resourcePath: this.resourcePath,
      idField: this.idField,
      options,
      callbacks,
    });
  }

  async rpc<TInput, TOutput>(name: string, input: TInput): Promise<TOutput> {
    const response = await this.transport.request<{ data: TOutput }>({
      method: "POST",
      path: `${this.resourcePath}/rpc/${name}`,
      body: input,
    });

    return response.data.data;
  }
}

export const createRepository = <T extends { id: string }>(
  config: RepositoryConfig
): ResourceClient<T> => {
  return new Repository<T>(config);
};
