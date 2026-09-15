import "server-only";

/**
 * サプリメントの永続化（実装仕様書 5.6節 / 6.4節 / 9.2節）。
 *
 * ここが守る約束（Phase 3a / 4-1a のリポジトリと同じ）:
 *
 * 1. **所有者はセッション由来**（実装仕様書 3.2節）。全クエリに
 *    `owner_id = <session uid>` を明示し、RLS を最終防衛線として二重に効かせる。
 * 2. **楽観ロック**（実装仕様書 6.4節）。更新・削除は
 *    `id + owner_id + row_version` を WHERE 句に含め、0件を 409 として扱う。
 *    行が無い場合と版番号が古い場合を区別しない（他利用者の行の存在を漏らさない）。
 * 3. **冪等キー**（実装仕様書 5.6節・6.4節）。`client_mutation_id` が適用済みなら、
 *    同じ成功応答（`idempotent_replay`）を返す。適用済みかどうかは行の現在値では
 *    なく、追記専用の `supplement_mutation_log`（migration 20260915000300）を
 *    引いて決める。行の `client_mutation_id` は次のミューテーションで上書きされる
 *    ため、それだけでは**何世代か前のキーでの再送**を「未適用」と誤判定してしまう。
 * 4. **在庫を動かす操作は必ず原子的RPC経由**（実装仕様書 5.6節）。
 *    服用の記録・取消は `record_supplement_intake` / `void_supplement_intake` を
 *    呼ぶ。テーブルへ直接書く経路はそもそも権限が無い（migration 20260915000200）。
 * 5. SQL は `@supabase/supabase-js`（パラメータ化されたSDK）と
 *    管理済みDB関数だけで実行する（実装仕様書 9.2節）。
 *
 * すべての失敗は実装仕様書 7章の `{ error: { code, message } }` 形式の
 * `Response` として返す。エラーコード一覧は `docs/api/supplements.md`。
 */

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type {
  IntakeOutcome,
  MutationOutcome,
  SupplementDeletableResource,
  SupplementIntake,
  SupplementIntakeInput,
  SupplementListQuery,
  SupplementLot,
  SupplementLotInput,
  SupplementMovement,
  SupplementProduct,
  SupplementProductInput,
  SupplementSchedule,
  SupplementScheduleInput,
  SupplementStock,
  SupplementSummary,
  SupplementVoidInput,
  VoidOutcome,
} from "@/features/supplements/schema";
import { DEFAULT_TIMEZONE } from "@/features/supplements/schema";

import {
  accountInactive,
  authenticationRequired,
  invalidRequest,
  supplementConflict,
  supplementDuplicateConflict,
  supplementInsufficientStock,
  supplementLotInUse,
  supplementNotFound,
  supplementProductArchived,
  supplementProductNotFound,
  supplementUnitMismatch,
} from "../api/errors";
import type { GuardResult } from "../api/guards";
import { decodeSupplementCursor, encodeSupplementCursor, keysetFilter } from "./cursor";
import {
  EMPTY_STOCK,
  SUPPLEMENT_INTAKE_COLUMNS,
  SUPPLEMENT_LOT_COLUMNS,
  SUPPLEMENT_MOVEMENT_COLUMNS,
  SUPPLEMENT_PRODUCT_COLUMNS,
  SUPPLEMENT_SCHEDULE_COLUMNS,
  toSupplementIntake,
  toSupplementLot,
  toSupplementMovement,
  toSupplementProduct,
  toSupplementSchedule,
  toSupplementStock,
  toSupplementSummary,
  UNKNOWN_PRODUCT_LABEL,
  type ProductLabel,
  type SupplementIntakeRow,
  type SupplementLotRow,
  type SupplementMovementRow,
  type SupplementProductRow,
  type SupplementScheduleRow,
  type SupplementStockRow,
  type SupplementSummaryRow,
} from "./rows";

export const SUPPLEMENT_PRODUCTS_TABLE = "supplement_products";
export const SUPPLEMENT_SCHEDULES_TABLE = "supplement_schedules";
export const SUPPLEMENT_LOTS_TABLE = "supplement_inventory_lots";
export const SUPPLEMENT_INTAKE_LOGS_TABLE = "supplement_intake_logs";
export const SUPPLEMENT_MOVEMENTS_TABLE = "supplement_inventory_movements";

/**
 * 冪等キーの適用結果（スナップショット）の追記先。
 * 書き手は DB トリガーだけで、API は読むだけ（migration 20260915000300）。
 */
export const SUPPLEMENT_MUTATION_LOG_TABLE = "supplement_mutation_log";

export const RECORD_INTAKE_RPC = "record_supplement_intake";
export const VOID_INTAKE_RPC = "void_supplement_intake";
export const PRODUCT_STOCK_RPC = "supplement_product_stock";
export const SUMMARY_RPC = "supplement_summary";

/** PostgreSQL のエラーコード（実装仕様書 6.4節の 409 判定などに使う）。 */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";
const PG_INVALID_PARAMETER_VALUE = "22023";
const PG_INSUFFICIENT_PRIVILEGE = "42501";
const PG_INVALID_AUTHORIZATION = "28000";

/** PostgREST のエラー本文に制約名・トリガーの文言が現れるかを見る。 */
const violates = (error: PostgrestError, fragment: string): boolean =>
  `${error.message} ${error.details ?? ""}`.includes(fragment);

/**
 * 想定内の PostgreSQL エラーを実装仕様書 7章の応答へ写す。
 * 想定外は 400（`INVALID_REQUEST`）にまとめ、DB のメッセージを外へ出さない
 * （実装仕様書 9.2節: 健康データ・内部情報をログや応答へ出さない）。
 */
function mapUnexpectedError(error: PostgrestError): Response {
  if (error.code === PG_INVALID_AUTHORIZATION) {
    // RPC が `auth.uid()` を得られなかった。セッションが処理中に切れた場合など。
    return authenticationRequired();
  }
  if (error.code === PG_INSUFFICIENT_PRIVILEGE) {
    // RLS・列レベル権限に弾かれたか、RPC が `is_active_user()` を false と判定した。
    return accountInactive();
  }
  if (error.code === PG_FOREIGN_KEY_VIOLATION) {
    // 商品・予定の複合外部キー、または RPC の明示的な所有者チェック。
    if (violates(error, "supplement schedule not found")) {
      return supplementNotFound();
    }
    return supplementProductNotFound();
  }
  if (error.code === PG_CHECK_VIOLATION) {
    // migration 20260915000100 / 000400 のガードが投げる文言を、利用者に伝わる
    // コードへ写す（DB のメッセージそのものは外へ出さない）。
    if (violates(error, "insufficient supplement inventory")) {
      return supplementInsufficientStock();
    }
    if (violates(error, "is archived")) {
      return supplementProductArchived();
    }
    if (violates(error, "must match the supplement product default unit")) {
      return supplementUnitMismatch(
        "在庫の単位は商品の既定単位と同じにしてください（在庫は商品の単位で数えます）。",
      );
    }
    if (violates(error, "used by a recorded intake and cannot be deleted")) {
      return supplementLotInUse();
    }
    if (violates(error, "supplement_inventory_lots_remaining")) {
      // CHECK 制約の最終防衛線に当たった（RPC のロックをすり抜けた同時実行など）。
      return supplementInsufficientStock();
    }
    return invalidRequest("入力値がこの項目の制約を満たしていません。");
  }
  if (error.code === PG_INVALID_PARAMETER_VALUE) {
    if (violates(error, "consume quantity is required")) {
      return supplementUnitMismatch(
        "服用の単位が在庫の単位と違います。在庫から引く量（consumeQuantity）を指定してください。",
      );
    }
    if (violates(error, "amount is required")) {
      return invalidRequest("この商品には既定量が無いため、服用量を指定してください。");
    }
    return invalidRequest("リクエストの内容が正しくありません。");
  }
  return invalidRequest("データを処理できませんでした。");
}

/* -------------------------------------------------------------------------- */
/* 冪等キーの引き当て（実装仕様書 5.6節・6.4節）                               */
/* -------------------------------------------------------------------------- */

/**
 * `client_mutation_id` の適用結果を履歴から引く。
 *
 * 参照先は行そのものではなく `supplement_mutation_log`。行の
 * `client_mutation_id` は次のミューテーションで上書きされるため、行を引くと
 * 「2つ前の再送」が未適用に見えて 409 になってしまう。
 * ログは追記専用なので、**何世代前のキーでも**引き当てられる。
 *
 * 返すのは適用**当時**の行のスナップショットで、現在の行ではない。再送は
 * 「あのときの応答をもう一度受け取る」操作であり、その後の別ミューテーションが
 * 進めた版番号を返してはならない（実装仕様書 8.1節のキューは応答の
 * `rowVersion` を次の基準版として使う）。
 */
async function findMutationSnapshot<Row>(
  supabase: SupabaseClient,
  ownerId: string,
  resource: string,
  clientMutationId: string,
): Promise<GuardResult<Row | null>> {
  const { data, error } = await supabase
    .from(SUPPLEMENT_MUTATION_LOG_TABLE)
    .select("snapshot")
    .eq("owner_id", ownerId)
    .eq("resource", resource)
    .eq("client_mutation_id", clientMutationId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  if (data === null) {
    return { ok: true, value: null };
  }

  const { snapshot } = data as unknown as { snapshot: Row | null };
  return { ok: true, value: snapshot ?? null };
}

/* -------------------------------------------------------------------------- */
/* 商品カタログ                                                                */
/* -------------------------------------------------------------------------- */

/**
 * 所有者の商品一式と在庫要約。
 * 記録・予定・ロットのラベル解決、アーカイブ判定、低在庫の判定に使う。
 */
export type SupplementCatalog = {
  readonly all: readonly SupplementProduct[];
  readonly byId: ReadonlyMap<string, SupplementProduct>;
  readonly labelById: ReadonlyMap<string, ProductLabel>;
};

export const productLabel = (product: SupplementProduct): ProductLabel => ({
  key: product.productKey,
  name: product.name,
});

const labelOf = (catalog: SupplementCatalog, productId: string): ProductLabel =>
  catalog.labelById.get(productId) ?? UNKNOWN_PRODUCT_LABEL;

/** 商品ごとの在庫要約を1回の RPC でまとめて引く（N+1 を作らない）。 */
async function loadStockIndex(
  supabase: SupabaseClient,
): Promise<GuardResult<ReadonlyMap<string, SupplementStockRow>>> {
  const { data, error } = await supabase.rpc(PRODUCT_STOCK_RPC);
  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  const rows = (data ?? []) as unknown as SupplementStockRow[];
  return { ok: true, value: new Map(rows.map((row) => [row.product_id, row])) };
}

export async function loadCatalog(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<SupplementCatalog>> {
  const stock = await loadStockIndex(supabase);
  if (!stock.ok) {
    return stock;
  }

  // アーカイブ済みも含めて全件返す。過去の記録のラベル解決に要るため
  // （docs/api/supplements.md 2節）。並びは正規化名（表示順と同じ）。
  const { data, error } = await supabase
    .from(SUPPLEMENT_PRODUCTS_TABLE)
    .select(SUPPLEMENT_PRODUCT_COLUMNS)
    .eq("owner_id", ownerId)
    .order("name_normalized", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as SupplementProductRow[];
  const products = rows.map((row) =>
    toSupplementProduct(
      row,
      toSupplementStock(
        stock.value.get(row.id),
        row.low_stock_threshold === null ? null : Number(row.low_stock_threshold),
      ),
    ),
  );

  return {
    ok: true,
    value: {
      all: products,
      byId: new Map(products.map((product) => [product.id, product])),
      labelById: new Map(products.map((product) => [product.id, productLabel(product)])),
    },
  };
}

/** 保存の応答へ同梱する、その商品1件ぶんの在庫要約を引き直す。 */
export async function loadProductStock(
  supabase: SupabaseClient,
  productId: string,
  lowStockThreshold: number | null,
): Promise<GuardResult<SupplementStock>> {
  const stock = await loadStockIndex(supabase);
  if (!stock.ok) {
    return stock;
  }
  return { ok: true, value: toSupplementStock(stock.value.get(productId), lowStockThreshold) };
}

/** 実装仕様書 5.6節「集計」。 */
export async function loadSummary(
  supabase: SupabaseClient,
): Promise<GuardResult<SupplementSummary>> {
  const { data, error } = await supabase.rpc(SUMMARY_RPC);
  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  const rows = (data ?? []) as unknown as SupplementSummaryRow[];
  return { ok: true, value: toSupplementSummary(rows[0]) };
}

/* -------------------------------------------------------------------------- */
/* 一覧・1件取得                                                               */
/* -------------------------------------------------------------------------- */

export type Page<T> = {
  readonly entries: readonly T[];
  readonly nextCursor: string | null;
};

/** リソースごとの時間軸（キーセットページングの基準列）。 */
const TIME_COLUMNS = {
  schedule: "created_at",
  lot: "created_at",
  intake: "recorded_at",
  movement: "occurred_at",
} as const;

const TIME_FIELDS = {
  schedule: "createdAt",
  lot: "createdAt",
  intake: "recordedAt",
  movement: "occurredAt",
} as const;

type ListResource = keyof typeof TIME_COLUMNS;

const TABLES: Readonly<Record<ListResource, string>> = Object.freeze({
  schedule: SUPPLEMENT_SCHEDULES_TABLE,
  lot: SUPPLEMENT_LOTS_TABLE,
  intake: SUPPLEMENT_INTAKE_LOGS_TABLE,
  movement: SUPPLEMENT_MOVEMENTS_TABLE,
});

const COLUMNS: Readonly<Record<ListResource, string>> = Object.freeze({
  schedule: SUPPLEMENT_SCHEDULE_COLUMNS,
  lot: SUPPLEMENT_LOT_COLUMNS,
  intake: SUPPLEMENT_INTAKE_COLUMNS,
  movement: SUPPLEMENT_MOVEMENT_COLUMNS,
});

/**
 * 一覧の共通部分。時間軸の列名と絞り込みだけリソースごとに差し替える。
 *
 * 次ページの有無を知るために1件多く読む。
 */
async function listRows<Row extends { id: string }>(
  supabase: SupabaseClient,
  ownerId: string,
  resource: ListResource,
  query: SupplementListQuery,
): Promise<GuardResult<{ rows: Row[]; hasMore: boolean }>> {
  const ascending = query.order === "asc";
  const timeColumn = TIME_COLUMNS[resource];

  let builder = supabase.from(TABLES[resource]).select(COLUMNS[resource]).eq("owner_id", ownerId);

  if (query.productId !== undefined) {
    builder = builder.eq("product_id", query.productId);
  }
  if (resource === "intake" && query.status !== undefined) {
    builder = builder.eq("status", query.status);
  }
  if (query.from !== undefined) {
    builder = builder.gte(timeColumn, query.from);
  }
  if (query.to !== undefined) {
    builder = builder.lte(timeColumn, query.to);
  }

  if (query.cursor !== undefined) {
    const cursor = decodeSupplementCursor(query.cursor);
    if (cursor === null) {
      return { ok: false, response: invalidRequest("cursor の形式が正しくありません。") };
    }
    builder = builder.or(keysetFilter(cursor, timeColumn, query.order));
  }

  const { data, error } = await builder
    .order(timeColumn, { ascending })
    .order("id", { ascending })
    .limit(query.limit + 1);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as Row[];
  const hasMore = rows.length > query.limit;
  return { ok: true, value: { rows: hasMore ? rows.slice(0, query.limit) : rows, hasMore } };
}

function paginate<T extends { id: string }>(
  entries: readonly T[],
  hasMore: boolean,
  timestampOf: (entry: T) => string,
): Page<T> {
  const last = entries.at(-1);
  return {
    entries,
    nextCursor:
      hasMore && last !== undefined
        ? encodeSupplementCursor({ timestamp: timestampOf(last), id: last.id })
        : null,
  };
}

/**
 * 主キーによる1件取得（実装仕様書 6.4節 / docs/api/supplements.md 1.7節）。
 *
 * **409 のあとに対象行を特定する第一手段**。一覧の `limit` にも、日時・商品に
 * よる絞り込みにも一切依存しない。
 *
 * 日時や商品で引き直す方法だと、競合した側の更新が**その日時・商品自体を
 * 変更していた**場合に0件になり、「削除された」と誤判定してしまう（行はまだある）。
 * 主キーは行の生存期間中ずっと変わらないので、
 * **「0件 ＝ 本当に削除された（またはもう所有していない）」が正しく成立する**。
 *
 * 所有者はセッション由来。`owner_id` を必ず WHERE に入れ、RLS を二重に効かせる。
 */
async function getRowById<Row>(
  supabase: SupabaseClient,
  ownerId: string,
  resource: ListResource,
  id: string,
): Promise<GuardResult<Row | null>> {
  const { data, error } = await supabase
    .from(TABLES[resource])
    .select(COLUMNS[resource])
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  return { ok: true, value: (data as unknown as Row | null) ?? null };
}

export async function listSchedules(
  supabase: SupabaseClient,
  ownerId: string,
  query: SupplementListQuery,
  catalog: SupplementCatalog,
): Promise<GuardResult<Page<SupplementSchedule>>> {
  if (query.id !== undefined) {
    const row = await getRowById<SupplementScheduleRow>(supabase, ownerId, "schedule", query.id);
    if (!row.ok) {
      return row;
    }
    return {
      ok: true,
      value: {
        entries:
          row.value === null
            ? []
            : [toSupplementSchedule(row.value, labelOf(catalog, row.value.product_id))],
        nextCursor: null,
      },
    };
  }

  const page = await listRows<SupplementScheduleRow>(supabase, ownerId, "schedule", query);
  if (!page.ok) {
    return page;
  }
  const entries = page.value.rows.map((row) =>
    toSupplementSchedule(row, labelOf(catalog, row.product_id)),
  );
  return {
    ok: true,
    value: paginate(entries, page.value.hasMore, (entry) => entry[TIME_FIELDS.schedule]),
  };
}

export async function listLots(
  supabase: SupabaseClient,
  ownerId: string,
  query: SupplementListQuery,
  catalog: SupplementCatalog,
): Promise<GuardResult<Page<SupplementLot>>> {
  if (query.id !== undefined) {
    const row = await getRowById<SupplementLotRow>(supabase, ownerId, "lot", query.id);
    if (!row.ok) {
      return row;
    }
    return {
      ok: true,
      value: {
        entries:
          row.value === null
            ? []
            : [toSupplementLot(row.value, labelOf(catalog, row.value.product_id))],
        nextCursor: null,
      },
    };
  }

  const page = await listRows<SupplementLotRow>(supabase, ownerId, "lot", query);
  if (!page.ok) {
    return page;
  }
  const entries = page.value.rows.map((row) =>
    toSupplementLot(row, labelOf(catalog, row.product_id)),
  );
  return {
    ok: true,
    value: paginate(entries, page.value.hasMore, (entry) => entry[TIME_FIELDS.lot]),
  };
}

export async function listIntakes(
  supabase: SupabaseClient,
  ownerId: string,
  query: SupplementListQuery,
  catalog: SupplementCatalog,
): Promise<GuardResult<Page<SupplementIntake>>> {
  if (query.id !== undefined) {
    const row = await getRowById<SupplementIntakeRow>(supabase, ownerId, "intake", query.id);
    if (!row.ok) {
      return row;
    }
    return {
      ok: true,
      value: {
        entries:
          row.value === null
            ? []
            : [toSupplementIntake(row.value, labelOf(catalog, row.value.product_id))],
        nextCursor: null,
      },
    };
  }

  const page = await listRows<SupplementIntakeRow>(supabase, ownerId, "intake", query);
  if (!page.ok) {
    return page;
  }
  const entries = page.value.rows.map((row) =>
    toSupplementIntake(row, labelOf(catalog, row.product_id)),
  );
  return {
    ok: true,
    value: paginate(entries, page.value.hasMore, (entry) => entry[TIME_FIELDS.intake]),
  };
}

export async function listMovements(
  supabase: SupabaseClient,
  ownerId: string,
  query: SupplementListQuery,
  catalog: SupplementCatalog,
): Promise<GuardResult<Page<SupplementMovement>>> {
  if (query.id !== undefined) {
    const row = await getRowById<SupplementMovementRow>(supabase, ownerId, "movement", query.id);
    if (!row.ok) {
      return row;
    }
    return {
      ok: true,
      value: {
        entries:
          row.value === null
            ? []
            : [toSupplementMovement(row.value, labelOf(catalog, row.value.product_id))],
        nextCursor: null,
      },
    };
  }

  const page = await listRows<SupplementMovementRow>(supabase, ownerId, "movement", query);
  if (!page.ok) {
    return page;
  }
  const entries = page.value.rows.map((row) =>
    toSupplementMovement(row, labelOf(catalog, row.product_id)),
  );
  return {
    ok: true,
    value: paginate(entries, page.value.hasMore, (entry) => entry[TIME_FIELDS.movement]),
  };
}

/* -------------------------------------------------------------------------- */
/* 商品の保存                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * `archived` の指定を `archived_at` の値へ写す。
 *
 * - `true`: 既にアーカイブ済みならその日時を保つ（再送で日時が動かない）
 * - `false`: 解除
 * - 省略: 現在の値のまま（アーカイブ状態を意図せず解除しない）
 */
function resolveArchivedAt(
  archived: boolean | undefined,
  currentArchivedAt: string | null,
): string | null {
  if (archived === true) {
    return currentArchivedAt ?? new Date().toISOString();
  }
  if (archived === false) {
    return null;
  }
  return currentArchivedAt;
}

export async function saveProduct(
  supabase: SupabaseClient,
  ownerId: string,
  input: SupplementProductInput,
  clientMutationId: string | undefined,
  catalog: SupplementCatalog,
): Promise<GuardResult<{ product: SupplementProduct; outcome: MutationOutcome }>> {
  const replay = async (): Promise<GuardResult<SupplementProductRow | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    return findMutationSnapshot<SupplementProductRow>(
      supabase,
      ownerId,
      SUPPLEMENT_PRODUCTS_TABLE,
      clientMutationId,
    );
  };

  // 在庫要約はスナップショットに含まれない（別テーブルの集計なので）。
  // 再送でも現在の在庫を載せる——版番号を進めないことが replay の本質であり、
  // 在庫は版番号とは無関係に動き続ける値だから。
  const finish = async (
    row: SupplementProductRow,
    outcome: MutationOutcome,
  ): Promise<GuardResult<{ product: SupplementProduct; outcome: MutationOutcome }>> => {
    const threshold = row.low_stock_threshold === null ? null : Number(row.low_stock_threshold);
    const stock = await loadProductStock(supabase, row.id, threshold);
    if (!stock.ok) {
      return stock;
    }
    return { ok: true, value: { product: toSupplementProduct(row, stock.value), outcome } };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return finish(first.value, "idempotent_replay");
  }

  let currentArchivedAt: string | null = null;
  if (input.id !== undefined) {
    const existing = catalog.byId.get(input.id);
    if (existing === undefined) {
      return { ok: false, response: supplementProductNotFound() };
    }
    currentArchivedAt = existing.archivedAt;
  }

  const patch = {
    name: input.name,
    brand: input.brand ?? null,
    category: input.category,
    form: input.form,
    default_amount: input.defaultAmount ?? null,
    default_unit: input.defaultUnit,
    amount_per_container: input.amountPerContainer ?? null,
    low_stock_threshold: input.lowStockThreshold ?? null,
    ingredient_note: input.ingredientNote ?? null,
    safety_note: input.safetyNote ?? null,
    url: input.url ?? null,
    client_mutation_id: clientMutationId ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(SUPPLEMENT_PRODUCTS_TABLE)
      .update({ ...patch, archived_at: resolveArchivedAt(input.archived, currentArchivedAt) })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(SUPPLEMENT_PRODUCT_COLUMNS)
      .maybeSingle();

    // 実装仕様書 6.4節: 同じ冪等キーの同時到達は「再送」であって競合ではない。
    // 先着が版番号を進めたあとに届いた側は 0 件更新／一意制約違反になるため、
    // 409 を返す前に必ず冪等キーで既存の成功結果を探し直す。
    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return finish(retry.value, "idempotent_replay");
      }
      if (error === null || error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: supplementDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return finish(data as unknown as SupplementProductRow, "updated");
  }

  const { data, error } = await supabase
    .from(SUPPLEMENT_PRODUCTS_TABLE)
    .insert({
      // 実装仕様書 3.2節: 所有者は検証済みセッション由来。ボディの値は使わない。
      owner_id: ownerId,
      product_key: input.productKey,
      ...patch,
      archived_at: resolveArchivedAt(input.archived, null),
    })
    .select(SUPPLEMENT_PRODUCT_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // 冪等キー・商品キー・名称のどの一意制約が先に反応するかは決められないため、
      // 冪等キーがあるときは必ずログを読み直す（再送をエラーにしない）。
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return finish(retry.value, "idempotent_replay");
      }
      return { ok: false, response: supplementDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: supplementDuplicateConflict() };
  }

  return finish(data as unknown as SupplementProductRow, "created");
}

/* -------------------------------------------------------------------------- */
/* 摂取予定の保存                                                              */
/* -------------------------------------------------------------------------- */

export async function saveSchedule(
  supabase: SupabaseClient,
  ownerId: string,
  input: SupplementScheduleInput,
  clientMutationId: string | undefined,
  catalog: SupplementCatalog,
): Promise<GuardResult<{ schedule: SupplementSchedule; outcome: MutationOutcome }>> {
  const convert = (row: SupplementScheduleRow): SupplementSchedule =>
    toSupplementSchedule(row, labelOf(catalog, row.product_id));

  const replay = async (): Promise<GuardResult<SupplementSchedule | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<SupplementScheduleRow>(
      supabase,
      ownerId,
      SUPPLEMENT_SCHEDULES_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    return { ok: true, value: snapshot.value === null ? null : convert(snapshot.value) };
  };

  // 入力の検査より先に冪等ログを引く（実装仕様書 6.4節 / 8章のオフライン同期）。
  //
  // 適用済みの `clientMutationId` は「何世代前でも同じ成功応答を返す」契約であり、
  // その判断に**現在**の商品の状態を混ぜてはならない。先に商品を検査していると、
  // 保存に成功したあとで利用者がその商品をアーカイブした場合、送信キューに
  // 残っていた同じキーの再送が 400 になってしまう
  // （オフライン同期では普通に起こる順序）。
  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { schedule: first.value, outcome: "idempotent_replay" } };
  }

  // ここから先は「まだ適用されていない操作」。入力として商品を検査する。
  const product = catalog.byId.get(input.productId);
  if (product === undefined) {
    return { ok: false, response: supplementProductNotFound() };
  }
  if (input.id === undefined && product.archivedAt !== null) {
    return { ok: false, response: supplementProductArchived() };
  }

  let currentArchivedAt: string | null = null;
  if (input.id !== undefined) {
    const existing = await getRowById<SupplementScheduleRow>(
      supabase,
      ownerId,
      "schedule",
      input.id,
    );
    if (!existing.ok) {
      return existing;
    }
    if (existing.value === null) {
      return { ok: false, response: supplementNotFound() };
    }
    currentArchivedAt =
      existing.value.archived_at === null
        ? null
        : new Date(existing.value.archived_at).toISOString();
  }

  const patch = {
    product_id: input.productId,
    schedule_kind: input.scheduleKind,
    time_of_day: input.timeOfDay ?? null,
    timezone: input.timezone ?? DEFAULT_TIMEZONE,
    weekdays: input.weekdays ?? null,
    start_date: input.startDate,
    end_date: input.endDate ?? null,
    amount: input.amount,
    unit: input.unit,
    meal_relation: input.mealRelation ?? "unspecified",
    note: input.note ?? null,
    archived_at: resolveArchivedAt(input.archived, currentArchivedAt),
    client_mutation_id: clientMutationId ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(SUPPLEMENT_SCHEDULES_TABLE)
      .update(patch)
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(SUPPLEMENT_SCHEDULE_COLUMNS)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return { ok: true, value: { schedule: retry.value, outcome: "idempotent_replay" } };
      }
      if (error === null) {
        return { ok: false, response: supplementConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: supplementDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: { schedule: convert(data as unknown as SupplementScheduleRow), outcome: "updated" },
    };
  }

  const { data, error } = await supabase
    .from(SUPPLEMENT_SCHEDULES_TABLE)
    .insert({ owner_id: ownerId, ...patch })
    .select(SUPPLEMENT_SCHEDULE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { schedule: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: supplementDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: supplementConflict() };
  }

  return {
    ok: true,
    value: { schedule: convert(data as unknown as SupplementScheduleRow), outcome: "created" },
  };
}

/* -------------------------------------------------------------------------- */
/* 在庫ロットの保存                                                            */
/* -------------------------------------------------------------------------- */

export async function saveLot(
  supabase: SupabaseClient,
  ownerId: string,
  input: SupplementLotInput,
  clientMutationId: string | undefined,
  catalog: SupplementCatalog,
): Promise<GuardResult<{ lot: SupplementLot; stock: SupplementStock; outcome: MutationOutcome }>> {
  const convert = (row: SupplementLotRow): SupplementLot =>
    toSupplementLot(row, labelOf(catalog, row.product_id));

  const finish = async (
    row: SupplementLotRow,
    outcome: MutationOutcome,
  ): Promise<
    GuardResult<{ lot: SupplementLot; stock: SupplementStock; outcome: MutationOutcome }>
  > => {
    const product = catalog.byId.get(row.product_id);
    const stock = await loadProductStock(
      supabase,
      row.product_id,
      product?.lowStockThreshold ?? null,
    );
    if (!stock.ok) {
      return stock;
    }
    return { ok: true, value: { lot: convert(row), stock: stock.value, outcome } };
  };

  const replay = async (): Promise<GuardResult<SupplementLotRow | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    return findMutationSnapshot<SupplementLotRow>(
      supabase,
      ownerId,
      SUPPLEMENT_LOTS_TABLE,
      clientMutationId,
    );
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return finish(first.value, "idempotent_replay");
  }

  const product = catalog.byId.get(input.productId);
  if (product === undefined) {
    return { ok: false, response: supplementProductNotFound() };
  }
  if (input.id === undefined && product.archivedAt !== null) {
    return { ok: false, response: supplementProductArchived() };
  }

  // 在庫は商品の既定単位で数える（実装仕様書 5.6節 / migration 20260915000100）。
  // DB のトリガーも同じ判定をするが、ここで先に返して何が悪いのかを伝える。
  const unit = input.unit ?? product.defaultUnit;
  if (unit !== product.defaultUnit) {
    return {
      ok: false,
      response: supplementUnitMismatch(
        "在庫の単位は商品の既定単位と同じにしてください（在庫は商品の単位で数えます）。",
      ),
    };
  }

  // ロットは作成後に商品を移せない（`product_id` は UPDATE の列レベル権限にも無い）。
  // 移せると、そのロットの消費履歴（movements）が別商品の在庫を指すことになり、
  // 取消の復元先がずれる。商品を間違えたロットは削除して作り直す。
  const base = {
    lot_code: input.lotCode ?? null,
    quantity: input.quantity,
    unit,
    purchased_on: input.purchasedOn ?? null,
    opened_on: input.openedOn ?? null,
    expires_on: input.expiresOn ?? null,
    note: input.note ?? null,
    client_mutation_id: clientMutationId ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const existing = await getRowById<SupplementLotRow>(supabase, ownerId, "lot", input.id);
    if (!existing.ok) {
      return existing;
    }
    if (existing.value === null) {
      return { ok: false, response: supplementNotFound() };
    }
    if (existing.value.product_id !== input.productId) {
      return {
        ok: false,
        response: invalidRequest("在庫ロットの商品は作成後に変更できません。"),
      };
    }

    // 残量の省略は「触らない」。省略時に `quantity` へ戻すと、更新のたびに
    // 消費済みの在庫が満タンへ復活してしまう。
    const remaining = input.remainingQuantity ?? Number(existing.value.remaining_quantity);

    const { data, error } = await supabase
      .from(SUPPLEMENT_LOTS_TABLE)
      .update({ ...base, remaining_quantity: remaining })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(SUPPLEMENT_LOT_COLUMNS)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return finish(retry.value, "idempotent_replay");
      }
      if (error === null) {
        return { ok: false, response: supplementConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: supplementDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return finish(data as unknown as SupplementLotRow, "updated");
  }

  // 作成時に残量を省略したら「開封前の新品」＝ 数量と同じ。
  const { data, error } = await supabase
    .from(SUPPLEMENT_LOTS_TABLE)
    .insert({
      owner_id: ownerId,
      product_id: input.productId,
      ...base,
      remaining_quantity: input.remainingQuantity ?? input.quantity,
    })
    .select(SUPPLEMENT_LOT_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return finish(retry.value, "idempotent_replay");
      }
      return { ok: false, response: supplementDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: supplementConflict() };
  }

  return finish(data as unknown as SupplementLotRow, "created");
}

/* -------------------------------------------------------------------------- */
/* 服用の記録・取消（原子的RPC）                                               */
/* -------------------------------------------------------------------------- */

/** RPC が返す封筒（migration 20260915000400）。 */
type IntakeEnvelope = {
  readonly outcome: "created" | "idempotent_replay" | "voided" | "conflict";
  readonly intake?: SupplementIntakeRow;
};

const readEnvelope = (data: unknown): IntakeEnvelope | null => {
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const envelope = data as IntakeEnvelope;
  return typeof envelope.outcome === "string" ? envelope : null;
};

/**
 * 服用の記録（実装仕様書 5.6節）。
 *
 * 記録の作成と FEFO 在庫消費を **`record_supplement_intake` RPC が
 * 1トランザクションで**行う。API から記録と在庫を別々に書くと、途中で失敗した
 * ときに「記録だけ残って在庫が減っていない」半端な状態が生まれる
 * （migration 20260915000400 の冒頭）。
 *
 * `outcome`（新規作成か再送か）は**RPC が名乗る**。API 側で「呼ぶ前に冪等キーを
 * 引いて、無ければ created」と判断すると、同じキーの2リクエストが同時に届いた
 * ときに両方とも `created` を名乗ってしまう（判定はロックの内側でしかできない）。
 */
export async function recordIntake(
  supabase: SupabaseClient,
  ownerId: string,
  input: SupplementIntakeInput,
  clientMutationId: string | undefined,
  catalog: SupplementCatalog,
): Promise<
  GuardResult<{ intake: SupplementIntake; stock: SupplementStock; outcome: IntakeOutcome }>
> {
  const finish = async (
    row: SupplementIntakeRow,
    outcome: IntakeOutcome,
  ): Promise<
    GuardResult<{ intake: SupplementIntake; stock: SupplementStock; outcome: IntakeOutcome }>
  > => {
    const product = catalog.byId.get(row.product_id);
    const stock = await loadProductStock(
      supabase,
      row.product_id,
      product?.lowStockThreshold ?? null,
    );
    if (!stock.ok) {
      return stock;
    }
    return {
      ok: true,
      value: {
        intake: toSupplementIntake(row, labelOf(catalog, row.product_id)),
        stock: stock.value,
        outcome,
      },
    };
  };

  // 冪等ログ（`clientMutationId`）を先に引く。オフラインキューの再送が、
  // 保存後に商品をアーカイブしたあとで届いても契約どおり成功させるため。
  // 服用固有の `idempotencyKey` による引き当ては RPC の内側（ロックの内側）が行う。
  if (clientMutationId !== undefined) {
    const snapshot = await findMutationSnapshot<SupplementIntakeRow>(
      supabase,
      ownerId,
      SUPPLEMENT_INTAKE_LOGS_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    if (snapshot.value !== null) {
      return finish(snapshot.value, "idempotent_replay");
    }
  }

  const { data, error } = await supabase.rpc(RECORD_INTAKE_RPC, {
    p_product_id: input.productId,
    p_idempotency_key: input.idempotencyKey,
    p_recorded_at: input.recordedAt,
    p_status: input.status ?? "taken",
    p_amount: input.amount ?? null,
    p_unit: input.unit ?? null,
    p_schedule_id: input.scheduleId ?? null,
    p_scheduled_for: input.scheduledFor ?? null,
    p_consume_quantity: input.consumeQuantity ?? null,
    p_timezone: input.timezone ?? DEFAULT_TIMEZONE,
    p_note: input.note ?? null,
    p_client_mutation_id: clientMutationId ?? null,
  });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const envelope = readEnvelope(data);
  if (envelope?.intake === undefined) {
    return { ok: false, response: supplementConflict() };
  }

  return finish(
    envelope.intake,
    envelope.outcome === "idempotent_replay" ? "idempotent_replay" : "created",
  );
}

/**
 * 服用の取消（実装仕様書 5.6節）。
 *
 * 取消と、消費した在庫のロットへの正確な復元を
 * **`void_supplement_intake` RPC が1トランザクションで**行う。
 * 対象は主キーで直接特定する（docs/api/supplements.md 1.7節）。
 * 既に取消済みの記録への再送は 409 ではなく `idempotent_replay`。
 */
export async function voidIntake(
  supabase: SupabaseClient,
  ownerId: string,
  input: SupplementVoidInput,
  clientMutationId: string | undefined,
  catalog: SupplementCatalog,
): Promise<
  GuardResult<{ intake: SupplementIntake; stock: SupplementStock; outcome: VoidOutcome }>
> {
  const finish = async (
    row: SupplementIntakeRow,
    outcome: VoidOutcome,
  ): Promise<
    GuardResult<{ intake: SupplementIntake; stock: SupplementStock; outcome: VoidOutcome }>
  > => {
    const product = catalog.byId.get(row.product_id);
    const stock = await loadProductStock(
      supabase,
      row.product_id,
      product?.lowStockThreshold ?? null,
    );
    if (!stock.ok) {
      return stock;
    }
    return {
      ok: true,
      value: {
        intake: toSupplementIntake(row, labelOf(catalog, row.product_id)),
        stock: stock.value,
        outcome,
      },
    };
  };

  if (clientMutationId !== undefined) {
    const snapshot = await findMutationSnapshot<SupplementIntakeRow>(
      supabase,
      ownerId,
      SUPPLEMENT_INTAKE_LOGS_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    if (snapshot.value !== null) {
      return finish(snapshot.value, "idempotent_replay");
    }
  }

  const { data, error } = await supabase.rpc(VOID_INTAKE_RPC, {
    p_id: input.id,
    p_expected_row_version: input.expectedRowVersion ?? null,
    p_reason: input.reason ?? null,
    p_client_mutation_id: clientMutationId ?? null,
  });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const envelope = readEnvelope(data);
  if (envelope === null || envelope.intake === undefined) {
    // 実装仕様書 6.4節: 対象なしと版番号不一致を区別せず 409 にする。
    return { ok: false, response: supplementConflict() };
  }

  return finish(
    envelope.intake,
    envelope.outcome === "idempotent_replay" ? "idempotent_replay" : "voided",
  );
}

/* -------------------------------------------------------------------------- */
/* 削除                                                                        */
/* -------------------------------------------------------------------------- */

const DELETE_TABLES: Readonly<Record<SupplementDeletableResource, string>> = Object.freeze({
  schedule: SUPPLEMENT_SCHEDULES_TABLE,
  lot: SUPPLEMENT_LOTS_TABLE,
});

/**
 * 摂取予定・在庫ロットの削除。
 *
 * 服用に使われた在庫ロットは DB のトリガーが拒否する（監査証跡と取消の復元先を
 * 守るため。migration 20260915000100）。商品と服用記録は削除できない
 * （`archived` / `void_intake` を使う）。
 */
export async function deleteSupplementRow(
  supabase: SupabaseClient,
  ownerId: string,
  resource: SupplementDeletableResource,
  id: string,
  expectedRowVersion: number | undefined,
): Promise<GuardResult<{ deletedId: string }>> {
  let builder = supabase
    .from(DELETE_TABLES[resource])
    .delete()
    .eq("id", id)
    .eq("owner_id", ownerId);

  if (expectedRowVersion !== undefined) {
    builder = builder.eq("row_version", expectedRowVersion);
  }

  const { data, error } = await builder.select("id").maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  if (data === null) {
    // 実装仕様書 6.4節: 0件は 409。存在しない行と版番号違いを区別しない。
    return { ok: false, response: supplementConflict() };
  }

  return { ok: true, value: { deletedId: (data as { id: string }).id } };
}

export { EMPTY_STOCK };
