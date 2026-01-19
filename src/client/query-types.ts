export type NumericKeys<T> = {
  [K in keyof T]: T[K] extends number | null | undefined ? K : never;
}[keyof T] &
  string;

export type StringKeys<T> = {
  [K in keyof T]: T[K] extends string | null | undefined ? K : never;
}[keyof T] &
  string;

export type ComparableKeys<T> = {
  [K in keyof T]: T[K] extends number | string | Date | null | undefined
    ? K
    : never;
}[keyof T] &
  string;

export type DateKeys<T> = {
  [K in keyof T]: T[K] extends Date | null | undefined ? K : never;
}[keyof T] &
  string;

export type BooleanKeys<T> = {
  [K in keyof T]: T[K] extends boolean | null | undefined ? K : never;
}[keyof T] &
  string;

export type TypedAggregationGroup<
  T,
  GroupKeys extends keyof T,
  SumKeys extends keyof T,
  AvgKeys extends keyof T,
  MinKeys extends keyof T,
  MaxKeys extends keyof T,
  HasCount extends boolean,
> = {
  key: [GroupKeys] extends [never] ? null : Pick<T, GroupKeys>;
} & ([HasCount] extends [true] ? { count: number } : object) &
  ([SumKeys] extends [never] ? object : { sum: { [K in SumKeys]: number } }) &
  ([AvgKeys] extends [never] ? object : { avg: { [K in AvgKeys]: number } }) &
  ([MinKeys] extends [never] ? object : { min: { [K in MinKeys]: T[K] } }) &
  ([MaxKeys] extends [never] ? object : { max: { [K in MaxKeys]: T[K] } });

export interface TypedAggregationResponse<
  T,
  GroupKeys extends keyof T,
  SumKeys extends keyof T,
  AvgKeys extends keyof T,
  MinKeys extends keyof T,
  MaxKeys extends keyof T,
  HasCount extends boolean,
> {
  groups: Array<
    TypedAggregationGroup<
      T,
      GroupKeys,
      SumKeys,
      AvgKeys,
      MinKeys,
      MaxKeys,
      HasCount
    >
  >;
}

export interface TypedPaginatedResponse<T> {
  items: T[];
  nextCursor: string | null;
  hasMore: boolean;
  totalCount?: number;
}

export interface QueryBuilderState<T> {
  select?: (keyof T)[];
  filter?: string;
  orderBy?: string;
  limit?: number;
  cursor?: string;
  include?: string;
  totalCount?: boolean;
  groupBy?: (keyof T)[];
  count?: boolean;
  sum?: (keyof T)[];
  avg?: (keyof T)[];
  min?: (keyof T)[];
  max?: (keyof T)[];
}
