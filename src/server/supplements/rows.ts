import "server-only";

/**
 * DB の行（`public.supplement_*`）と API 表現
 * （`src/features/supplements/schema.ts`）の相互変換。
 *
 * DB は snake_case、API は camelCase。境界をこの1ファイルに閉じ込め、
 * Route Handler と Repository が列名を直接触らないようにする。
 *
 * 時刻は PostgREST が `+00:00` 付きで返すため、応答では `Z` 付きの ISO 8601 へ
 * 揃える（実装仕様書 6.3節）。`time` 列は `HH:MM:SS` で返るので `HH:MM` へ丸める
 * （契約は `HH:MM`。秒は扱わない）。値の定義域（単位・カテゴリ・状態）は
 * migration の CHECK 制約が保証しているため、ここでは列挙型として扱う。
 */

import type {
  SupplementIntake,
  SupplementLot,
  SupplementMovement,
  SupplementProduct,
  SupplementSchedule,
  SupplementStock,
  SupplementSummary,
} from "@/features/supplements/schema";
import type {
  SupplementCategory,
  SupplementForm,
  SupplementIntakeStatus,
  SupplementMealRelation,
  SupplementMovementKind,
  SupplementScheduleKind,
  SupplementUnit,
} from "@/features/supplements/units";

/** 応答へ載せる列。`*` を避け、契約に無い列が漏れ出さないようにする。 */
export const SUPPLEMENT_PRODUCT_COLUMNS =
  "id, product_key, name, name_normalized, brand, category, form, default_amount, default_unit, amount_per_container, low_stock_threshold, ingredient_note, safety_note, url, archived_at, row_version, client_mutation_id, created_at, updated_at";

export const SUPPLEMENT_SCHEDULE_COLUMNS =
  "id, product_id, schedule_kind, time_of_day, timezone, weekdays, start_date, end_date, amount, unit, meal_relation, note, archived_at, row_version, client_mutation_id, created_at, updated_at";

export const SUPPLEMENT_LOT_COLUMNS =
  "id, product_id, lot_code, quantity, remaining_quantity, unit, purchased_on, opened_on, expires_on, note, row_version, client_mutation_id, created_at, updated_at";

export const SUPPLEMENT_INTAKE_COLUMNS =
  "id, product_id, schedule_id, status, scheduled_for, recorded_at, timezone, amount, unit, consumed_quantity, idempotency_key, voided_at, void_reason, note, row_version, client_mutation_id, created_at, updated_at";

export const SUPPLEMENT_MOVEMENT_COLUMNS =
  "id, product_id, lot_id, intake_log_id, movement_kind, quantity_delta, unit, occurred_at, note, created_at";

/* -------------------------------------------------------------------------- */
/* 行の型                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * PostgREST は日時・日付を文字列で返すが、PGlite（`tests/db/`）は `Date` を返す。
 * どちらでも同じ API 表現になるよう、境界で両方を受ける。
 */
export type DbTimestamp = string | Date;
export type DbDate = string | Date;
export type DbNumeric = number | string;

export type SupplementProductRow = {
  readonly id: string;
  readonly product_key: string;
  readonly name: string;
  readonly name_normalized: string;
  readonly brand: string | null;
  readonly category: string;
  readonly form: string;
  readonly default_amount: DbNumeric | null;
  readonly default_unit: string;
  readonly amount_per_container: DbNumeric | null;
  readonly low_stock_threshold: DbNumeric | null;
  readonly ingredient_note: string | null;
  readonly safety_note: string | null;
  readonly url: string | null;
  readonly archived_at: DbTimestamp | null;
  readonly row_version: DbNumeric;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SupplementScheduleRow = {
  readonly id: string;
  readonly product_id: string;
  readonly schedule_kind: string;
  readonly time_of_day: string | null;
  readonly timezone: string;
  readonly weekdays: readonly DbNumeric[] | null;
  readonly start_date: DbDate;
  readonly end_date: DbDate | null;
  readonly amount: DbNumeric;
  readonly unit: string;
  readonly meal_relation: string;
  readonly note: string | null;
  readonly archived_at: DbTimestamp | null;
  readonly row_version: DbNumeric;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SupplementLotRow = {
  readonly id: string;
  readonly product_id: string;
  readonly lot_code: string | null;
  readonly quantity: DbNumeric;
  readonly remaining_quantity: DbNumeric;
  readonly unit: string;
  readonly purchased_on: DbDate | null;
  readonly opened_on: DbDate | null;
  readonly expires_on: DbDate | null;
  readonly note: string | null;
  readonly row_version: DbNumeric;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SupplementIntakeRow = {
  readonly id: string;
  readonly product_id: string;
  readonly schedule_id: string | null;
  readonly status: string;
  readonly scheduled_for: DbTimestamp | null;
  readonly recorded_at: DbTimestamp;
  readonly timezone: string;
  readonly amount: DbNumeric;
  readonly unit: string;
  readonly consumed_quantity: DbNumeric;
  readonly idempotency_key: string;
  readonly voided_at: DbTimestamp | null;
  readonly void_reason: string | null;
  readonly note: string | null;
  readonly row_version: DbNumeric;
  readonly client_mutation_id: string | null;
  readonly created_at: DbTimestamp;
  readonly updated_at: DbTimestamp;
};

export type SupplementMovementRow = {
  readonly id: string;
  readonly product_id: string;
  readonly lot_id: string;
  readonly intake_log_id: string | null;
  readonly movement_kind: string;
  readonly quantity_delta: DbNumeric;
  readonly unit: string;
  readonly occurred_at: DbTimestamp;
  readonly note: string | null;
  readonly created_at: DbTimestamp;
};

/** `supplement_product_stock()` の1行。 */
export type SupplementStockRow = {
  readonly product_id: string;
  readonly remaining_total: DbNumeric;
  readonly lot_count: DbNumeric;
  readonly nearest_expires_on: DbDate | null;
};

/** `supplement_summary()` の1行。 */
export type SupplementSummaryRow = {
  readonly weekly_scheduled_count: DbNumeric;
  readonly weekly_taken_count: DbNumeric;
  readonly monthly_taken_count: DbNumeric;
  readonly low_stock_product_count: DbNumeric;
  readonly expiring_lot_count: DbNumeric;
};

/** 商品の識別情報。記録・予定・ロットの応答へ同梱してフロントの再問い合わせを省く。 */
export type ProductLabel = {
  readonly key: string;
  readonly name: string;
};

/** 商品が引けなかったときのラベル（削除・権限外などの防御的な既定値）。 */
export const UNKNOWN_PRODUCT_LABEL: ProductLabel = Object.freeze({ key: "", name: "" });

/** 在庫要約が引けなかった商品の既定値（ロットが1件も無い商品はこうなる）。 */
export const EMPTY_STOCK: SupplementStock = Object.freeze({
  remainingTotal: 0,
  lotCount: 0,
  nearestExpiresOn: null,
  lowStock: false,
});

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
 * PGlite は `numeric` を常に文字列で返す。どちらでも数値として扱えるようにする。
 */
const toNumber = (value: DbNumeric): number => (typeof value === "number" ? value : Number(value));

const toNumberOrNull = (value: DbNumeric | null): number | null =>
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

const toWeekdaysOrNull = (value: readonly DbNumeric[] | null): number[] | null =>
  value === null ? null : value.map((day) => toNumber(day));

/* -------------------------------------------------------------------------- */
/* 行 → API 表現                                                               */
/* -------------------------------------------------------------------------- */

export function toSupplementStock(
  row: SupplementStockRow | undefined,
  lowStockThreshold: number | null,
): SupplementStock {
  const remainingTotal = row === undefined ? 0 : toNumber(row.remaining_total);
  return {
    remainingTotal,
    lotCount: row === undefined ? 0 : toNumber(row.lot_count),
    nearestExpiresOn: row === undefined ? null : toIsoDateOrNull(row.nearest_expires_on),
    // 実装仕様書 5.6節「低在庫しきい値」。しきい値未設定の商品は判定しない。
    lowStock: lowStockThreshold !== null && remainingTotal <= lowStockThreshold,
  };
}

export function toSupplementProduct(
  row: SupplementProductRow,
  stock: SupplementStock,
): SupplementProduct {
  return {
    id: row.id,
    productKey: row.product_key,
    name: row.name,
    nameNormalized: row.name_normalized,
    brand: row.brand,
    // 定義域は migration の CHECK 制約が保証する。
    category: row.category as SupplementCategory,
    form: row.form as SupplementForm,
    defaultAmount: toNumberOrNull(row.default_amount),
    defaultUnit: row.default_unit as SupplementUnit,
    amountPerContainer: toNumberOrNull(row.amount_per_container),
    lowStockThreshold: toNumberOrNull(row.low_stock_threshold),
    ingredientNote: row.ingredient_note,
    safetyNote: row.safety_note,
    url: row.url,
    archivedAt: toIsoDateTimeOrNull(row.archived_at),
    stock,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSupplementSchedule(
  row: SupplementScheduleRow,
  product: ProductLabel,
): SupplementSchedule {
  return {
    id: row.id,
    productId: row.product_id,
    productKey: product.key,
    productName: product.name,
    scheduleKind: row.schedule_kind as SupplementScheduleKind,
    timeOfDay: toLocalTimeOrNull(row.time_of_day),
    timezone: row.timezone,
    weekdays: toWeekdaysOrNull(row.weekdays),
    startDate: toIsoDate(row.start_date),
    endDate: toIsoDateOrNull(row.end_date),
    amount: toNumber(row.amount),
    unit: row.unit as SupplementUnit,
    mealRelation: row.meal_relation as SupplementMealRelation,
    note: row.note,
    archivedAt: toIsoDateTimeOrNull(row.archived_at),
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSupplementLot(row: SupplementLotRow, product: ProductLabel): SupplementLot {
  return {
    id: row.id,
    productId: row.product_id,
    productKey: product.key,
    productName: product.name,
    lotCode: row.lot_code,
    quantity: toNumber(row.quantity),
    remainingQuantity: toNumber(row.remaining_quantity),
    unit: row.unit as SupplementUnit,
    purchasedOn: toIsoDateOrNull(row.purchased_on),
    openedOn: toIsoDateOrNull(row.opened_on),
    expiresOn: toIsoDateOrNull(row.expires_on),
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSupplementIntake(
  row: SupplementIntakeRow,
  product: ProductLabel,
): SupplementIntake {
  return {
    id: row.id,
    productId: row.product_id,
    productKey: product.key,
    productName: product.name,
    scheduleId: row.schedule_id,
    status: row.status as SupplementIntakeStatus,
    scheduledFor: toIsoDateTimeOrNull(row.scheduled_for),
    recordedAt: toIsoDateTime(row.recorded_at),
    timezone: row.timezone,
    amount: toNumber(row.amount),
    unit: row.unit as SupplementUnit,
    consumedQuantity: toNumber(row.consumed_quantity),
    idempotencyKey: row.idempotency_key,
    voidedAt: toIsoDateTimeOrNull(row.voided_at),
    voidReason: row.void_reason,
    note: row.note,
    rowVersion: toNumber(row.row_version),
    clientMutationId: row.client_mutation_id,
    createdAt: toIsoDateTime(row.created_at),
    updatedAt: toIsoDateTime(row.updated_at),
  };
}

export function toSupplementMovement(
  row: SupplementMovementRow,
  product: ProductLabel,
): SupplementMovement {
  return {
    id: row.id,
    productId: row.product_id,
    productKey: product.key,
    productName: product.name,
    lotId: row.lot_id,
    intakeLogId: row.intake_log_id,
    movementKind: row.movement_kind as SupplementMovementKind,
    quantityDelta: toNumber(row.quantity_delta),
    unit: row.unit as SupplementUnit,
    occurredAt: toIsoDateTime(row.occurred_at),
    note: row.note,
    createdAt: toIsoDateTime(row.created_at),
  };
}

export function toSupplementSummary(row: SupplementSummaryRow | undefined): SupplementSummary {
  if (row === undefined) {
    return {
      weeklyScheduledCount: 0,
      weeklyTakenCount: 0,
      monthlyTakenCount: 0,
      lowStockProductCount: 0,
      expiringLotCount: 0,
    };
  }
  return {
    weeklyScheduledCount: toNumber(row.weekly_scheduled_count),
    weeklyTakenCount: toNumber(row.weekly_taken_count),
    monthlyTakenCount: toNumber(row.monthly_taken_count),
    lowStockProductCount: toNumber(row.low_stock_product_count),
    expiringLotCount: toNumber(row.expiring_lot_count),
  };
}
