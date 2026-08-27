/**
 * Route Handler のテスト用の Supabase クライアント代替。
 *
 * 本物の PostgREST へは行かず、`from().select().eq()...` のチェーンを
 * **呼び出しの記録**へ変換し、テストが用意した応答を順に返す。
 * これにより次を実機なしで検証できる。
 *
 *   - 所有者が検証済みセッションから導出されているか
 *     （`eq("owner_id", <uid>)` が必ず付くか。実装仕様書 3.2節）
 *   - 楽観ロックの WHERE 句に `row_version` が入るか（実装仕様書 6.4節）
 *   - 0件・一意制約違反が実装仕様書 7章のどの応答になるか
 *
 * DB の振る舞いそのもの（制約・RLS・トリガー）は PGlite の
 * `tests/db/body-measurements*.test.ts` が実データで検証する。
 * ここは「API層がDBへ何を投げ、返り値をどう解釈するか」だけを見る。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export type FakeFilter = {
  readonly op: "eq" | "gte" | "lte" | "is";
  readonly column: string;
  readonly value: unknown;
};

export type FakeOperation = {
  readonly table: string;
  readonly kind: "select" | "insert" | "update" | "delete";
  columns?: string;
  readonly values?: Record<string, unknown>;
  readonly filters: FakeFilter[];
  readonly orders: { column: string; ascending: boolean }[];
  or?: string;
  limitValue?: number;
  single: boolean;
};

export type FakeError = {
  readonly code: string;
  readonly message: string;
  readonly details?: string;
  readonly hint?: string;
};

export type FakeResult = { readonly data: unknown; readonly error: FakeError | null };

/** `${kind}:${table}` をキーに、呼ばれた順で応答を返す。 */
export type FakeResponseScript = Record<string, readonly FakeResult[]>;

export type FakeSupabaseOptions = {
  /** `auth.getUser()` が返す利用者。`null` なら未認証。 */
  readonly user?: { id: string } | null;
  /** `rpc("is_active_user")` の結果。既定 `true`。 */
  readonly isActiveUser?: boolean;
  /** `${kind}:${table}` ごとの応答列。足りない分は空の成功応答になる。 */
  readonly responses?: FakeResponseScript;
  /** `rpc(name)` の応答（`is_active_user` を除く）。 */
  readonly rpc?: Record<string, FakeResult>;
};

const EMPTY: FakeResult = { data: null, error: null };

export type FakeSupabase = {
  readonly client: SupabaseClient;
  /** 実行された順の全操作。所有者条件や WHERE 句の検証に使う。 */
  readonly operations: FakeOperation[];
  /** 呼ばれた RPC 名。 */
  readonly rpcCalls: string[];
};

export function createFakeSupabase(options: FakeSupabaseOptions = {}): FakeSupabase {
  const operations: FakeOperation[] = [];
  const rpcCalls: string[] = [];
  const queues = new Map<string, FakeResult[]>(
    Object.entries(options.responses ?? {}).map(([key, results]) => [key, [...results]]),
  );

  const nextResult = (operation: FakeOperation): FakeResult => {
    const queue = queues.get(`${operation.kind}:${operation.table}`);
    const result = queue?.shift();
    if (result !== undefined) {
      return result;
    }
    // 既定は「該当なし」。単数取得は null、複数取得は空配列。
    return operation.single ? EMPTY : { data: [], error: null };
  };

  const createBuilder = (
    table: string,
    kind: FakeOperation["kind"],
    values?: Record<string, unknown>,
  ) => {
    const operation: FakeOperation = {
      table,
      kind,
      values,
      filters: [],
      orders: [],
      single: false,
    };

    const run = (): FakeResult => {
      operations.push(operation);
      return nextResult(operation);
    };

    const addFilter = (op: FakeFilter["op"]) => (column: string, value: unknown) => {
      operation.filters.push({ op, column, value });
      return builder;
    };

    const builder = {
      select(columns?: string) {
        operation.columns = columns;
        return builder;
      },
      eq: addFilter("eq"),
      gte: addFilter("gte"),
      lte: addFilter("lte"),
      is: addFilter("is"),
      or(expression: string) {
        operation.or = expression;
        return builder;
      },
      order(column: string, config?: { ascending?: boolean }) {
        operation.orders.push({ column, ascending: config?.ascending ?? true });
        return builder;
      },
      limit(count: number) {
        operation.limitValue = count;
        return builder;
      },
      maybeSingle() {
        operation.single = true;
        return Promise.resolve(run());
      },
      then<TResult1 = FakeResult, TResult2 = never>(
        onFulfilled?: ((value: FakeResult) => TResult1 | PromiseLike<TResult1>) | null,
        onRejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
      ) {
        return Promise.resolve(run()).then(onFulfilled, onRejected);
      },
    };

    return builder;
  };

  const client = {
    auth: {
      getUser: async () => ({
        data: { user: options.user === undefined ? { id: DEFAULT_USER_ID } : options.user },
        error: null,
      }),
    },
    rpc: async (name: string) => {
      rpcCalls.push(name);
      if (name === "is_active_user") {
        return { data: options.isActiveUser ?? true, error: null };
      }
      return options.rpc?.[name] ?? EMPTY;
    },
    from: (table: string) => ({
      select: (columns?: string) => createBuilder(table, "select").select(columns),
      insert: (values: Record<string, unknown>) => createBuilder(table, "insert", values),
      update: (values: Record<string, unknown>) => createBuilder(table, "update", values),
      delete: () => createBuilder(table, "delete"),
    }),
  };

  return { client: client as unknown as SupabaseClient, operations, rpcCalls };
}

/** テストで使い回す固定の所有者ID（`auth.users.id` = `owner_id`）。 */
export const DEFAULT_USER_ID = "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d";

/** 一意制約違反（PostgreSQL 23505）の擬似エラー。 */
export const uniqueViolation = (constraint: string): FakeError => ({
  code: "23505",
  message: `duplicate key value violates unique constraint "${constraint}"`,
  details: "Key already exists.",
});
