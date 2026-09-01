import "server-only";

/**
 * DB の行（`public.body_measurement_*`）と API 表現
 * （`src/features/body-measurements/schema.ts`）の相互変換。
 *
 * DB は snake_case、API は camelCase。境界をこの1ファイルに閉じ込め、
 * Route Handler と Repository が列名を直接触らないようにする。
 *
 * 時刻は PostgREST が `+00:00` 付きで返すため、応答では `Z` 付きの ISO 8601 へ
 * 揃える（実装仕様書 6.3節）。値の定義域（単位・単位制約）は migration の
 * CHECK 制約が保証しているため、ここでは列挙型として扱う。
 */

import type {
  Measurement,
  MeasurementGoal,
  MeasurementType,
} from "@/features/body-measurements/schema";
import type {
  MeasurementUnit,
  MeasurementUnitConstraint,
} from "@/features/body-measurements/units";

/** 応答へ載せる列。`*` を避け、契約に無い列が漏れ出さないようにする。 */
export const MEASUREMENT_TYPE_COLUMNS =
  "id, measurement_key, display_name, unit_constraint, default_unit, is_default, sort_order, archived_at, row_version, client_mutation_id, created_at, updated_at";

export const MEASUREMENT_COLUMNS =
  "id, type_id, measured_at, value, unit, normalized_value, normalized_unit, note, measurement_condition, body_site, photo_reference, row_version, client_mutation_id, created_at, updated_at";

export const MEASUREMENT_GOAL_COLUMNS =
  "id, type_id, target_value, unit, start_value, target_date, note, achieved_at, row_version, client_mutation_id, created_at, updated_at";

export type MeasurementTypeRow = {
  readonly id: string;
  readonly measurement_key: string;
  readonly display_name: string;
  readonly unit_constraint: string;
  readonly default_unit: string;
  readonly is_default: boolean;
  readonly sort_order: number;
  readonly archived_at: string | null;
  readonly row_version: number;
  readonly client_mutation_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type MeasurementRow = {
  readonly id: string;
  readonly type_id: string;
  readonly measured_at: string;
  readonly value: number | string;
  readonly unit: string;
  readonly normalized_value: number | string | null;
  readonly normalized_unit: string | null;
  readonly note: string | null;
  readonly measurement_condition: string | null;
  readonly body_site: string | null;
  readonly photo_reference: string | null;
  readonly row_version: number;
  readonly client_mutation_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

export type MeasurementGoalRow = {
  readonly id: string;
  readonly type_id: string;
  readonly target_value: number | string;
  readonly unit: string;
  readonly start_value: number | string | null;
  readonly target_date: string | null;
  readonly note: string | null;
  readonly achieved_at: string | null;
  readonly row_version: number;
  readonly client_mutation_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

/** 種別の識別情報。記録・目標の応答へ同梱してフロントの再問い合わせを省く。 */
export type TypeLabel = {
  readonly measurementKey: string;
  readonly displayName: string;
};

/** `+00:00` などのオフセット表記を `Z` 付きの ISO 8601 へ揃える。 */
export function toIsoDateTime(value: string): string {
  return new Date(value).toISOString();
}

const toIsoDateTimeOrNull = (value: string | null): string | null =>
  value === null ? null : toIsoDateTime(value);

/**
 * PostgREST は `numeric` を JSON 数値で返すが、設定によっては文字列で届きうる。
 * どちらでも数値として扱えるようにする。
 */
const toNumber = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

const toNumberOrNull = (value: number | string | null): number | null =>
  value === null ? null : toNumber(value);

export function toMeasurementType(row: MeasurementTypeRow): MeasurementType {
  return {
    id: row.id,
    measurementKey: row.measurement_key,
    displayName: row.display_name,
    // 定義域は migration の CHECK 制約が保証する。
    unitConstraint: row.unit_constraint as MeasurementUnitConstraint,
    defaultUnit: row.default_unit as MeasurementUnit,
    isDefault: row.is_default,
    sortOrder: row.sort_order,
    archivedAt: toIsoDateTimeOrNull(row.archived_at),
    rowVersion: Number(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toMeasurement(row: MeasurementRow, type: TypeLabel): Measurement {
  return {
    id: row.id,
    typeId: row.type_id,
    measurementKey: type.measurementKey,
    displayName: type.displayName,
    measuredAt: toIsoDateTime(row.measured_at),
    value: toNumber(row.value),
    unit: row.unit as MeasurementUnit,
    normalizedValue: toNumberOrNull(row.normalized_value),
    normalizedUnit: row.normalized_unit as Measurement["normalizedUnit"],
    note: row.note,
    measurementCondition: row.measurement_condition,
    bodySite: row.body_site,
    photoReference: row.photo_reference,
    rowVersion: Number(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toMeasurementGoal(row: MeasurementGoalRow, type: TypeLabel): MeasurementGoal {
  return {
    id: row.id,
    typeId: row.type_id,
    measurementKey: type.measurementKey,
    displayName: type.displayName,
    targetValue: toNumber(row.target_value),
    unit: row.unit as MeasurementUnit,
    startValue: toNumberOrNull(row.start_value),
    targetDate: row.target_date,
    note: row.note,
    achievedAt: toIsoDateTimeOrNull(row.achieved_at),
    rowVersion: Number(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}
