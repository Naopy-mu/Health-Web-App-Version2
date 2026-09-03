import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";

import { asAuthenticated } from "./pglite";

/**
 * PGlite を裏に置いた `SupabaseClient` の代替。
 *
 * `src/tests/fake-supabase.ts` は「API層がDBへ何を投げたか」を記録するだけで、
 * 応答はテストが台本として与える。冪等性の契約（実装仕様書 5.3節
 * 「同一 client_mutation_id の再送は競合状態でも必ず同一の成功応答を返す」）は
 * **DBのトリガー・制約とリポジトリの手順が噛み合って初めて成立する**ため、
 * 台本では検証にならない。ここでは supabase-js のチェーンを実SQLへ翻訳し、
 * migration を適用した実データベースに対してリポジトリをそのまま動かす。
 *
 * 対応するのはリポジトリが使う範囲だけ（select / insert / update / delete、
 * eq・gte・lte・is・order・limit、maybeSingle、rpc）。未対応の呼び出しは
 * 黙って通さず例外にする（テストが気づかないまま素通りするのを防ぐ）。
 * PostgREST 固有の `or()` フィルタ（キーセットページング）は翻訳しない。
 *
 * 実行は常に `role = authenticated` + JWT クレーム付き。RLS も本番同様に効く。
 */

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

const identifier = (name: string): string => {
  if (!IDENTIFIER.test(name)) {
    throw new Error(`unsupported identifier: ${name}`);
  }
  return name;
};

/** PostgREST の列リスト（`"a, b, c"`）をそのまま SQL の選択リストへ写す。 */
const columnList = (columns: string | undefined): string =>
  columns === undefined || columns.trim() === "*"
    ? "*"
    : columns
        .split(",")
        .map((column) => identifier(column.trim()))
        .join(", ");

type Filter = {
  readonly column: string;
  readonly op: "eq" | "gte" | "lte" | "is" | "in";
  value: unknown;
};

type PostgresLikeError = {
  code?: string;
  message?: string;
  detail?: string;
  constraint?: string;
};

/** PGlite の例外を PostgrestError 相当（`code` / `message` / `details`）へ写す。 */
const toPostgrestError = (cause: unknown) => {
  const error = cause as PostgresLikeError;
  return {
    code: error.code ?? "XX000",
    message: error.message ?? String(cause),
    details: [error.detail, error.constraint].filter(Boolean).join(" "),
    hint: "",
  };
};

export function createPglitePostgrest(db: PGlite, userId: string): SupabaseClient {
  const run = async (sql: string, params: unknown[]): Promise<Record<string, unknown>[]> =>
    asAuthenticated(db, userId, async () => {
      const result = await db.query<Record<string, unknown>>(sql, params);
      return result.rows;
    });

  const createBuilder = (
    table: string,
    kind: "select" | "insert" | "update" | "delete",
    values?: Record<string, unknown>,
  ) => {
    const filters: Filter[] = [];
    const orders: { column: string; ascending: boolean }[] = [];
    let columns: string | undefined;
    let limitValue: number | undefined;

    const build = (): { sql: string; params: unknown[] } => {
      const params: unknown[] = [];
      const placeholder = (value: unknown): string => {
        params.push(value);
        return `$${params.length}`;
      };

      const where = filters
        .map((filter) => {
          const column = identifier(filter.column);
          if (filter.op === "is") {
            if (filter.value !== null) {
              throw new Error("only `is(column, null)` is supported");
            }
            return `${column} is null`;
          }
          if (filter.op === "in") {
            // PostgREST の `.in()`。空配列でも成立するよう `= any(...)` で書く。
            return `${column} = any(${placeholder(filter.value)})`;
          }
          const operator = filter.op === "eq" ? "=" : filter.op === "gte" ? ">=" : "<=";
          return `${column} ${operator} ${placeholder(filter.value)}`;
        })
        .join(" and ");

      const returning = kind === "select" ? "" : ` returning ${columnList(columns)}`;
      const relation = `public.${identifier(table)}`;

      if (kind === "insert") {
        const entries = Object.entries(values ?? {});
        const names = entries.map(([name]) => identifier(name)).join(", ");
        const placeholders = entries.map(([, value]) => placeholder(value)).join(", ");
        return {
          sql: `insert into ${relation} (${names}) values (${placeholders})${returning}`,
          params,
        };
      }

      if (kind === "update") {
        const assignments = Object.entries(values ?? {})
          .map(([name, value]) => `${identifier(name)} = ${placeholder(value)}`)
          .join(", ");
        return {
          sql: `update ${relation} set ${assignments}${where === "" ? "" : ` where ${where}`}${returning}`,
          params,
        };
      }

      if (kind === "delete") {
        return {
          sql: `delete from ${relation}${where === "" ? "" : ` where ${where}`}${returning}`,
          params,
        };
      }

      const orderBy =
        orders.length === 0
          ? ""
          : ` order by ${orders
              .map((order) => `${identifier(order.column)} ${order.ascending ? "asc" : "desc"}`)
              .join(", ")}`;
      const limit = limitValue === undefined ? "" : ` limit ${Number(limitValue)}`;

      return {
        sql: `select ${columnList(columns)} from ${relation}${where === "" ? "" : ` where ${where}`}${orderBy}${limit}`,
        params,
      };
    };

    const execute = async (single: boolean) => {
      let rows: Record<string, unknown>[];
      try {
        const { sql, params } = build();
        rows = await run(sql, params);
      } catch (cause) {
        return { data: null, error: toPostgrestError(cause) };
      }

      if (!single) {
        return { data: rows, error: null };
      }
      if (rows.length > 1) {
        // PostgREST の `.maybeSingle()` と同じく、複数行は取得エラーにする。
        return {
          data: null,
          error: {
            code: "PGRST116",
            message: "JSON object requested, multiple (or no) rows returned",
            details: "",
            hint: "",
          },
        };
      }
      return { data: rows[0] ?? null, error: null };
    };

    const addFilter = (op: Filter["op"]) => (column: string, value: unknown) => {
      filters.push({ column, op, value });
      return builder;
    };

    const builder = {
      select(selected?: string) {
        columns = selected;
        return builder;
      },
      eq: addFilter("eq"),
      gte: addFilter("gte"),
      lte: addFilter("lte"),
      is: addFilter("is"),
      in: addFilter("in"),
      or() {
        throw new Error("or() is not supported by the PGlite-backed client");
      },
      order(column: string, config?: { ascending?: boolean }) {
        orders.push({ column, ascending: config?.ascending ?? true });
        return builder;
      },
      limit(count: number) {
        limitValue = count;
        return builder;
      },
      maybeSingle: () => execute(true),
      then<TResult1, TResult2 = never>(
        onFulfilled?: ((value: Awaited<ReturnType<typeof execute>>) => TResult1) | null,
        onRejected?: ((reason: unknown) => TResult2) | null,
      ) {
        return execute(false).then(onFulfilled, onRejected);
      },
    };

    return builder;
  };

  const client = {
    auth: {
      getUser: async () => ({ data: { user: { id: userId } }, error: null }),
    },
    rpc: async (name: string, args?: Record<string, unknown>) => {
      try {
        // 名前付き引数（`f(p_a => $1, ...)`）で呼ぶ。PostgREST と同じ渡し方。
        const entries = Object.entries(args ?? {});
        const params = entries.map(([, value]) =>
          value !== null && typeof value === "object" ? JSON.stringify(value) : value,
        );
        const argumentList = entries
          .map(([key], index) => `${identifier(key)} => $${index + 1}`)
          .join(", ");
        const rows = await run(`select * from public.${identifier(name)}(${argumentList})`, params);
        // スカラーを返す関数（`is_active_user()` など）は1列1行になる。
        const first = rows[0];
        if (rows.length === 1 && first !== undefined && Object.keys(first).length === 1) {
          const [only] = Object.keys(first);
          if (only === name) {
            return { data: first[only], error: null };
          }
        }
        return { data: rows, error: null };
      } catch (cause) {
        return { data: null, error: toPostgrestError(cause) };
      }
    },
    from: (table: string) => ({
      select: (columns?: string) => createBuilder(table, "select").select(columns),
      insert: (values: Record<string, unknown>) => createBuilder(table, "insert", values),
      update: (values: Record<string, unknown>) => createBuilder(table, "update", values),
      delete: () => createBuilder(table, "delete"),
    }),
  };

  return client as unknown as SupabaseClient;
}
