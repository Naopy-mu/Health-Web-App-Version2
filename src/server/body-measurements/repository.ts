import "server-only";

/**
 * 身体測定の永続化（実装仕様書 5.3節 / 6.4節 / 9.2節）。
 *
 * ここが守る約束:
 *
 * 1. **所有者はセッション由来**（実装仕様書 3.2節）。全クエリに
 *    `owner_id = <session uid>` を明示し、RLS を最終防衛線として二重に効かせる。
 * 2. **楽観ロック**（実装仕様書 6.4節）。更新・削除は
 *    `id + owner_id + row_version` を WHERE 句に含め、0件を 409 として扱う。
 *    行が無い場合と版番号が古い場合を区別しない（他利用者の行の存在を漏らさない）。
 * 3. **冪等キー**（実装仕様書 5.3節・6.4節）。`client_mutation_id` が適用済みなら、
 *    同じ成功応答（`idempotent_replay`）を返す。再送をエラーにしない。
 *    適用済みかどうかは行の現在値ではなく、追記専用の
 *    `body_measurement_mutation_log`（migration 20260827000800）を引いて決める。
 *    行の `client_mutation_id` は次のミューテーションで上書きされるため、
 *    それだけでは**何世代か前のキーでの再送**を「未適用」と誤判定してしまう
 *    （実装仕様書 5.3節「409 は実際に異なる内容での競合時のみ」に反する）。
 * 4. SQL は `@supabase/supabase-js`（パラメータ化されたSDK）と
 *    管理済みDB関数だけで実行する（実装仕様書 9.2節）。
 *
 * すべての失敗は実装仕様書 7章の `{ error: { code, message } }` 形式の
 * `Response` として返す。エラーコード一覧は `docs/api/measurements.md`。
 */

import type { PostgrestError, SupabaseClient } from "@supabase/supabase-js";

import type {
  CreateMeasurementTypeInput,
  Measurement,
  MeasurementGoal,
  MeasurementGoalInput,
  MeasurementGoalListQuery,
  MeasurementInput,
  MeasurementListQuery,
  MeasurementType,
  MutationOutcome,
} from "@/features/body-measurements/schema";
import { isDefaultMeasurementKey } from "@/features/body-measurements/defaults";
import { isUnitAllowedFor } from "@/features/body-measurements/units";

import {
  accountInactive,
  invalidRequest,
  measurementConflict,
  measurementDuplicateConflict,
  measurementGoalConflict,
  measurementTypeArchived,
  measurementTypeConflict,
  measurementTypeKeyReserved,
  measurementTypeNotFound,
  measurementUnitNotAllowed,
} from "../api/errors";
import type { GuardResult } from "../api/guards";
import { decodeMeasurementCursor, encodeMeasurementCursor, keysetFilter } from "./cursor";
import {
  MEASUREMENT_COLUMNS,
  MEASUREMENT_GOAL_COLUMNS,
  MEASUREMENT_TYPE_COLUMNS,
  toMeasurement,
  toMeasurementGoal,
  toMeasurementType,
  type MeasurementGoalRow,
  type MeasurementRow,
  type MeasurementTypeRow,
  type TypeLabel,
} from "./rows";

export const MEASUREMENT_TYPES_TABLE = "body_measurement_types";
export const MEASUREMENTS_TABLE = "body_measurements";
export const MEASUREMENT_GOALS_TABLE = "body_measurement_goals";

/**
 * 冪等キーの適用結果（スナップショット）の追記先。
 * 書き手は DB トリガーだけで、API は読むだけ（migration 20260827000800）。
 */
export const MEASUREMENT_MUTATION_LOG_TABLE = "body_measurement_mutation_log";

export const SEED_DEFAULT_TYPES_RPC = "seed_default_body_measurement_types";

/** PostgreSQL のエラーコード（実装仕様書 6.4節の 409 判定などに使う）。 */
const PG_UNIQUE_VIOLATION = "23505";
const PG_FOREIGN_KEY_VIOLATION = "23503";
const PG_CHECK_VIOLATION = "23514";
const PG_INSUFFICIENT_PRIVILEGE = "42501";

const DUPLICATE_MEASUREMENT_CONSTRAINT = "body_measurements_owner_type_measured_at_key";
const DUPLICATE_TYPE_KEY_CONSTRAINT = "body_measurement_types_owner_key_key";
const ACTIVE_GOAL_CONSTRAINT = "body_measurement_goals_owner_type_active_key";

/** PostgREST のエラー本文に制約名・インデックス名が現れるかを見る。 */
const violates = (error: PostgrestError, name: string): boolean =>
  `${error.message} ${error.details ?? ""}`.includes(name);

/**
 * 想定内の PostgreSQL エラーを実装仕様書 7章の応答へ写す。
 * 想定外は 400（`INVALID_REQUEST`）にまとめ、DB のメッセージを外へ出さない
 * （実装仕様書 9.2節: 健康データ・内部情報をログや応答へ出さない）。
 */
function mapUnexpectedError(error: PostgrestError): Response {
  if (error.code === PG_INSUFFICIENT_PRIVILEGE) {
    // RLS に弾かれた。処理中にアカウント状態が変わった場合など。
    return accountInactive();
  }
  if (error.code === PG_FOREIGN_KEY_VIOLATION) {
    return measurementTypeNotFound();
  }
  if (error.code === PG_CHECK_VIOLATION) {
    return invalidRequest("入力値がこの項目の制約を満たしていません。");
  }
  return invalidRequest("測定データを処理できませんでした。");
}

/* -------------------------------------------------------------------------- */
/* 冪等キーの引き当て（実装仕様書 5.3節・6.4節）                               */
/* -------------------------------------------------------------------------- */

/**
 * `client_mutation_id` の適用結果を履歴から引く。
 *
 * 参照先は行そのものではなく `body_measurement_mutation_log`。行の
 * `client_mutation_id` は次のミューテーションで上書きされるため、行を引くと
 * 「2つ前の再送」が未適用に見えて 409 になってしまう（実装仕様書 5.3節違反）。
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
    .from(MEASUREMENT_MUTATION_LOG_TABLE)
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
/* 測定種別                                                                    */
/* -------------------------------------------------------------------------- */

/** 所有者の測定種別一式。ラベル解決と単位制約の検証に使う。 */
export type TypeCatalog = {
  readonly all: readonly MeasurementType[];
  readonly byId: ReadonlyMap<string, MeasurementType>;
  readonly byKey: ReadonlyMap<string, MeasurementType>;
};

const buildCatalog = (types: readonly MeasurementType[]): TypeCatalog => ({
  all: types,
  byId: new Map(types.map((type) => [type.id, type])),
  byKey: new Map(types.map((type) => [type.measurementKey, type])),
});

const labelOf = (type: MeasurementType): TypeLabel => ({
  measurementKey: type.measurementKey,
  displayName: type.displayName,
});

export async function loadTypeCatalog(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<TypeCatalog>> {
  const { data, error } = await supabase
    .from(MEASUREMENT_TYPES_TABLE)
    .select(MEASUREMENT_TYPE_COLUMNS)
    .eq("owner_id", ownerId)
    .order("sort_order", { ascending: true })
    .order("measurement_key", { ascending: true });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as MeasurementTypeRow[];
  return { ok: true, value: buildCatalog(rows.map(toMeasurementType)) };
}

/**
 * 実装仕様書 5.3節「既定種別は `seed_default_body_measurement_types` RPCで投入する」。
 * RPC は冪等で、常に既定10種別を返す。
 */
export async function seedDefaultTypes(
  supabase: SupabaseClient,
): Promise<GuardResult<MeasurementType[]>> {
  const { data, error } = await supabase.rpc(SEED_DEFAULT_TYPES_RPC);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as MeasurementTypeRow[];
  return { ok: true, value: rows.map(toMeasurementType) };
}

export async function createType(
  supabase: SupabaseClient,
  ownerId: string,
  input: CreateMeasurementTypeInput,
  clientMutationId: string | undefined,
): Promise<GuardResult<{ type: MeasurementType; outcome: MutationOutcome }>> {
  if (!isUnitAllowedFor(input.unitConstraint, input.defaultUnit)) {
    return { ok: false, response: measurementUnitNotAllowed() };
  }

  // 実装仕様書 5.3節: 既定カタログのキーは既定種別専用。カスタム種別が名乗ると
  // 既定種別の偽装になる（DB のトリガーも同じ形を拒否する）。
  if (isDefaultMeasurementKey(input.measurementKey)) {
    return { ok: false, response: measurementTypeKeyReserved() };
  }

  // 実装仕様書 6.4節: 適用済みの冪等キーなら同じ成功応答を返す。
  if (clientMutationId !== undefined) {
    const replay = await findTypeByClientMutationId(supabase, ownerId, clientMutationId);
    if (!replay.ok) {
      return replay;
    }
    if (replay.value !== null) {
      return { ok: true, value: { type: replay.value, outcome: "idempotent_replay" } };
    }
  }

  const { data, error } = await supabase
    .from(MEASUREMENT_TYPES_TABLE)
    .insert({
      // 実装仕様書 3.2節: 所有者は検証済みセッション由来。ボディの値は使わない。
      owner_id: ownerId,
      measurement_key: input.measurementKey,
      display_name: input.displayName,
      unit_constraint: input.unitConstraint,
      default_unit: input.defaultUnit,
      sort_order: input.sortOrder ?? 1000,
      // `is_default` は列に触れない。列レベル権限が authenticated から剥奪されており
      // （migration 600）、値は列の既定 `false` になる。true を名乗れるのは
      // `seed_default_body_measurement_types()` RPC だけ（実装仕様書 5.3節）。
      client_mutation_id: clientMutationId ?? null,
    })
    .select(MEASUREMENT_TYPE_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // 冪等キーの一意制約（行側・ログ側）と項目キーの重複のどちらが先に反応するかは
      // 決められないため、冪等キーがあるときは必ずログを読み直す（再送をエラーにしない）。
      if (clientMutationId !== undefined) {
        const replay = await findTypeByClientMutationId(supabase, ownerId, clientMutationId);
        if (replay.ok && replay.value !== null) {
          return { ok: true, value: { type: replay.value, outcome: "idempotent_replay" } };
        }
      }
      if (violates(error, DUPLICATE_TYPE_KEY_CONSTRAINT)) {
        return { ok: false, response: measurementTypeConflict() };
      }
      return { ok: false, response: measurementTypeConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: measurementTypeConflict() };
  }

  return {
    ok: true,
    value: { type: toMeasurementType(data as unknown as MeasurementTypeRow), outcome: "created" },
  };
}

/**
 * 実装仕様書 5.3節: カスタム種別の**アーカイブによる無効化**（`archived_at`）。
 *
 * > カスタム種別はアーカイブ（`archived_at`）による無効化のみを許可し、
 * > 削除（DELETE）は提供しない（既存の測定記録・目標を保護するため）。
 * > 既定種別はアーカイブも不可とする。
 *
 * 既定種別かどうかは呼び出し側（Route Handler）が種別カタログで判定する。
 * ここでは楽観ロック（実装仕様書 6.4節）と冪等キーの扱いだけを持つ。
 */
export async function archiveType(
  supabase: SupabaseClient,
  ownerId: string,
  typeId: string,
  archived: boolean,
  expectedRowVersion: number,
  clientMutationId: string | undefined,
): Promise<GuardResult<{ type: MeasurementType; outcome: "updated" | "idempotent_replay" }>> {
  if (clientMutationId !== undefined) {
    const replay = await findTypeByClientMutationId(supabase, ownerId, clientMutationId);
    if (!replay.ok) {
      return replay;
    }
    if (replay.value !== null) {
      return { ok: true, value: { type: replay.value, outcome: "idempotent_replay" } };
    }
  }

  const { data, error } = await supabase
    .from(MEASUREMENT_TYPES_TABLE)
    .update({
      archived_at: archived ? new Date().toISOString() : null,
      client_mutation_id: clientMutationId ?? null,
    })
    .eq("id", typeId)
    .eq("owner_id", ownerId)
    .eq("row_version", expectedRowVersion)
    .select(MEASUREMENT_TYPE_COLUMNS)
    .maybeSingle();

  // 測定記録・目標と同じ順序（実装仕様書 6.4節）。同時到達した同一冪等キーは
  // 409 ではなく idempotent_replay として返す。
  if (error !== null || data === null) {
    if (clientMutationId !== undefined) {
      const replay = await findTypeByClientMutationId(supabase, ownerId, clientMutationId);
      if (!replay.ok) {
        return replay;
      }
      if (replay.value !== null) {
        return { ok: true, value: { type: replay.value, outcome: "idempotent_replay" } };
      }
    }

    if (error === null) {
      return { ok: false, response: measurementTypeConflict() };
    }
    if (error.code === PG_UNIQUE_VIOLATION) {
      return { ok: false, response: measurementTypeConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  return {
    ok: true,
    value: { type: toMeasurementType(data as unknown as MeasurementTypeRow), outcome: "updated" },
  };
}

async function findTypeByClientMutationId(
  supabase: SupabaseClient,
  ownerId: string,
  clientMutationId: string,
): Promise<GuardResult<MeasurementType | null>> {
  const snapshot = await findMutationSnapshot<MeasurementTypeRow>(
    supabase,
    ownerId,
    MEASUREMENT_TYPES_TABLE,
    clientMutationId,
  );
  if (!snapshot.ok) {
    return snapshot;
  }

  return {
    ok: true,
    value: snapshot.value === null ? null : toMeasurementType(snapshot.value),
  };
}

/* -------------------------------------------------------------------------- */
/* 測定記録                                                                    */
/* -------------------------------------------------------------------------- */

export type MeasurementPage = {
  readonly measurements: readonly Measurement[];
  readonly nextCursor: string | null;
};

export async function listMeasurements(
  supabase: SupabaseClient,
  ownerId: string,
  query: MeasurementListQuery,
  catalog: TypeCatalog,
): Promise<GuardResult<MeasurementPage>> {
  // 種別キー指定は所有者の種別へ解決する。未知のキーは「該当なし」であって
  // エラーではない（種別を作る前の画面表示で 404 を出さない）。
  let typeId = query.typeId;
  if (query.measurementKey !== undefined) {
    const byKey = catalog.byKey.get(query.measurementKey);
    if (byKey === undefined) {
      return { ok: true, value: { measurements: [], nextCursor: null } };
    }
    if (typeId !== undefined && typeId !== byKey.id) {
      return { ok: true, value: { measurements: [], nextCursor: null } };
    }
    typeId = byKey.id;
  }

  const ascending = query.order === "asc";

  let builder = supabase
    .from(MEASUREMENTS_TABLE)
    .select(MEASUREMENT_COLUMNS)
    .eq("owner_id", ownerId);

  if (typeId !== undefined) {
    builder = builder.eq("type_id", typeId);
  }
  if (query.from !== undefined) {
    builder = builder.gte("measured_at", query.from);
  }
  if (query.to !== undefined) {
    builder = builder.lte("measured_at", query.to);
  }

  if (query.cursor !== undefined) {
    const cursor = decodeMeasurementCursor(query.cursor);
    if (cursor === null) {
      return { ok: false, response: invalidRequest("cursor の形式が正しくありません。") };
    }
    builder = builder.or(keysetFilter(cursor, query.order));
  }

  // 次ページの有無を知るために1件多く読む。
  const { data, error } = await builder
    .order("measured_at", { ascending })
    .order("id", { ascending })
    .limit(query.limit + 1);

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as MeasurementRow[];
  const hasMore = rows.length > query.limit;
  const page = hasMore ? rows.slice(0, query.limit) : rows;

  const measurements = page.map((row) => {
    const type = catalog.byId.get(row.type_id);
    return toMeasurement(row, type ? labelOf(type) : { measurementKey: "", displayName: "" });
  });

  const last = measurements.at(-1);
  const nextCursor =
    hasMore && last !== undefined
      ? encodeMeasurementCursor({ measuredAt: last.measuredAt, id: last.id })
      : null;

  return { ok: true, value: { measurements, nextCursor } };
}

/** 保存に使う列（生成列・サーバー管理列は含めない）。 */
const measurementPatch = (input: MeasurementInput) => ({
  type_id: input.typeId,
  measured_at: input.measuredAt,
  value: input.value,
  unit: input.unit,
  note: input.note ?? null,
  measurement_condition: input.measurementCondition ?? null,
  body_site: input.bodySite ?? null,
  photo_reference: input.photoReference ?? null,
});

export async function saveMeasurement(
  supabase: SupabaseClient,
  ownerId: string,
  input: MeasurementInput,
  clientMutationId: string | undefined,
  catalog: TypeCatalog,
): Promise<GuardResult<{ measurement: Measurement; outcome: MutationOutcome }>> {
  const type = catalog.byId.get(input.typeId);
  if (type === undefined) {
    return { ok: false, response: measurementTypeNotFound() };
  }
  // 実装仕様書 5.3節の単位制約。DB のトリガーも同じ判定を行う（最終防衛線）。
  if (!isUnitAllowedFor(type.unitConstraint, input.unit)) {
    return { ok: false, response: measurementUnitNotAllowed() };
  }
  // 実装仕様書 5.3節「アーカイブ済み種別に対する新規の測定記録・目標登録は拒否する」。
  // 既存記録の訂正（更新）は妨げない。
  if (input.id === undefined && type.archivedAt !== null) {
    return { ok: false, response: measurementTypeArchived() };
  }

  const label = labelOf(type);

  if (clientMutationId !== undefined) {
    const replay = await findMeasurementByClientMutationId(
      supabase,
      ownerId,
      clientMutationId,
      catalog,
    );
    if (!replay.ok) {
      return replay;
    }
    if (replay.value !== null) {
      return { ok: true, value: { measurement: replay.value, outcome: "idempotent_replay" } };
    }
  }

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    // 実装仕様書 6.4節の楽観ロック。0件は 409（存在しない場合と区別しない）。
    const { data, error } = await supabase
      .from(MEASUREMENTS_TABLE)
      .update({ ...measurementPatch(input), client_mutation_id: clientMutationId ?? null })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(MEASUREMENT_COLUMNS)
      .maybeSingle();

    // 実装仕様書 6.4節: 同じ冪等キーの同時到達は「再送」であって競合ではない。
    // 先着が版番号を進めたあとに届いた側は 0 件更新／一意制約違反になるため、
    // 409 を返す前に必ず冪等キーで既存の成功結果を探し直す。
    if (error !== null || data === null) {
      if (clientMutationId !== undefined) {
        const replay = await findMeasurementByClientMutationId(
          supabase,
          ownerId,
          clientMutationId,
          catalog,
        );
        if (!replay.ok) {
          return replay;
        }
        if (replay.value !== null) {
          return { ok: true, value: { measurement: replay.value, outcome: "idempotent_replay" } };
        }
      }

      if (error === null) {
        // 0件更新。存在しない行と版番号違いを区別しない（実装仕様書 6.4節）。
        return { ok: false, response: measurementConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: measurementDuplicateConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: {
        measurement: toMeasurement(data as unknown as MeasurementRow, label),
        outcome: "updated",
      },
    };
  }

  const { data, error } = await supabase
    .from(MEASUREMENTS_TABLE)
    .insert({
      owner_id: ownerId,
      ...measurementPatch(input),
      client_mutation_id: clientMutationId ?? null,
    })
    .select(MEASUREMENT_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      // 冪等キーと重複制約のどちらが先に反応するかは決められないため、
      // 冪等キーがあるときは必ず再読み取りを試みる（再送をエラーにしない）。
      if (clientMutationId !== undefined) {
        const replay = await findMeasurementByClientMutationId(
          supabase,
          ownerId,
          clientMutationId,
          catalog,
        );
        if (replay.ok && replay.value !== null) {
          return { ok: true, value: { measurement: replay.value, outcome: "idempotent_replay" } };
        }
      }
      if (violates(error, DUPLICATE_MEASUREMENT_CONSTRAINT)) {
        return { ok: false, response: measurementDuplicateConflict() };
      }
      return { ok: false, response: measurementDuplicateConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: measurementConflict() };
  }

  return {
    ok: true,
    value: {
      measurement: toMeasurement(data as unknown as MeasurementRow, label),
      outcome: "created",
    },
  };
}

async function findMeasurementByClientMutationId(
  supabase: SupabaseClient,
  ownerId: string,
  clientMutationId: string,
  catalog: TypeCatalog,
): Promise<GuardResult<Measurement | null>> {
  const snapshot = await findMutationSnapshot<MeasurementRow>(
    supabase,
    ownerId,
    MEASUREMENTS_TABLE,
    clientMutationId,
  );
  if (!snapshot.ok) {
    return snapshot;
  }
  if (snapshot.value === null) {
    return { ok: true, value: null };
  }

  const row = snapshot.value;
  const type = catalog.byId.get(row.type_id);
  return {
    ok: true,
    value: toMeasurement(row, type ? labelOf(type) : { measurementKey: "", displayName: "" }),
  };
}

export async function deleteMeasurement(
  supabase: SupabaseClient,
  ownerId: string,
  measurementId: string,
  expectedRowVersion: number | undefined,
): Promise<GuardResult<{ deletedId: string }>> {
  let builder = supabase
    .from(MEASUREMENTS_TABLE)
    .delete()
    .eq("id", measurementId)
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
    return { ok: false, response: measurementConflict() };
  }

  return { ok: true, value: { deletedId: (data as { id: string }).id } };
}

/**
 * 実装仕様書 5.3節の BMI 算出に使う最新の体重（kg 正規化済み）。
 * 記録が無ければ `null`。
 */
export async function readLatestWeightKilograms(
  supabase: SupabaseClient,
  ownerId: string,
  weightTypeId: string,
): Promise<GuardResult<{ weightKg: number; measuredAt: string } | null>> {
  const { data, error } = await supabase
    .from(MEASUREMENTS_TABLE)
    .select("normalized_value, measured_at")
    .eq("owner_id", ownerId)
    .eq("type_id", weightTypeId)
    .order("measured_at", { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  if (data === null) {
    return { ok: true, value: null };
  }

  const row = data as unknown as { normalized_value: number | string | null; measured_at: string };
  if (row.normalized_value === null) {
    return { ok: true, value: null };
  }

  return {
    ok: true,
    value: {
      weightKg: Number(row.normalized_value),
      measuredAt: new Date(row.measured_at).toISOString(),
    },
  };
}

/* -------------------------------------------------------------------------- */
/* 測定目標                                                                    */
/* -------------------------------------------------------------------------- */

export async function listGoals(
  supabase: SupabaseClient,
  ownerId: string,
  query: MeasurementGoalListQuery,
  catalog: TypeCatalog,
): Promise<GuardResult<MeasurementGoal[]>> {
  let builder = supabase
    .from(MEASUREMENT_GOALS_TABLE)
    .select(MEASUREMENT_GOAL_COLUMNS)
    .eq("owner_id", ownerId);

  if (query.typeId !== undefined) {
    builder = builder.eq("type_id", query.typeId);
  }
  if (!query.includeAchieved) {
    builder = builder.is("achieved_at", null);
  }

  const { data, error } = await builder.order("created_at", { ascending: false });

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }

  const rows = (data ?? []) as unknown as MeasurementGoalRow[];
  return {
    ok: true,
    value: rows.map((row) => {
      const type = catalog.byId.get(row.type_id);
      return toMeasurementGoal(row, type ? labelOf(type) : { measurementKey: "", displayName: "" });
    }),
  };
}

const goalPatch = (input: MeasurementGoalInput) => ({
  type_id: input.typeId,
  target_value: input.targetValue,
  unit: input.unit,
  start_value: input.startValue ?? null,
  target_date: input.targetDate ?? null,
  note: input.note ?? null,
  achieved_at: input.achievedAt ?? null,
});

export async function saveGoal(
  supabase: SupabaseClient,
  ownerId: string,
  input: MeasurementGoalInput,
  clientMutationId: string | undefined,
  catalog: TypeCatalog,
): Promise<GuardResult<{ goal: MeasurementGoal; outcome: MutationOutcome }>> {
  const type = catalog.byId.get(input.typeId);
  if (type === undefined) {
    return { ok: false, response: measurementTypeNotFound() };
  }
  if (!isUnitAllowedFor(type.unitConstraint, input.unit)) {
    return { ok: false, response: measurementUnitNotAllowed() };
  }
  // 実装仕様書 5.3節: アーカイブ済み種別への新規の目標登録は拒否する。
  if (input.id === undefined && type.archivedAt !== null) {
    return { ok: false, response: measurementTypeArchived() };
  }

  const label = labelOf(type);

  if (clientMutationId !== undefined) {
    const replay = await findGoalByClientMutationId(supabase, ownerId, clientMutationId, catalog);
    if (!replay.ok) {
      return replay;
    }
    if (replay.value !== null) {
      return { ok: true, value: { goal: replay.value, outcome: "idempotent_replay" } };
    }
  }

  if (input.id !== undefined && input.expectedRowVersion !== undefined) {
    const { data, error } = await supabase
      .from(MEASUREMENT_GOALS_TABLE)
      .update({ ...goalPatch(input), client_mutation_id: clientMutationId ?? null })
      .eq("id", input.id)
      .eq("owner_id", ownerId)
      .eq("row_version", input.expectedRowVersion)
      .select(MEASUREMENT_GOAL_COLUMNS)
      .maybeSingle();

    // 測定記録と同じ順序（実装仕様書 6.4節）。同時到達した同一冪等キーは
    // 409 ではなく idempotent_replay として扱う。
    if (error !== null || data === null) {
      if (clientMutationId !== undefined) {
        const replay = await findGoalByClientMutationId(
          supabase,
          ownerId,
          clientMutationId,
          catalog,
        );
        if (!replay.ok) {
          return replay;
        }
        if (replay.value !== null) {
          return { ok: true, value: { goal: replay.value, outcome: "idempotent_replay" } };
        }
      }

      if (error === null) {
        return { ok: false, response: measurementConflict() };
      }
      if (error.code === PG_UNIQUE_VIOLATION) {
        return { ok: false, response: measurementGoalConflict() };
      }
      return { ok: false, response: mapUnexpectedError(error) };
    }

    return {
      ok: true,
      value: {
        goal: toMeasurementGoal(data as unknown as MeasurementGoalRow, label),
        outcome: "updated",
      },
    };
  }

  const { data, error } = await supabase
    .from(MEASUREMENT_GOALS_TABLE)
    .insert({
      owner_id: ownerId,
      ...goalPatch(input),
      client_mutation_id: clientMutationId ?? null,
    })
    .select(MEASUREMENT_GOAL_COLUMNS)
    .maybeSingle();

  if (error) {
    if (error.code === PG_UNIQUE_VIOLATION) {
      if (clientMutationId !== undefined) {
        const replay = await findGoalByClientMutationId(
          supabase,
          ownerId,
          clientMutationId,
          catalog,
        );
        if (replay.ok && replay.value !== null) {
          return { ok: true, value: { goal: replay.value, outcome: "idempotent_replay" } };
        }
      }
      if (violates(error, ACTIVE_GOAL_CONSTRAINT)) {
        return { ok: false, response: measurementGoalConflict() };
      }
      return { ok: false, response: measurementGoalConflict() };
    }
    return { ok: false, response: mapUnexpectedError(error) };
  }

  if (data === null) {
    return { ok: false, response: measurementGoalConflict() };
  }

  return {
    ok: true,
    value: {
      goal: toMeasurementGoal(data as unknown as MeasurementGoalRow, label),
      outcome: "created",
    },
  };
}

async function findGoalByClientMutationId(
  supabase: SupabaseClient,
  ownerId: string,
  clientMutationId: string,
  catalog: TypeCatalog,
): Promise<GuardResult<MeasurementGoal | null>> {
  const snapshot = await findMutationSnapshot<MeasurementGoalRow>(
    supabase,
    ownerId,
    MEASUREMENT_GOALS_TABLE,
    clientMutationId,
  );
  if (!snapshot.ok) {
    return snapshot;
  }
  if (snapshot.value === null) {
    return { ok: true, value: null };
  }

  const row = snapshot.value;
  const type = catalog.byId.get(row.type_id);
  return {
    ok: true,
    value: toMeasurementGoal(row, type ? labelOf(type) : { measurementKey: "", displayName: "" }),
  };
}

export async function deleteGoal(
  supabase: SupabaseClient,
  ownerId: string,
  goalId: string,
  expectedRowVersion: number | undefined,
): Promise<GuardResult<{ deletedId: string }>> {
  let builder = supabase
    .from(MEASUREMENT_GOALS_TABLE)
    .delete()
    .eq("id", goalId)
    .eq("owner_id", ownerId);

  if (expectedRowVersion !== undefined) {
    builder = builder.eq("row_version", expectedRowVersion);
  }

  const { data, error } = await builder.select("id").maybeSingle();

  if (error) {
    return { ok: false, response: mapUnexpectedError(error) };
  }
  if (data === null) {
    return { ok: false, response: measurementConflict() };
  }

  return { ok: true, value: { deletedId: (data as { id: string }).id } };
}
