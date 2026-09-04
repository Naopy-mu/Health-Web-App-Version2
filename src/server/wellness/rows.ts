import "server-only";

/**
 * DB の行（`public.sleep_*` / `public.hydration_*` / `public.condition_*` /
 * `public.beverage_types` / `public.symptom_types`）と API 表現
 * （`src/features/wellness/schema.ts`）の相互変換。
 *
 * DB は snake_case、API は camelCase。境界をこの1ファイルに閉じ込め、
 * Route Handler と Repository が列名を直接触らないようにする。
 *
 * 時刻は PostgREST が `+00:00` 付きで返すため、応答では `Z` 付きの ISO 8601 へ
 * 揃える（実装仕様書 6.3節）。`time` 列は `HH:MM:SS` で返るので `HH:MM` へ丸める
 * （契約は `HH:MM`。秒は扱わない）。値の定義域（単位・スコア範囲）は migration の
 * CHECK 制約が保証しているため、ここでは列挙型として扱う。
 */

import type {
  BeverageType,
  ConditionEntry,
  ConditionEntrySymptom,
  HydrationEntry,
  HydrationGoal,
  SleepEntry,
  SleepGoal,
  SymptomType,
} from "@/features/wellness/schema";
import type { HydrationUnit, SleepKind } from "@/features/wellness/units";

/** 応答へ載せる列。`*` を避け、契約に無い列が漏れ出さないようにする。 */
export const BEVERAGE_TYPE_COLUMNS =
  "id, beverage_key, display_name, default_unit, default_amount, contains_caffeine, contains_alcohol, is_default, sort_order, archived_at, row_version, client_mutation_id, created_at, updated_at";

export const SYMPTOM_TYPE_COLUMNS =
  "id, symptom_key, display_name, is_default, sort_order, archived_at, row_version, client_mutation_id, created_at, updated_at";

export const SLEEP_ENTRY_COLUMNS =
  "id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at, timezone, awakenings_count, awake_minutes, quality, morning_feeling, note, sleep_minutes, time_in_bed_minutes, row_version, client_mutation_id, created_at, updated_at";

export const SLEEP_GOAL_COLUMNS =
  "id, target_sleep_minutes, weekdays, target_bedtime, target_wake_time, timezone, start_date, end_date, note, row_version, client_mutation_id, created_at, updated_at";

export const HYDRATION_ENTRY_COLUMNS =
  "id, beverage_type_id, recorded_at, unit, amount, amount_ml, contains_caffeine, contains_alcohol, note, row_version, client_mutation_id, created_at, updated_at";

export const HYDRATION_GOAL_COLUMNS =
  "id, target_amount_ml, weekdays, timezone, start_date, end_date, note, row_version, client_mutation_id, created_at, updated_at";

export const CONDITION_ENTRY_COLUMNS =
  "id, recorded_at, timezone, overall_score, fatigue_score, energy_score, stress_score, pain_score, mood_score, body_temperature_c, free_text_symptoms, note, row_version, client_mutation_id, created_at, updated_at";

export const CONDITION_ENTRY_SYMPTOM_COLUMNS =
  "id, entry_id, symptom_type_id, severity, note, row_version, client_mutation_id, created_at, updated_at";

/* -------------------------------------------------------------------------- */
/* 行の型                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST は日時・日付を文字列で返すが、PGlite（`tests/db/`）は `Date` を返す。
 * どちらでも同じ API 表現になるよう、境界で両方を受ける。
 */
export type DbTimestamp = string | Date;
export type DbDate = string | Date;

export type BeverageTypeRow = {
  readonly id: string;
  readonly beverage_key: string;
  readonly display_name: string;
  readonly default_unit: string;
  readonly default_amount: number | string | null;
  readonly contains_caffeine: boolean;
  readonly contains_alcohol: boolean;
  readonly is_default: boolean;
  readonly sort_order: number;
  readonly archived_at: DbTimestamp | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SymptomTypeRow = {
  readonly id: string;
  readonly symptom_key: string;
  readonly display_name: string;
  readonly is_default: boolean;
  readonly sort_order: number;
  readonly archived_at: DbTimestamp | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SleepEntryRow = {
  readonly id: string;
  readonly sleep_kind: string;
  readonly bed_at: DbTimestamp;
  readonly sleep_at: DbTimestamp;
  readonly wake_at: DbTimestamp;
  readonly out_of_bed_at: DbTimestamp;
  readonly timezone: string;
  readonly awakenings_count: number | string;
  readonly awake_minutes: number | string;
  readonly quality: number | string | null;
  readonly morning_feeling: number | string | null;
  readonly note: string | null;
  readonly sleep_minutes: number | string;
  readonly time_in_bed_minutes: number | string;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SleepGoalRow = {
  readonly id: string;
  readonly target_sleep_minutes: number | string;
  readonly weekdays: readonly (number | string)[];
  readonly target_bedtime: string | null;
  readonly target_wake_time: string | null;
  readonly timezone: string;
  readonly start_date: DbDate;
  readonly end_date: DbDate | null;
  readonly note: string | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type HydrationEntryRow = {
  readonly id: string;
  readonly beverage_type_id: string;
  readonly recorded_at: DbTimestamp;
  readonly unit: string;
  readonly amount: number | string;
  readonly amount_ml: number | string;
  readonly contains_caffeine: boolean;
  readonly contains_alcohol: boolean;
  readonly note: string | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type HydrationGoalRow = {
  readonly id: string;
  readonly target_amount_ml: number | string;
  readonly weekdays: readonly (number | string)[];
  readonly timezone: string;
  readonly start_date: DbDate;
  readonly end_date: DbDate | null;
  readonly note: string | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type ConditionEntryRow = {
  readonly id: string;
  readonly recorded_at: DbTimestamp;
  readonly timezone: string;
  readonly overall_score: number | string | null;
  readonly fatigue_score: number | string | null;
  readonly energy_score: number | string | null;
  readonly stress_score: number | string | null;
  readonly pain_score: number | string | null;
  readonly mood_score: number | string | null;
  readonly body_temperature_c: number | string | null;
  readonly free_text_symptoms: readonly string[] | null;
  readonly note: string | null;
  readonly row_version: number | string;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type ConditionEntrySymptomRow = {
  readonly id: string;
  readonly entry_id: string;
  readonly symptom_type_id: string;
  readonly severity: number | string | null;
  readonly note: string | null;
};

/** 種別の識別情報。記録の応答へ同梱してフロントの再問い合わせを省く。 */
export type TypeLabel = {
  readonly key: string;
  readonly displayName: string;
};

/* -------------------------------------------------------------------------- */
/* 変換の部品                                                                  */
/* -------------------------------------------------------------------------- */

/** `+00:00` などのオフセット表記を `Z` 付きの ISO 8601 へ揃える。 */
export function toIsoDateTime(value: DbTimestamp): string {
  return new Date(value).toISOString();
}

const toIsoDateTimeOrNull = (value: DbTimestamp | null): string | null =>
  value === null ? null : toIsoDateTime(value);

/**
 * PostgREST は `numeric` を JSON 数値で返すが、設定によっては文字列で届きうる。
 * どちらでも数値として扱えるようにする。
 */
const toNumber = (value: number | string): number =>
  typeof value === "number" ? value : Number(value);

const toNumberOrNull = (value: number | string | null): number | null =>
  value === null ? null : toNumber(value);

/** `HH:MM:SS`（DB の `time`）を契約の `HH:MM` へ丸める。 */
const toLocalTimeOrNull = (value: string | null): string | null =>
  value === null ? null : value.slice(0, 5);

/**
 * `date` 列は `YYYY-MM-DD` で返す。PostgREST はもともと文字列、PGlite は
 * UTC 深夜の `Date` を返すので、どちらも日付部分だけを取り出す。
 */
const toIsoDate = (value: DbDate): string =>
  typeof value === "string" ? value.slice(0, 10) : value.toISOString().slice(0, 10);

const toIsoDateOrNull = (value: DbDate | null): string | null =>
  value === null ? null : toIsoDate(value);

const toWeekdays = (value: readonly (number | string)[] | null): number[] =>
  (value ?? []).map((day) => toNumber(day));

/* -------------------------------------------------------------------------- */
/* 行 → API 表現                                                               */
/* -------------------------------------------------------------------------- */

export function toBeverageType(row: BeverageTypeRow): BeverageType {
  return {
    id: row.id,
    beverageKey: row.beverage_key,
    displayName: row.display_name,
    // 定義域は migration の CHECK 制約が保証する。
    defaultUnit: row.default_unit as HydrationUnit,
    defaultAmount: toNumberOrNull(row.default_amount),
    containsCaffeine: row.contains_caffeine,
    containsAlcohol: row.contains_alcohol,
    isDefault: row.is_default,
    sortOrder: toNumber(row.sort_order),
    archivedAt: toIsoDateTimeOrNull(row.archived_at),
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSymptomType(row: SymptomTypeRow): SymptomType {
  return {
    id: row.id,
    symptomKey: row.symptom_key,
    displayName: row.display_name,
    isDefault: row.is_default,
    sortOrder: toNumber(row.sort_order),
    archivedAt: toIsoDateTimeOrNull(row.archived_at),
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSleepEntry(row: SleepEntryRow): SleepEntry {
  return {
    id: row.id,
    sleepKind: row.sleep_kind as SleepKind,
    bedAt: toIsoDateTime(row.bed_at),
    sleepAt: toIsoDateTime(row.sleep_at),
    wakeAt: toIsoDateTime(row.wake_at),
    outOfBedAt: toIsoDateTime(row.out_of_bed_at),
    timezone: row.timezone,
    awakeningsCount: toNumber(row.awakenings_count),
    awakeMinutes: toNumber(row.awake_minutes),
    quality: toNumberOrNull(row.quality),
    morningFeeling: toNumberOrNull(row.morning_feeling),
    note: row.note,
    sleepMinutes: toNumber(row.sleep_minutes),
    timeInBedMinutes: toNumber(row.time_in_bed_minutes),
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSleepGoal(row: SleepGoalRow): SleepGoal {
  return {
    id: row.id,
    targetSleepMinutes: toNumber(row.target_sleep_minutes),
    weekdays: toWeekdays(row.weekdays),
    targetBedtime: toLocalTimeOrNull(row.target_bedtime),
    targetWakeTime: toLocalTimeOrNull(row.target_wake_time),
    timezone: row.timezone,
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDateOrNull(row.end_date),
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toHydrationEntry(row: HydrationEntryRow, type: TypeLabel): HydrationEntry {
  return {
    id: row.id,
    beverageTypeId: row.beverage_type_id,
    beverageKey: type.key,
    displayName: type.displayName,
    recordedAt: toIsoDateTime(row.recorded_at),
    unit: row.unit as HydrationUnit,
    amount: toNumber(row.amount),
    amountMl: toNumber(row.amount_ml),
    containsCaffeine: row.contains_caffeine,
    containsAlcohol: row.contains_alcohol,
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toHydrationGoal(row: HydrationGoalRow): HydrationGoal {
  return {
    id: row.id,
    targetAmountMl: toNumber(row.target_amount_ml),
    weekdays: toWeekdays(row.weekdays),
    timezone: row.timezone,
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDateOrNull(row.end_date),
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toConditionEntrySymptom(
  row: ConditionEntrySymptomRow,
  type: TypeLabel,
): ConditionEntrySymptom {
  return {
    id: row.id,
    symptomTypeId: row.symptom_type_id,
    symptomKey: type.key,
    displayName: type.displayName,
    severity: toNumberOrNull(row.severity),
    note: row.note,
  };
}

export function toConditionEntry(
  row: ConditionEntryRow,
  symptoms: readonly ConditionEntrySymptom[],
): ConditionEntry {
  return {
    id: row.id,
    recordedAt: toIsoDateTime(row.recorded_at),
    timezone: row.timezone,
    overallScore: toNumberOrNull(row.overall_score),
    fatigueScore: toNumberOrNull(row.fatigue_score),
    energyScore: toNumberOrNull(row.energy_score),
    stressScore: toNumberOrNull(row.stress_score),
    painScore: toNumberOrNull(row.pain_score),
    moodScore: toNumberOrNull(row.mood_score),
    bodyTemperatureC: toNumberOrNull(row.body_temperature_c),
    freeTextSymptoms: [...(row.free_text_symptoms ?? [])],
    symptoms: [...symptoms],
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

/** 種別が引けなかったときのラベル（削除・権限外などの防御的な既定値）。 */
export const UNKNOWN_TYPE_LABEL: TypeLabel = Object.freeze({ key: "", displayName: "" });
