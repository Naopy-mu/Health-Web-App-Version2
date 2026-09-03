import "server-only";

/**
 * 睡眠・水分・体調の永続化（実装仕様書 5.5節 / 6.4節 / 9.2節）。
 *
 * ここが守る約束（Phase 3a の `src/server/body-measurements/repository.ts` と同じ）:
 *
 * 1. **所有者はセッション由来**（実装仕様書 3.2節）。全クエリに
 *    `owner_id = <session uid>` を明示し、RLS を最終防衛線として二重に効かせる。
 * 2. **楽観ロック**（実装仕様書 6.4節）。更新・削除は
 *    `id + owner_id + row_version` を WHERE 句に含め、0件を 409 として扱う。
 *    行が無い場合と版番号が古い場合を区別しない（他利用者の行の存在を漏らさない）。
 * 3. **冪等キー**（実装仕様書 5.5節・6.4節）。`client_mutation_id` が適用済みなら、
 *    同じ成功応答（`idempotent_replay`）を返す。再送をエラーにしない。
 *    適用済みかどうかは行の現在値ではなく、追記専用の
 *    `wellness_mutation_log`（migration 20260903000400）を引いて決める。
 *    行の `client_mutation_id` は次のミューテーションで上書きされるため、
 *    それだけでは**何世代か前のキーでの再送**を「未適用」と誤判定してしまう。
 * 4. SQL は `@supabase/supabase-js`（パラメータ化されたSDK）と
 *    管理済みDB関数だけで実行する（実装仕様書 9.2節）。
 *
 * すべての失敗は実装仕様書 7章の `{ error: { code, message } }` 形式の
 * `Response` として返す。エラーコード一覧は `docs/api/wellness.md`。
 */

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import { isDefaultBeverageKey, isDefaultSymptomKey } from "@/features/wellness/defaults";
import type {
  BeverageType,
  BeverageTypeInput,
  ConditionEntry,
  ConditionEntryInput,
  HydrationEntry,
  HydrationEntryInput,
  HydrationGoal,
  HydrationGoalInput,
  MutationOutcome,
  SleepEntry,
  SleepEntryInput,
  SleepGoal,
  SleepGoalInput,
  SymptomType,
  SymptomTypeInput,
  WellnessDeletableResource,
  WellnessListQuery,
} from "@/features/wellness/schema";
import { DEFAULT_TIMEZONE } from "@/features/wellness/schema";
import { findSleepChronologyViolations } from "@/features/wellness/units";

import {
  accountInactive,
  invalidRequest,
  wellnessConflict,
  wellnessDuplicateConflict,
  wellnessGoalConflict,
  wellnessInvalidSleepRange,
  wellnessTypeArchived,
  wellnessTypeConflict,
  wellnessTypeKeyReserved,
  wellnessTypeLimitReached,
  wellnessTypeNotFound,
} from "../api/errors";
import type { GuardResult } from "../api/guards";
import { decodeWellnessCursor, encodeWellnessCursor, keysetFilter } from "./cursor";
import {
  BEVERAGE_TYPE_COLUMNS,
  CONDITION_ENTRY_COLUMNS,
  CONDITION_ENTRY_SYMPTOM_COLUMNS,
  HYDRATION_ENTRY_COLUMNS,
  HYDRATION_GOAL_COLUMNS,
  SLEEP_ENTRY_COLUMNS,
  SLEEP_GOAL_COLUMNS,
  SYMPTOM_TYPE_COLUMNS,
  toBeverageType,
  toConditionEntry,
  toConditionEntrySymptom,
  toHydrationEntry,
  toHydrationGoal,
  toSleepEntry,
  toSleepGoal,
  toSymptomType,
  UNKNOWN_TYPE_LABEL,
  type BeverageTypeRow,
  type ConditionEntryRow,
  type ConditionEntrySymptomRow,
  type HydrationEntryRow,
  type HydrationGoalRow,
  type SleepEntryRow,
  type SleepGoalRow,
  type SymptomTypeRow,
  type TypeLabel,
} from "./rows";

export const BEVERAGE_TYPES_TABLE = "beverage_types";
export const SYMPTOM_TYPES_TABLE = "symptom_types";
export const SLEEP_ENTRIES_TABLE = "sleep_entries";
export const SLEEP_GOALS_TABLE = "sleep_goals";
export const HYDRATION_ENTRIES_TABLE = "hydration_entries";
export const HYDRATION_GOALS_TABLE = "hydration_goals";
export const CONDITION_ENTRIES_TABLE = "condition_entries";
export const CONDITION_ENTRY_SYMPTOMS_TABLE = "condition_entry_symptoms";

/**
 * 冪等キーの適用結果（スナップショット）の追記先。
 * 書き手は DB トリガーだけで、API は読むだけ（migration 20260903000400）。
 */
export const WELLNESS_MUTATION_LOG_TABLE = "wellness_mutation_log";

export const SEED_BEVERAGE_TYPES_RPC = "seed_default_beverage_types";
export const SEED_SYMPTOM_TYPES_RPC = "seed_default_symptom_types";
export const REPLACE_CONDITION_SYMPTOMS_RPC = "replace_condition_entry_symptoms";

/**
 * 体調記録の本体と症状リンクを1トランザクションで保存する DB 関数
 * （migration 20260903000500）。API からの体調記録の作成・更新は必ずここを通る。
 */
export const SAVE_CONDITION_ENTRY_RPC = "save_condition_entry";

/** PostgreSQL のエラーコード（実装仕様書 6.4節の 409 判定などに使う）。 */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

/** PostgREST のエラー本文に制約名・トリガーの文言が現れるかを見る。 */
const violates = (error: PostgrestError, fragment: string): boolean =>
  `${error.message} ${error.details ?? ""}`.includes(fragment);

/**
 * 想定内の PostgreSQL エラーを実装仕様書 7章の応答へ写す。
 * 想定外は 400（`INVALID_REQUEST`）にまとめ、DB のメッセージを外へ出さない
 * （実装仕様書 9.2節: 健康データ・内部情報をログや応答へ出さない）。
 */
function mapUnexpectedError(error: PostgrestError): Response {
  if (error.code === PG_INSUFFICIENT_PRIVILEGE) {
    // RLS または列レベル権限に弾かれた。処理中にアカウント状態が変わった場合など。
    return accountInactive();
  }
  if (error.code === PG_FOREIGN_KEY_VIOLATION) {
    return wellnessTypeNotFound();
  }
  if (error.code === PG_CHECK_VIOLATION) {
    // migration 20260903000100 のガードトリガーが投げる文言を、
    // 利用者に伝わるコードへ写す（DB のメッセージそのものは外へ出さない）。
    if (violates(error, "reserved for the default wellness catalog")) {
      return wellnessTypeKeyReserved();
    }
    if (violates(error, "limited to 30 per owner")) {
      return wellnessTypeLimitReached();
    }
    if (violates(error, "is archived")) {
      return wellnessTypeArchived();
    }
    if (
      violates(error, "sleep_entries_chronology") ||
      violates(error, "sleep_entries_within_24_hours") ||
      violates(error, "sleep_entries_awake_shorter_than_sleep")
    ) {
      return wellnessInvalidSleepRange(
        "就床・入眠・起床・離床の順序、24時間以内、覚醒時間が睡眠時間より短いことを満たしていません。",
      );
    }
    return invalidRequest("入力値がこの項目の制約を満たしていません。");
  }
  return invalidRequest("データを処理できませんでした。");
}

/* -------------------------------------------------------------------------- */
/* 冪等キーの引き当て（実装仕様書 5.5節・6.4節）                               */
/* -------------------------------------------------------------------------- */

/**
 * `client_mutation_id` の適用結果を履歴から引く。
 *
 * 参照先は行そのものではなく `wellness_mutation_log`。行の
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
    .from(WELLNESS_MUTATION_LOG_TABLE)
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
/* 種別カタログ                                                                */
/* -------------------------------------------------------------------------- */

export type TypeIndex<T> = {
  readonly all: readonly T[];
  readonly byId: ReadonlyMap<string, T>;
  readonly byKey: ReadonlyMap<string, T>;
};

/** 所有者の種別一式。ラベル解決とアーカイブ判定に使う。 */
export type WellnessCatalog = {
  readonly beverages: TypeIndex<BeverageType>;
  readonly symptoms: TypeIndex<SymptomType>;
};

const indexBeverages = (types: readonly BeverageType[]): TypeIndex<BeverageType> => ({
  all: types,
  byId: new Map(types.map((type) => [type.id, type])),
  byKey: new Map(types.map((type) => [type.beverageKey, type])),
});

const indexSymptoms = (types: readonly SymptomType[]): TypeIndex<SymptomType> => ({
  all: types,
  byId: new Map(types.map((type) => [type.id, type])),
  byKey: new Map(types.map((type) => [type.symptomKey, type])),
});

const beverageLabel = (type: BeverageType): TypeLabel => ({
  key: type.beverageKey,
  displayName: type.displayName,
});

const symptomLabel = (type: SymptomType): TypeLabel => ({
  key: type.symptomKey,
  displayName: type.displayName,
});

export async function loadCatalogs(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<WellnessCatalog>> {
  const beverages = await supabase
    .from(BEVERAGE_TYPES_TABLE)
    .select(BEVERAGE_TYPE_COLUMNS)
    .eq("owner_id", ownerId)
    .order("sort_order", { ascending: true })
    .order("beverage_key", { ascending: true });

  if (beverages.error) {
    return { ok: false, response: mapUnexpectedError(beverages.error) };
  }

  const symptoms = await supabase
    .from(SYMPTOM_TYPES_TABLE)
    .select(SYMPTOM_TYPE_COLUMNS)
    .eq("owner_id", ownerId)
    .order("sort_order", { ascending: true })
    .order("symptom_key", { ascending: true });

  if (symptoms.error) {
    return { ok: false, response: mapUnexpectedError(symptoms.error) };
  }

  const beverageRows = (beverages.data ?? []) as unknown as BeverageTypeRow[];
  const symptomRows = (symptoms.data ?? []) as unknown as SymptomTypeRow[];

  return {
    ok: true,
    value: {
      beverages: indexBeverages(beverageRows.map(toBeverageType)),
      symptoms: indexSymptoms(symptomRows.map(toSymptomType)),
    },
  };
}

/**
 * 実装仕様書 5.5節「既定の飲み物候補10種」「症状（既定13種＋…）」。
 * どちらの RPC も冪等で、常に既定種別の全件を返す。
 */
export async function seedDefaults(
  supabase: SupabaseClient,
): Promise<GuardResult<{ beverageTypes: BeverageType[]; symptomTypes: SymptomType[] }>> {
  const beverages = await supabase.rpc(SEED_BEVERAGE_TYPES_RPC);
  if (beverages.error) {
    return { ok: false, response: mapUnexpectedError(beverages.error) };
  }

  const symptoms = await supabase.rpc(SEED_SYMPTOM_TYPES_RPC);
  if (symptoms.error) {
    return { ok: false, response: mapUnexpectedError(symptoms.error) };
  }

  return {
    ok: true,
    value: {
      beverageTypes: ((beverages.data ?? []) as unknown as BeverageTypeRow[]).map(toBeverageType),
      symptomTypes: ((symptoms.data ?? []) as unknown as SymptomTypeRow[]).map(toSymptomType),
    },
  };
}

/* --------------------------- 飲み物種別の保存 ------------------------------ */

export async function saveBeverageType(
  supabase: SupabaseClient,
  ownerId: string,
  input: BeverageTypeInput,
  clientMutationId: string | undefined,
  catalog: WellnessCatalog,
): Promise<GuardResult<{ type: BeverageType; outcome: MutationOutcome }>> {
  // 実装仕様書 5.5節: 既定カタログのキーは既定種別専用。カスタム種別が名乗ると
  // 既定種別の偽装になる（DB のトリガーも同じ形を拒否する）。
  if (input.beverageKey !== undefined && isDefaultBeverageKey(input.beverageKey)) {
    return { ok: false, response: wellnessTypeKeyReserved() };
  }

  let currentArchivedAt: string | null = null;
  if (input.id !== undefined) {
    const existing = catalog.beverages.byId.get(input.id);
    if (existing === undefined) {
      return { ok: false, response: wellnessTypeNotFound() };
    }
    // 既定種別は表示名・既定量・並び順の変更もアーカイブもできない
    // （DB のトリガーが 42501 で落とす。ここでは伝わる文言で先に返す）。
    if (existing.isDefault) {
      return {
        ok: false,
        response: invalidRequest("既定の飲み物種別は変更・アーカイブできません。"),
      };
    }
    currentArchivedAt = existing.archivedAt;
  }

  const replay = async (): Promise<GuardResult<BeverageType | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<BeverageTypeRow>(
      supabase,
      ownerId,
      BEVERAGE_TYPES_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    return { ok: true, value: snapshot.value === null ? null : toBeverageType(snapshot.value) };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { type: first.value, outcome: "idempotent_replay" } };
  }

  const patch = {
    display_name: input.displayName,
    default_unit: input.defaultUnit,
    default_amount: input.defaultAmount ?? null,
    contains_caffeine: input.containsCaffeine ?? false,
    contains_alcohol: input.containsAlcohol ?? false,
    sort_order: input.sortOrder ?? 1000,
    client_mutation_id: clientMutationId ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(BEVERAGE_TYPES_TABLE)
      .update({ ...patch, archived_at: resolveArchivedAt(input.archived, currentArchivedAt) })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(BEVERAGE_TYPE_COLUMNS)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return { ok: true, value: { type: retry.value, outcome: "idempotent_replay" } };
      }
      if (error === null) {
        return { ok: false, response: wellnessTypeConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: wellnessTypeConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: { type: toBeverageType(data as unknown as BeverageTypeRow), outcome: "updated" },
    };
  }

  const { data, error } = await supabase
    .from(BEVERAGE_TYPES_TABLE)
    .insert({
      // 実装仕様書 3.2節: 所有者は検証済みセッション由来。ボディの値は使わない。
      owner_id: ownerId,
      beverage_key: input.beverageKey,
      ...patch,
      // `is_default` は列に触れない。列レベル権限が authenticated から剥奪されており
      // （migration 20260903000200）、値は列の既定 `false` になる。
    })
    .select(BEVERAGE_TYPE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // 冪等キーの一意制約と項目キーの重複のどちらが先に反応するかは決められないため、
      // 冪等キーがあるときは必ずログを読み直す（再送をエラーにしない）。
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { type: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: wellnessTypeConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: wellnessTypeConflict() };
  }

  return {
    ok: true,
    value: { type: toBeverageType(data as unknown as BeverageTypeRow), outcome: "created" },
  };
}

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

/* ---------------------------- 症状種別の保存 ------------------------------- */

export async function saveSymptomType(
  supabase: SupabaseClient,
  ownerId: string,
  input: SymptomTypeInput,
  clientMutationId: string | undefined,
  catalog: WellnessCatalog,
): Promise<GuardResult<{ type: SymptomType; outcome: MutationOutcome }>> {
  if (input.symptomKey !== undefined && isDefaultSymptomKey(input.symptomKey)) {
    return { ok: false, response: wellnessTypeKeyReserved() };
  }

  let currentArchivedAt: string | null = null;
  if (input.id !== undefined) {
    const existing = catalog.symptoms.byId.get(input.id);
    if (existing === undefined) {
      return { ok: false, response: wellnessTypeNotFound() };
    }
    if (existing.isDefault) {
      return {
        ok: false,
        response: invalidRequest("既定の症状種別は変更・アーカイブできません。"),
      };
    }
    currentArchivedAt = existing.archivedAt;
  }

  const replay = async (): Promise<GuardResult<SymptomType | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<SymptomTypeRow>(
      supabase,
      ownerId,
      SYMPTOM_TYPES_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    return { ok: true, value: snapshot.value === null ? null : toSymptomType(snapshot.value) };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { type: first.value, outcome: "idempotent_replay" } };
  }

  const patch = {
    display_name: input.displayName,
    sort_order: input.sortOrder ?? 1000,
    client_mutation_id: clientMutationId ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(SYMPTOM_TYPES_TABLE)
      .update({ ...patch, archived_at: resolveArchivedAt(input.archived, currentArchivedAt) })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(SYMPTOM_TYPE_COLUMNS)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return { ok: true, value: { type: retry.value, outcome: "idempotent_replay" } };
      }
      if (error === null) {
        return { ok: false, response: wellnessTypeConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: wellnessTypeConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: { type: toSymptomType(data as unknown as SymptomTypeRow), outcome: "updated" },
    };
  }

  const { data, error } = await supabase
    .from(SYMPTOM_TYPES_TABLE)
    .insert({ owner_id: ownerId, symptom_key: input.symptomKey, ...patch })
    .select(SYMPTOM_TYPE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { type: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: wellnessTypeConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: wellnessTypeConflict() };
  }

  return {
    ok: true,
    value: { type: toSymptomType(data as unknown as SymptomTypeRow), outcome: "created" },
  };
}

/* -------------------------------------------------------------------------- */
/* 睡眠記録                                                                    */
/* -------------------------------------------------------------------------- */

export type SleepEntryPage = {
  readonly entries: readonly SleepEntry[];
  readonly nextCursor: string | null;
};

export async function listSleepEntries(
  supabase: SupabaseClient,
  ownerId: string,
  query: WellnessListQuery,
): Promise<GuardResult<SleepEntryPage>> {
  const ascending = query.order === "asc";

  let builder = supabase
    .from(SLEEP_ENTRIES_TABLE)
    .select(SLEEP_ENTRY_COLUMNS)
    .eq("owner_id", ownerId);

  if (query.sleepKind !== undefined) {
    builder = builder.eq("sleep_kind", query.sleepKind);
  }
  if (query.from !== undefined) {
    builder = builder.gte("sleep_at", query.from);
  }
  if (query.to !== undefined) {
    builder = builder.lte("sleep_at", query.to);
  }

  if (query.cursor !== undefined) {
    const cursor = decodeWellnessCursor(query.cursor);
    if (cursor === null) {
      return { ok: false, response: invalidRequest("cursor の形式が正しくありません。") };
    }
    builder = builder.or(keysetFilter(cursor, "sleep_at", query.order));
  }

  // 次ページの有無を知るために1件多く読む。
  const { data, error } = await builder
    .order("sleep_at", { ascending })
    .order("id", { ascending })
    .limit(query.limit + 1);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as SleepEntryRow[];
  const hasMore = rows.length > query.limit;
  const entries = (hasMore ? rows.slice(0, query.limit) : rows).map(toSleepEntry);

  const last = entries.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeWellnessCursor({ timestamp: last.sleepAt, id: last.id })
      : null;

  return { ok: true, value: { entries, nextCursor } };
}

/**
 * 主キーによる1件取得（実装仕様書 6.4節 / docs/api/wellness.md 1.7節）。
 *
 * **409 のあとに対象行を特定する第一手段**。一覧の `limit` にも、記録日時・種別に
 * よる絞り込みにも一切依存しない。
 *
 * 記録日時や種別で引き直す方法だと、競合した側の更新が**その日時・種別自体を
 * 変更していた**場合に0件になり、「削除された」と誤判定してしまう（行はまだある）。
 * 主キーは行の生存期間中ずっと変わらないので、
 * **「0件 ＝ 本当に削除された（またはもう所有していない）」が正しく成立する**。
 *
 * 所有者はセッション由来。`owner_id` を必ず WHERE に入れ、RLS を二重に効かせる。
 */
export async function getSleepEntryById(
  supabase: SupabaseClient,
  ownerId: string,
  id: string,
): Promise<GuardResult<SleepEntryPage>> {
  const { data, error } = await supabase
    .from(SLEEP_ENTRIES_TABLE)
    .select(SLEEP_ENTRY_COLUMNS)
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const row = data as unknown as SleepEntryRow | null;
  return {
    ok: true,
    value: { entries: row === null ? [] : [toSleepEntry(row)], nextCursor: null },
  };
}

/** 保存に使う列（生成列・サーバー管理列は含めない）。 */
const sleepPatch = (input: SleepEntryInput) => ({
  sleep_kind: input.sleepKind,
  bed_at: input.bedAt,
  sleep_at: input.sleepAt,
  wake_at: input.wakeAt,
  out_of_bed_at: input.outOfBedAt,
  timezone: input.timezone ?? DEFAULT_TIMEZONE,
  awakenings_count: input.awakeningsCount ?? 0,
  awake_minutes: input.awakeMinutes ?? 0,
  quality: input.quality ?? null,
  morning_feeling: input.morningFeeling ?? null,
  note: input.note ?? null,
});

export async function saveSleepEntry(
  supabase: SupabaseClient,
  ownerId: string,
  input: SleepEntryInput,
  clientMutationId: string | undefined,
): Promise<GuardResult<{ entry: SleepEntry; outcome: MutationOutcome }>> {
  // 実装仕様書 5.5節の順序・24時間・覚醒時間の規則。DB の CHECK 制約も同じ判定を
  // 行うが（最終防衛線）、ここで先に返して何が悪いのかを伝える。
  const violations = findSleepChronologyViolations({
    bedAt: input.bedAt,
    sleepAt: input.sleepAt,
    wakeAt: input.wakeAt,
    outOfBedAt: input.outOfBedAt,
    awakeMinutes: input.awakeMinutes ?? 0,
  });
  if (violations.length > 0) {
    return { ok: false, response: wellnessInvalidSleepRange(sleepViolationMessage(violations[0])) };
  }

  const replay = async (): Promise<GuardResult<SleepEntry | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<SleepEntryRow>(
      supabase,
      ownerId,
      SLEEP_ENTRIES_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    return { ok: true, value: snapshot.value === null ? null : toSleepEntry(snapshot.value) };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { entry: first.value, outcome: "idempotent_replay" } };
  }

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(SLEEP_ENTRIES_TABLE)
      .update({ ...sleepPatch(input), client_mutation_id: clientMutationId ?? null })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(SLEEP_ENTRY_COLUMNS)
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
        return { ok: true, value: { entry: retry.value, outcome: "idempotent_replay" } };
      }
      if (error === null) {
        return { ok: false, response: wellnessConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: wellnessDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: { entry: toSleepEntry(data as unknown as SleepEntryRow), outcome: "updated" },
    };
  }

  const { data, error } = await supabase
    .from(SLEEP_ENTRIES_TABLE)
    .insert({
      owner_id: ownerId,
      ...sleepPatch(input),
      client_mutation_id: clientMutationId ?? null,
    })
    .select(SLEEP_ENTRY_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { entry: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: wellnessDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: wellnessConflict() };
  }

  return {
    ok: true,
    value: { entry: toSleepEntry(data as unknown as SleepEntryRow), outcome: "created" },
  };
}

function sleepViolationMessage(violation: string | undefined): string {
  switch (violation) {
    case "order":
      return "就床・入眠・起床・離床は「就床 ≦ 入眠 ＜ 起床 ≦ 離床」の順で入力してください。";
    case "span_over_24_hours":
      return "就床から離床までが24時間を超えています。";
    case "awake_not_shorter_than_sleep":
      return "覚醒時間が睡眠時間以上になっています。覚醒時間を短くしてください。";
    default:
      return "日時の形式が正しくありません。";
  }
}

/* -------------------------------------------------------------------------- */
/* 水分記録                                                                    */
/* -------------------------------------------------------------------------- */

export type HydrationEntryPage = {
  readonly entries: readonly HydrationEntry[];
  readonly nextCursor: string | null;
};

export async function listHydrationEntries(
  supabase: SupabaseClient,
  ownerId: string,
  query: WellnessListQuery,
  catalog: WellnessCatalog,
): Promise<GuardResult<HydrationEntryPage>> {
  const ascending = query.order === "asc";

  let builder = supabase
    .from(HYDRATION_ENTRIES_TABLE)
    .select(HYDRATION_ENTRY_COLUMNS)
    .eq("owner_id", ownerId);

  if (query.beverageTypeId !== undefined) {
    builder = builder.eq("beverage_type_id", query.beverageTypeId);
  }
  if (query.from !== undefined) {
    builder = builder.gte("recorded_at", query.from);
  }
  if (query.to !== undefined) {
    builder = builder.lte("recorded_at", query.to);
  }

  if (query.cursor !== undefined) {
    const cursor = decodeWellnessCursor(query.cursor);
    if (cursor === null) {
      return { ok: false, response: invalidRequest("cursor の形式が正しくありません。") };
    }
    builder = builder.or(keysetFilter(cursor, "recorded_at", query.order));
  }

  const { data, error } = await builder
    .order("recorded_at", { ascending })
    .order("id", { ascending })
    .limit(query.limit + 1);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as HydrationEntryRow[];
  const hasMore = rows.length > query.limit;
  const entries = (hasMore ? rows.slice(0, query.limit) : rows).map((row) => {
    const type = catalog.beverages.byId.get(row.beverage_type_id);
    return toHydrationEntry(row, type ? beverageLabel(type) : UNKNOWN_TYPE_LABEL);
  });

  const last = entries.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeWellnessCursor({ timestamp: last.recordedAt, id: last.id })
      : null;

  return { ok: true, value: { entries, nextCursor } };
}

/** 主キーによる1件取得（`getSleepEntryById` と同じ役割。1.7節）。 */
export async function getHydrationEntryById(
  supabase: SupabaseClient,
  ownerId: string,
  id: string,
  catalog: WellnessCatalog,
): Promise<GuardResult<HydrationEntryPage>> {
  const { data, error } = await supabase
    .from(HYDRATION_ENTRIES_TABLE)
    .select(HYDRATION_ENTRY_COLUMNS)
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const row = data as unknown as HydrationEntryRow | null;
  if (row === null) {
    return { ok: true, value: { entries: [], nextCursor: null } };
  }

  const type = catalog.beverages.byId.get(row.beverage_type_id);
  return {
    ok: true,
    value: {
      entries: [toHydrationEntry(row, type ? beverageLabel(type) : UNKNOWN_TYPE_LABEL)],
      nextCursor: null,
    },
  };
}

export async function saveHydrationEntry(
  supabase: SupabaseClient,
  ownerId: string,
  input: HydrationEntryInput,
  clientMutationId: string | undefined,
  catalog: WellnessCatalog,
): Promise<GuardResult<{ entry: HydrationEntry; outcome: MutationOutcome }>> {
  const type = catalog.beverages.byId.get(input.beverageTypeId);
  if (type === undefined) {
    return { ok: false, response: wellnessTypeNotFound() };
  }
  // 実装仕様書 5.5節（5.3節の方針を踏襲）: アーカイブ済み種別への新規登録は拒否。
  // 既存記録の訂正（更新）は妨げない。
  if (input.id === undefined && type.archivedAt !== null) {
    return { ok: false, response: wellnessTypeArchived() };
  }

  const label = beverageLabel(type);

  const replay = async (): Promise<GuardResult<HydrationEntry | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<HydrationEntryRow>(
      supabase,
      ownerId,
      HYDRATION_ENTRIES_TABLE,
      clientMutationId,
    );
    if (!snapshot.ok) {
      return snapshot;
    }
    if (snapshot.value === null) {
      return { ok: true, value: null };
    }
    const snapshotType = catalog.beverages.byId.get(snapshot.value.beverage_type_id);
    return {
      ok: true,
      value: toHydrationEntry(
        snapshot.value,
        snapshotType ? beverageLabel(snapshotType) : UNKNOWN_TYPE_LABEL,
      ),
    };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { entry: first.value, outcome: "idempotent_replay" } };
  }

  // カフェイン・アルコールの既定は飲み物種別から取る（実装仕様書 5.5節）。
  const patch = {
    beverage_type_id: input.beverageTypeId,
    recorded_at: input.recordedAt,
    unit: input.unit,
    amount: input.amount,
    contains_caffeine: input.containsCaffeine ?? type.containsCaffeine,
    contains_alcohol: input.containsAlcohol ?? type.containsAlcohol,
    note: input.note ?? null,
  };

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(HYDRATION_ENTRIES_TABLE)
      .update({ ...patch, client_mutation_id: clientMutationId ?? null })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(HYDRATION_ENTRY_COLUMNS)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return { ok: true, value: { entry: retry.value, outcome: "idempotent_replay" } };
      }
      if (error === null) {
        return { ok: false, response: wellnessConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: wellnessDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: {
        entry: toHydrationEntry(data as unknown as HydrationEntryRow, label),
        outcome: "updated",
      },
    };
  }

  const { data, error } = await supabase
    .from(HYDRATION_ENTRIES_TABLE)
    .insert({ owner_id: ownerId, ...patch, client_mutation_id: clientMutationId ?? null })
    .select(HYDRATION_ENTRY_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { entry: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: wellnessDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: wellnessConflict() };
  }

  return {
    ok: true,
    value: {
      entry: toHydrationEntry(data as unknown as HydrationEntryRow, label),
      outcome: "created",
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 体調記録                                                                    */
/* -------------------------------------------------------------------------- */

export type ConditionEntryPage = {
  readonly entries: readonly ConditionEntry[];
  readonly nextCursor: string | null;
};

/** 体調記録に紐づく症状を読み、記録IDごとにまとめる。 */
async function loadSymptomsByEntry(
  supabase: SupabaseClient,
  ownerId: string,
  entryIds: readonly string[],
  catalog: WellnessCatalog,
): Promise<GuardResult<Map<string, ConditionEntry["symptoms"]>>> {
  const grouped = new Map<string, ConditionEntry["symptoms"]>();
  if (entryIds.length === 0) {
    return { ok: true, value: grouped };
  }

  const { data, error } = await supabase
    .from(CONDITION_ENTRY_SYMPTOMS_TABLE)
    .select(CONDITION_ENTRY_SYMPTOM_COLUMNS)
    .eq("owner_id", ownerId)
    .in("entry_id", [...entryIds]);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as ConditionEntrySymptomRow[];
  const buckets = new Map<string, ConditionEntrySymptomRow[]>();
  for (const row of rows) {
    const bucket = buckets.get(row.entry_id);
    if (bucket === undefined) {
      buckets.set(row.entry_id, [row]);
    } else {
      bucket.push(row);
    }
  }

  for (const [entryId, bucket] of buckets) {
    // 並びは症状種別の sortOrder → symptomKey（画面のチェックボックス順と揃える）。
    const sorted = bucket
      .map((row) => {
        const type = catalog.symptoms.byId.get(row.symptom_type_id);
        return {
          symptom: toConditionEntrySymptom(row, type ? symptomLabel(type) : UNKNOWN_TYPE_LABEL),
          sortOrder: type?.sortOrder ?? Number.MAX_SAFE_INTEGER,
        };
      })
      .sort(
        (a, b) =>
          a.sortOrder - b.sortOrder || a.symptom.symptomKey.localeCompare(b.symptom.symptomKey),
      )
      .map((item) => item.symptom);

    grouped.set(entryId, sorted);
  }

  return { ok: true, value: grouped };
}

export async function listConditionEntries(
  supabase: SupabaseClient,
  ownerId: string,
  query: WellnessListQuery,
  catalog: WellnessCatalog,
): Promise<GuardResult<ConditionEntryPage>> {
  const ascending = query.order === "asc";

  let builder = supabase
    .from(CONDITION_ENTRIES_TABLE)
    .select(CONDITION_ENTRY_COLUMNS)
    .eq("owner_id", ownerId);

  if (query.from !== undefined) {
    builder = builder.gte("recorded_at", query.from);
  }
  if (query.to !== undefined) {
    builder = builder.lte("recorded_at", query.to);
  }

  if (query.cursor !== undefined) {
    const cursor = decodeWellnessCursor(query.cursor);
    if (cursor === null) {
      return { ok: false, response: invalidRequest("cursor の形式が正しくありません。") };
    }
    builder = builder.or(keysetFilter(cursor, "recorded_at", query.order));
  }

  const { data, error } = await builder
    .order("recorded_at", { ascending })
    .order("id", { ascending })
    .limit(query.limit + 1);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as ConditionEntryRow[];
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const symptoms = await loadSymptomsByEntry(
    supabase,
    ownerId,
    page.map((row) => row.id),
    catalog,
  );
  if (!symptoms.ok) {
    return symptoms;
  }

  const entries = page.map((row) => toConditionEntry(row, symptoms.value.get(row.id) ?? []));

  const last = entries.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeWellnessCursor({ timestamp: last.recordedAt, id: last.id })
      : null;

  return { ok: true, value: { entries, nextCursor } };
}

/** 主キーによる1件取得（`getSleepEntryById` と同じ役割。1.7節）。症状リンクも同梱する。 */
export async function getConditionEntryById(
  supabase: SupabaseClient,
  ownerId: string,
  id: string,
  catalog: WellnessCatalog,
): Promise<GuardResult<ConditionEntryPage>> {
  const { data, error } = await supabase
    .from(CONDITION_ENTRIES_TABLE)
    .select(CONDITION_ENTRY_COLUMNS)
    .eq("id", id)
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const row = data as unknown as ConditionEntryRow | null;
  if (row === null) {
    return { ok: true, value: { entries: [], nextCursor: null } };
  }

  const symptoms = await loadSymptomsOf(supabase, ownerId, row.id, catalog);
  if (!symptoms.ok) {
    return symptoms;
  }

  return {
    ok: true,
    value: { entries: [toConditionEntry(row, symptoms.value)], nextCursor: null },
  };
}

const conditionPatch = (input: ConditionEntryInput) => ({
  recorded_at: input.recordedAt,
  timezone: input.timezone ?? DEFAULT_TIMEZONE,
  overall_score: input.overallScore ?? null,
  fatigue_score: input.fatigueScore ?? null,
  energy_score: input.energyScore ?? null,
  stress_score: input.stressScore ?? null,
  pain_score: input.painScore ?? null,
  mood_score: input.moodScore ?? null,
  body_temperature_c: input.bodyTemperatureC ?? null,
  free_text_symptoms: input.freeTextSymptoms ?? [],
  note: input.note ?? null,
});

/** 1件の体調記録の症状リンクを読む。 */
async function loadSymptomsOf(
  supabase: SupabaseClient,
  ownerId: string,
  entryId: string,
  catalog: WellnessCatalog,
): Promise<GuardResult<ConditionEntry["symptoms"]>> {
  const grouped = await loadSymptomsByEntry(supabase, ownerId, [entryId], catalog);
  if (!grouped.ok) {
    return grouped;
  }
  return { ok: true, value: grouped.value.get(entryId) ?? [] };
}

/**
 * 体調記録の保存（実装仕様書 5.5節 / 6.4節）。
 *
 * 本体と症状リンクの全置換を **DB 関数 `save_condition_entry`（1トランザクション）**
 * へ委ねる。API から2回書くと「親だけ確定して症状の置換に失敗した」中途半端な
 * 状態が生まれるため、そもそも分割しない（migration 20260903000500）。
 *
 * `clientMutationId` は**必須**（スキーマが要求し、DB 関数も無指定を拒否する）。
 * どこで失敗しても同じキーで安全に再送でき、適用済みなら `idempotent_replay`、
 * 未適用ならやり直しになる。キー無しで再送できてしまうと、新規作成では
 * 一意制約（owner_id, recorded_at）に当たって 409 となり自己回復できない。
 */
export async function saveConditionEntry(
  supabase: SupabaseClient,
  ownerId: string,
  input: ConditionEntryInput,
  clientMutationId: string,
  catalog: WellnessCatalog,
): Promise<GuardResult<{ entry: ConditionEntry; outcome: MutationOutcome }>> {
  // 症状種別は所有者のカタログに無ければ 404、アーカイブ済みなら 400。
  // DB のトリガーも同じ判定をする（最終防衛線）。
  for (const symptom of input.symptoms ?? []) {
    const type = catalog.symptoms.byId.get(symptom.symptomTypeId);
    if (type === undefined) {
      return { ok: false, response: wellnessTypeNotFound() };
    }
    if (type.archivedAt !== null) {
      return { ok: false, response: wellnessTypeArchived() };
    }
  }

  const replay = async (): Promise<GuardResult<ConditionEntryRow | null>> =>
    findMutationSnapshot<ConditionEntryRow>(
      supabase,
      ownerId,
      CONDITION_ENTRIES_TABLE,
      clientMutationId,
    );

  const finish = async (
    row: ConditionEntryRow,
    outcome: MutationOutcome,
  ): Promise<GuardResult<{ entry: ConditionEntry; outcome: MutationOutcome }>> => {
    const symptoms = await loadSymptomsOf(supabase, ownerId, row.id, catalog);
    if (!symptoms.ok) {
      return symptoms;
    }
    return { ok: true, value: { entry: toConditionEntry(row, symptoms.value), outcome } };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    // 再送。親のスカラー値は「適用当時のスナップショット」を返す。
    // 症状リンクは親と同一トランザクションで確定しているので、
    // 「親だけ保存できた」状態を救うための貼り直しは要らない。
    return finish(first.value, "idempotent_replay");
  }

  const { data, error } = await supabase.rpc(SAVE_CONDITION_ENTRY_RPC, {
    p_entry: conditionPatch(input),
    p_client_mutation_id: clientMutationId,
    // `undefined`（省略）は既存のリンクをそのまま残す。`[]` は全解除。
    p_symptoms:
      input.symptoms === undefined
        ? null
        : input.symptoms.map((symptom) => ({
            symptomTypeId: symptom.symptomTypeId,
            severity: symptom.severity ?? null,
            note: symptom.note ?? null,
          })),
    p_id: input.id ?? null,
    p_expected_row_version: input.expectedRowVersion ?? null,
  });

  // 実装仕様書 6.4節: 同じ冪等キーの同時到達は「再送」であって競合ではない。
  // 409 を返す前に必ず冪等キーで既存の成功結果を探し直す。
  const conflictOrReplay = async (
    response: Response,
  ): Promise<GuardResult<{ entry: ConditionEntry; outcome: MutationOutcome }>> => {
    const retry = await replay();
    if (!retry.ok) {
      return retry;
    }
    if (retry.value !== null) {
      return finish(retry.value, "idempotent_replay");
    }
    return { ok: false, response };
  };

  if (error) {
    // 一意制約違反は「同じ記録日時の記録が既にある」か「同じ冪等キーの同時到達」。
    // 後者は再送なので、409 を返す前に冪等キーで引き直す。
    if (error.code === PG_UNIQUE_VIOLATION) {
      return conflictOrReplay(wellnessDuplicateConflict());
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  // DB 関数は0件で「行が無い／版番号が古い」を伝える（両者を区別しない）。
  const row = ((data ?? []) as unknown as ConditionEntryRow[])[0];
  if (row === undefined) {
    return conflictOrReplay(wellnessConflict());
  }

  return finish(row, input.id === undefined ? "created" : "updated");
}

/* -------------------------------------------------------------------------- */
/* 目標                                                                        */
/* -------------------------------------------------------------------------- */

export async function listSleepGoals(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<SleepGoal[]>> {
  const { data, error } = await supabase
    .from(SLEEP_GOALS_TABLE)
    .select(SLEEP_GOAL_COLUMNS)
    .eq("owner_id", ownerId)
    .order("start_date", { ascending: false });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  return { ok: true, value: ((data ?? []) as unknown as SleepGoalRow[]).map(toSleepGoal) };
}

export async function listHydrationGoals(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<HydrationGoal[]>> {
  const { data, error } = await supabase
    .from(HYDRATION_GOALS_TABLE)
    .select(HYDRATION_GOAL_COLUMNS)
    .eq("owner_id", ownerId)
    .order("start_date", { ascending: false });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  return { ok: true, value: ((data ?? []) as unknown as HydrationGoalRow[]).map(toHydrationGoal) };
}

const sleepGoalPatch = (input: SleepGoalInput) => ({
  target_sleep_minutes: input.targetSleepMinutes,
  weekdays: input.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  target_bedtime: input.targetBedtime ?? null,
  target_wake_time: input.targetWakeTime ?? null,
  timezone: input.timezone ?? DEFAULT_TIMEZONE,
  start_date: input.startDate,
  end_date: input.endDate ?? null,
  note: input.note ?? null,
});

const hydrationGoalPatch = (input: HydrationGoalInput) => ({
  target_amount_ml: input.targetAmountMl,
  weekdays: input.weekdays ?? [0, 1, 2, 3, 4, 5, 6],
  timezone: input.timezone ?? DEFAULT_TIMEZONE,
  start_date: input.startDate,
  end_date: input.endDate ?? null,
  note: input.note ?? null,
});

export async function saveSleepGoal(
  supabase: SupabaseClient,
  ownerId: string,
  input: SleepGoalInput,
  clientMutationId: string | undefined,
): Promise<GuardResult<{ goal: SleepGoal; outcome: MutationOutcome }>> {
  if (input.endDate != null && input.endDate < input.startDate) {
    return { ok: false, response: invalidRequest("終了日は開始日以降にしてください。") };
  }
  return saveGoalRow(
    supabase,
    ownerId,
    SLEEP_GOALS_TABLE,
    SLEEP_GOAL_COLUMNS,
    sleepGoalPatch(input),
    input,
    clientMutationId,
    toSleepGoal,
  ).then((result) =>
    result.ok
      ? { ok: true, value: { goal: result.value.row, outcome: result.value.outcome } }
      : result,
  );
}

export async function saveHydrationGoal(
  supabase: SupabaseClient,
  ownerId: string,
  input: HydrationGoalInput,
  clientMutationId: string | undefined,
): Promise<GuardResult<{ goal: HydrationGoal; outcome: MutationOutcome }>> {
  if (input.endDate != null && input.endDate < input.startDate) {
    return { ok: false, response: invalidRequest("終了日は開始日以降にしてください。") };
  }
  return saveGoalRow(
    supabase,
    ownerId,
    HYDRATION_GOALS_TABLE,
    HYDRATION_GOAL_COLUMNS,
    hydrationGoalPatch(input),
    input,
    clientMutationId,
    toHydrationGoal,
  ).then((result) =>
    result.ok
      ? { ok: true, value: { goal: result.value.row, outcome: result.value.outcome } }
      : result,
  );
}

/**
 * 睡眠・水分の目標は列だけが違い、楽観ロック・冪等キー・409 の扱いは同じ。
 * 手順を1か所へまとめて、両者の挙動がずれないようにする。
 */
async function saveGoalRow<Row, Api>(
  supabase: SupabaseClient,
  ownerId: string,
  table: string,
  columns: string,
  patch: Record<string, unknown>,
  input: { id?: string; expectedRowVersion?: number },
  clientMutationId: string | undefined,
  convert: (row: Row) => Api,
): Promise<GuardResult<{ row: Api; outcome: MutationOutcome }>> {
  const replay = async (): Promise<GuardResult<Api | null>> => {
    if (clientMutationId === undefined) {
      return { ok: true, value: null };
    }
    const snapshot = await findMutationSnapshot<Row>(supabase, ownerId, table, clientMutationId);
    if (!snapshot.ok) {
      return snapshot;
    }
    return { ok: true, value: snapshot.value === null ? null : convert(snapshot.value) };
  };

  const first = await replay();
  if (!first.ok) {
    return first;
  }
  if (first.value !== null) {
    return { ok: true, value: { row: first.value, outcome: "idempotent_replay" } };
  }

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(table)
      .update({ ...patch, client_mutation_id: clientMutationId ?? null })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(columns)
      .maybeSingle();

    if (error !== null || data === null) {
      const retry = await replay();
      if (!retry.ok) {
        return retry;
      }
      if (retry.value !== null) {
        return { ok: true, value: { row: retry.value, outcome: "idempotent_replay" } };
      }
      // 目標の競合は版番号不一致（0件更新）も重複（一意制約違反）も
      // `WELLNESS_GOAL_CONFLICT` で返す（docs/api/wellness.md 1.8節の契約）。
      // 記録用の `WELLNESS_CONFLICT` を混ぜると、画面が目標の競合を
      // 記録の競合として扱ってしまう。
      if (error === null) {
        return { ok: false, response: wellnessGoalConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: wellnessGoalConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return { ok: true, value: { row: convert(data as unknown as Row), outcome: "updated" } };
  }

  const { data, error } = await supabase
    .from(table)
    .insert({ owner_id: ownerId, ...patch, client_mutation_id: clientMutationId ?? null })
    .select(columns)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      const retry = await replay();
      if (retry.ok && retry.value !== null) {
        return { ok: true, value: { row: retry.value, outcome: "idempotent_replay" } };
      }
      return { ok: false, response: wellnessGoalConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: wellnessGoalConflict() };
  }

  return { ok: true, value: { row: convert(data as unknown as Row), outcome: "created" } };
}

/* -------------------------------------------------------------------------- */
/* 削除                                                                        */
/* -------------------------------------------------------------------------- */

const DELETE_TABLES: Readonly<Record<WellnessDeletableResource, string>> = Object.freeze({
  sleep: SLEEP_ENTRIES_TABLE,
  hydration: HYDRATION_ENTRIES_TABLE,
  condition: CONDITION_ENTRIES_TABLE,
  sleep_goal: SLEEP_GOALS_TABLE,
  hydration_goal: HYDRATION_GOALS_TABLE,
});

export async function deleteWellnessRow(
  supabase: SupabaseClient,
  ownerId: string,
  resource: WellnessDeletableResource,
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
    return { ok: false, response: wellnessConflict() };
  }

  return { ok: true, value: { deletedId: (data as { id: string }).id } };
}
