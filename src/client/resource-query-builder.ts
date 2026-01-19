import type { Transport } from "./transport";
import type {
  NumericKeys,
  ComparableKeys,
  TypedAggregationResponse,
  TypedPaginatedResponse,
  QueryBuilderState,
} from "./query-types";

export class ResourceQueryBuilder<
  T extends { id: string },
  SelectedFields extends keyof T = keyof T,
  GroupKeys extends keyof T = never,
  SumKeys extends NumericKeys<T> = never,
  AvgKeys extends NumericKeys<T> = never,
  MinKeys extends ComparableKeys<T> = never,
  MaxKeys extends ComparableKeys<T> = never,
  HasCount extends boolean = false,
> {
  private readonly transport: Transport;
  private readonly resourcePath: string;
  private readonly state: QueryBuilderState<T>;

  constructor(
    transport: Transport,
    resourcePath: string,
    state: QueryBuilderState<T> = {}
  ) {
    this.transport = transport;
    this.resourcePath = resourcePath;
    this.state = state;
  }

  private clone<
    NewSelected extends keyof T = SelectedFields,
    NewGroupKeys extends keyof T = GroupKeys,
    NewSumKeys extends NumericKeys<T> = SumKeys,
    NewAvgKeys extends NumericKeys<T> = AvgKeys,
    NewMinKeys extends ComparableKeys<T> = MinKeys,
    NewMaxKeys extends ComparableKeys<T> = MaxKeys,
    NewHasCount extends boolean = HasCount,
  >(
    newState: Partial<QueryBuilderState<T>>
  ): ResourceQueryBuilder<
    T,
    NewSelected,
    NewGroupKeys,
    NewSumKeys,
    NewAvgKeys,
    NewMinKeys,
    NewMaxKeys,
    NewHasCount
  > {
    return new ResourceQueryBuilder(this.transport, this.resourcePath, {
      ...this.state,
      ...newState,
    });
  }

  select<K extends keyof T & string>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    K,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    const allFields = [...(this.state.select ?? []), ...fields] as K[];
    return this.clone<
      K,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys,
      HasCount
    >({
      select: allFields,
    });
  }

  filter(
    filter: string
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    const combinedFilter = this.state.filter
      ? `(${this.state.filter});(${filter})`
      : filter;
    return this.clone({ filter: combinedFilter });
  }

  where(
    filter: string
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.filter(filter);
  }

  orderBy(
    orderBy: string
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone({ orderBy });
  }

  limit(
    limit: number
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone({ limit });
  }

  cursor(
    cursor: string
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone({ cursor });
  }

  include(
    include: string
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone({ include });
  }

  withTotalCount(): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone({ totalCount: true });
  }

  groupBy<K extends keyof T & string>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    K,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    return this.clone<
      SelectedFields,
      K,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys,
      HasCount
    >({
      groupBy: fields,
    });
  }

  withCount(): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys,
    true
  > {
    return this.clone<
      SelectedFields,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys,
      true
    >({
      count: true,
    });
  }

  sum<K extends NumericKeys<T>>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys | K,
    AvgKeys,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    const allFields = [
      ...((this.state.sum ?? []) as NumericKeys<T>[]),
      ...fields,
    ] as (SumKeys | K)[];
    return this.clone<
      SelectedFields,
      GroupKeys,
      SumKeys | K,
      AvgKeys,
      MinKeys,
      MaxKeys,
      HasCount
    >({
      sum: allFields,
    });
  }

  avg<K extends NumericKeys<T>>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys | K,
    MinKeys,
    MaxKeys,
    HasCount
  > {
    const allFields = [
      ...((this.state.avg ?? []) as NumericKeys<T>[]),
      ...fields,
    ] as (AvgKeys | K)[];
    return this.clone<
      SelectedFields,
      GroupKeys,
      SumKeys,
      AvgKeys | K,
      MinKeys,
      MaxKeys,
      HasCount
    >({
      avg: allFields,
    });
  }

  min<K extends ComparableKeys<T>>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys | K,
    MaxKeys,
    HasCount
  > {
    const allFields = [
      ...((this.state.min ?? []) as ComparableKeys<T>[]),
      ...fields,
    ] as (MinKeys | K)[];
    return this.clone<
      SelectedFields,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys | K,
      MaxKeys,
      HasCount
    >({
      min: allFields,
    });
  }

  max<K extends ComparableKeys<T>>(
    ...fields: K[]
  ): ResourceQueryBuilder<
    T,
    SelectedFields,
    GroupKeys,
    SumKeys,
    AvgKeys,
    MinKeys,
    MaxKeys | K,
    HasCount
  > {
    const allFields = [
      ...((this.state.max ?? []) as ComparableKeys<T>[]),
      ...fields,
    ] as (MaxKeys | K)[];
    return this.clone<
      SelectedFields,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys | K,
      HasCount
    >({
      max: allFields,
    });
  }

  async list(): Promise<TypedPaginatedResponse<Pick<T, SelectedFields>>> {
    const params: Record<string, string | number | boolean> = {};

    if (this.state.filter) params.filter = this.state.filter;
    if (this.state.select && this.state.select.length > 0) {
      params.select = (this.state.select as string[]).join(",");
    }
    if (this.state.include) params.include = this.state.include;
    if (this.state.cursor) params.cursor = this.state.cursor;
    if (this.state.limit) params.limit = this.state.limit;
    if (this.state.orderBy) params.orderBy = this.state.orderBy;
    if (this.state.totalCount) params.totalCount = true;

    const response = await this.transport.request<
      TypedPaginatedResponse<Pick<T, SelectedFields>>
    >({
      method: "GET",
      path: this.resourcePath,
      params,
    });

    return response.data;
  }

  async get(id: string): Promise<Pick<T, SelectedFields>> {
    const params: Record<string, string> = {};

    if (this.state.select && this.state.select.length > 0) {
      params.select = (this.state.select as string[]).join(",");
    }
    if (this.state.include) params.include = this.state.include;

    const response = await this.transport.request<Pick<T, SelectedFields>>({
      method: "GET",
      path: `${this.resourcePath}/${id}`,
      params,
    });

    return response.data;
  }

  async first(): Promise<Pick<T, SelectedFields> | null> {
    const result = await this.limit(1).list();
    return result.items[0] ?? null;
  }

  async count(): Promise<number> {
    const params: Record<string, string> = {};
    if (this.state.filter) params.filter = this.state.filter;

    const response = await this.transport.request<{ count: number }>({
      method: "GET",
      path: `${this.resourcePath}/count`,
      params,
    });

    return response.data.count;
  }

  async aggregate(): Promise<
    TypedAggregationResponse<
      T,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys,
      HasCount
    >
  > {
    const params: Record<string, string | boolean> = {};

    if (this.state.filter) params.filter = this.state.filter;
    if (this.state.groupBy && this.state.groupBy.length > 0) {
      params.groupBy = (this.state.groupBy as string[]).join(",");
    }
    if (this.state.count) params.count = true;
    if (this.state.sum && this.state.sum.length > 0) {
      params.sum = (this.state.sum as string[]).join(",");
    }
    if (this.state.avg && this.state.avg.length > 0) {
      params.avg = (this.state.avg as string[]).join(",");
    }
    if (this.state.min && this.state.min.length > 0) {
      params.min = (this.state.min as string[]).join(",");
    }
    if (this.state.max && this.state.max.length > 0) {
      params.max = (this.state.max as string[]).join(",");
    }

    const response = await this.transport.request<
      TypedAggregationResponse<
        T,
        GroupKeys,
        SumKeys,
        AvgKeys,
        MinKeys,
        MaxKeys,
        HasCount
      >
    >({
      method: "GET",
      path: `${this.resourcePath}/aggregate`,
      params,
    });

    return response.data;
  }

  getState(): QueryBuilderState<T> {
    return { ...this.state };
  }
}

export const createResourceQueryBuilder = <T extends { id: string }>(
  transport: Transport,
  resourcePath: string
): ResourceQueryBuilder<T> => {
  return new ResourceQueryBuilder(transport, resourcePath);
};
