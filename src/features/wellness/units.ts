/**
 * 睡眠・水分の単位と計算（実装仕様書 5.5節）。
 *
 * > **睡眠**: …睡眠時間は `起床-入眠-覚醒時間` で算出する。
 * > **水分**: …単位（`ml` / `l` / `us_fl_oz`）…集計用に `ml` 正規化値を保持する。
 *
 * サーバー（API）とフロント（画面）の双方から読み込むため、秘密値・
 * サーバー専用の依存をこのモジュールへ持ち込まないこと。
 * 換算の定数と規則は migration 側（`hydration_entries.amount_ml` と
 * `sleep_entries.sleep_minutes` の生成列）と同じ値・同じ丸め方を使う。
 * 一致は `tests/db/wellness.test.ts` が実データベースで検証する。
 */

/* -------------------------------------------------------------------------- */
/* 共通                                                                        */
/* -------------------------------------------------------------------------- */

/** 小数 `digits` 桁へ丸める。二進小数の誤差で `1.05 -> 1.0` にならないよう指数表記を経由する。 */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  const shifted = Number(`${value}e${digits}`);
  return Number(`${Math.round(shifted)}e-${digits}`);
}

/** ISO 8601 の日時を epoch ミリ秒にする。解釈できない値は `null`。 */
function toEpochMilliseconds(isoDateTime: string): number | null {
  const parsed = Date.parse(isoDateTime);
  return Number.isNaN(parsed) ? null : parsed;
}

/* -------------------------------------------------------------------------- */
/* 睡眠（実装仕様書 5.5節）                                                    */
/* -------------------------------------------------------------------------- */

/** 実装仕様書 5.5節「種別（夜間／仮眠／その他）」。 */
export const SLEEP_KINDS = ["night", "nap", "other"] as const;
export type SleepKind = (typeof SLEEP_KINDS)[number];

/** 画面のラベル。DB は英字の識別子だけを持つ（表示語は UI 側の責務）。 */
export const SLEEP_KIND_LABELS: Readonly<Record<SleepKind, string>> = Object.freeze({
  night: "夜間",
  nap: "仮眠",
  other: "その他",
});

/** 実装仕様書 5.5節「中途覚醒回数（0〜30）」。 */
export const SLEEP_AWAKENINGS_MAX = 30;

/** 実装仕様書 5.5節「覚醒時間（0〜720分）」。 */
export const SLEEP_AWAKE_MINUTES_MAX = 720;

/** 実装仕様書 5.5節「24時間超…を拒否する」。就床から離床までの上限（分）。 */
export const SLEEP_SPAN_MINUTES_MAX = 24 * 60;

/**
 * 睡眠時間（分）= `起床 - 入眠 - 覚醒時間`（実装仕様書 5.5節）。
 *
 * DB の生成列 `sleep_entries.sleep_minutes` と同じ式・同じ丸め方
 * （`floor(秒 / 60)` のあとに覚醒時間を引く）。保存前のプレビュー表示で使う。
 * 日時が解釈できない場合は `null`。
 */
export function calculateSleepMinutes(
  sleepAt: string,
  wakeAt: string,
  awakeMinutes: number,
): number | null {
  const start = toEpochMilliseconds(sleepAt);
  const end = toEpochMilliseconds(wakeAt);
  if (start === null || end === null || !Number.isFinite(awakeMinutes)) {
    return null;
  }
  return Math.floor((end - start) / 60_000) - awakeMinutes;
}

/**
 * 就床から離床までの分数（DB の生成列 `sleep_entries.time_in_bed_minutes` と同じ）。
 * 睡眠効率の分母に使う。
 */
export function calculateTimeInBedMinutes(bedAt: string, outOfBedAt: string): number | null {
  const start = toEpochMilliseconds(bedAt);
  const end = toEpochMilliseconds(outOfBedAt);
  if (start === null || end === null) {
    return null;
  }
  return Math.floor((end - start) / 60_000);
}

/**
 * 睡眠効率（%、小数1桁）= 睡眠時間 / 拘束時間 × 100。
 * 拘束時間が 0 以下、または睡眠時間が負のときは `null`（比率を作れない）。
 *
 * これは「推定値」であって医学的な指標判定ではない（実装仕様書 10章）。
 */
export function calculateSleepEfficiency(
  sleepMinutes: number,
  timeInBedMinutes: number,
): number | null {
  if (!Number.isFinite(sleepMinutes) || !Number.isFinite(timeInBedMinutes)) {
    return null;
  }
  if (timeInBedMinutes <= 0 || sleepMinutes < 0) {
    return null;
  }
  return roundTo((sleepMinutes / timeInBedMinutes) * 100, 1);
}

/**
 * 実装仕様書 5.5節の順序・上限をまとめて判定する
 * （DB の CHECK 制約 `sleep_entries_chronology` /
 * `sleep_entries_within_24_hours` / `sleep_entries_awake_shorter_than_sleep`
 * と同じ規則）。
 *
 * 破っている規則の識別子を返す。すべて満たしていれば空配列。
 */
export type SleepChronologyViolation =
  /** 就床 ≦ 入眠 ＜ 起床 ≦ 離床 を満たさない。 */
  | "order"
  /** 就床から離床までが24時間を超える。 */
  | "span_over_24_hours"
  /** 覚醒時間が睡眠時間（入眠〜起床）以上。 */
  | "awake_not_shorter_than_sleep"
  /** 日時として解釈できない値が含まれる。 */
  | "invalid_datetime";

export function findSleepChronologyViolations(input: {
  readonly bedAt: string;
  readonly sleepAt: string;
  readonly wakeAt: string;
  readonly outOfBedAt: string;
  readonly awakeMinutes: number;
}): SleepChronologyViolation[] {
  const bed = toEpochMilliseconds(input.bedAt);
  const sleep = toEpochMilliseconds(input.sleepAt);
  const wake = toEpochMilliseconds(input.wakeAt);
  const outOfBed = toEpochMilliseconds(input.outOfBedAt);

  if (bed === null || sleep === null || wake === null || outOfBed === null) {
    return ["invalid_datetime"];
  }

  const violations: SleepChronologyViolation[] = [];

  if (!(bed <= sleep && sleep < wake && wake <= outOfBed)) {
    violations.push("order");
  }
  if (outOfBed - bed > SLEEP_SPAN_MINUTES_MAX * 60_000) {
    violations.push("span_over_24_hours");
  }
  // DB と同じく、丸める前の実時間（分、小数を含む）と比べる。
  if (input.awakeMinutes >= (wake - sleep) / 60_000) {
    violations.push("awake_not_shorter_than_sleep");
  }

  return violations;
}

/* -------------------------------------------------------------------------- */
/* 水分（実装仕様書 5.5節・6.3節）                                             */
/* -------------------------------------------------------------------------- */

/** 実装仕様書 5.5節「単位（`ml` / `l` / `us_fl_oz`）」。 */
export const HYDRATION_UNITS = ["ml", "l", "us_fl_oz"] as const;
export type HydrationUnit = (typeof HYDRATION_UNITS)[number];

export const HYDRATION_UNIT_LABELS: Readonly<Record<HydrationUnit, string>> = Object.freeze({
  ml: "mL",
  l: "L",
  us_fl_oz: "米液量オンス",
});

/** 1 L = 1000 mL。 */
export const MILLILITERS_PER_LITER = 1000;

/** 1 US fl oz = 29.5735295625 mL（米液量オンスの定義値）。 */
export const MILLILITERS_PER_US_FLUID_OUNCE = 29.5735295625;

export const MILLILITERS_PER_UNIT: Readonly<Record<HydrationUnit, number>> = Object.freeze({
  ml: 1,
  l: MILLILITERS_PER_LITER,
  us_fl_oz: MILLILITERS_PER_US_FLUID_OUNCE,
});

/** 実装仕様書 5.5節「量（0超10,000以下）」。 */
export const HYDRATION_AMOUNT_MAX = 10000;

/** DB 列 `hydration_entries.amount_ml` は `numeric(14,6)`。同じ桁で丸める。 */
export const HYDRATION_ML_FRACTION_DIGITS = 6;

/**
 * 集計用の `ml` 正規化（実装仕様書 5.5節・6.3節）。
 *
 * DB の生成列 `hydration_entries.amount_ml` と同じ規則。
 * API 応答は生成列の値をそのまま返すので、この関数は
 * **保存前のプレビュー表示**（「1.5 L = 1,500 mL」等）で使う。
 * 計算できない入力（非有限）は `null`。
 */
export function normalizeHydrationAmount(amount: number, unit: HydrationUnit): number | null {
  if (!Number.isFinite(amount)) {
    return null;
  }
  return roundTo(amount * MILLILITERS_PER_UNIT[unit], HYDRATION_ML_FRACTION_DIGITS);
}

/** `ml` から入力単位へ戻す（単位セレクトの切り替えに使う）。 */
export function convertMillilitersTo(amountMl: number, unit: HydrationUnit): number | null {
  if (!Number.isFinite(amountMl)) {
    return null;
  }
  return roundTo(amountMl / MILLILITERS_PER_UNIT[unit], HYDRATION_ML_FRACTION_DIGITS);
}

/* -------------------------------------------------------------------------- */
/* 目標の対象曜日（実装仕様書 5.5節）                                          */
/* -------------------------------------------------------------------------- */

/** 0=日曜 〜 6=土曜（`Date#getDay()` と同じ並び）。 */
export const WEEKDAYS = [0, 1, 2, 3, 4, 5, 6] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = Object.freeze({
  0: "日",
  1: "月",
  2: "火",
  3: "水",
  4: "木",
  5: "金",
  6: "土",
});

/**
 * 対象曜日の妥当性（DB の `wellness_weekdays_are_valid()` と同じ判定）。
 * 1〜7件、0〜6の範囲、重複なし。
 */
export function areWeekdaysValid(weekdays: readonly number[]): boolean {
  if (weekdays.length < 1 || weekdays.length > 7) {
    return false;
  }
  if (!weekdays.every((day) => Number.isInteger(day) && day >= 0 && day <= 6)) {
    return false;
  }
  return new Set(weekdays).size === weekdays.length;
}
