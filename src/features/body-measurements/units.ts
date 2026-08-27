/**
 * 身体測定の単位・単位換算・BMI（実装仕様書 5.3節）。
 *
 * > 単位: `kg` / `lb` / `cm` / `inch` / `percent` / `index` / `custom`。項目種別に応じた
 * > 単位制約（体重は kg|lb、体脂肪率は %、BMIは無次元のため `index`、
 * > 周囲・長さは cm|inch）を持つ。**BMIを`percent`として扱わない**。
 *
 * > 計算: BMI（`体重kg / (身長m)^2` を小数1桁）、`kg↔lb`（0.45359237）、
 * > `cm↔inch`（2.54）の相互変換。
 *
 * サーバー（API）とフロント（画面）の双方から読み込むため、秘密値・
 * サーバー専用の依存をこのモジュールへ持ち込まないこと。
 * 換算の定数と規則は migration 側（`body_measurement_unit_is_allowed()` と
 * `body_measurements.normalized_value` の生成列）と同じ値を使う。
 * 一致は `tests/db/body-measurements.test.ts` が検証する。
 */

/** 実装仕様書 5.3節: `kg↔lb` の換算係数。 */
export const KILOGRAMS_PER_POUND = 0.45359237;

/** 実装仕様書 5.3節: `cm↔inch` の換算係数。 */
export const CENTIMETERS_PER_INCH = 2.54;

/** 実装仕様書 5.3節の単位。 */
export const MEASUREMENT_UNITS = [
  "kg",
  "lb",
  "cm",
  "inch",
  "percent",
  /** 無次元の指標（BMI）。割合ではないため `percent` と分ける（実装仕様書 5.3節）。 */
  "index",
  "custom",
] as const;
export type MeasurementUnit = (typeof MEASUREMENT_UNITS)[number];

/**
 * 単位制約。DB の `body_measurement_types.unit_constraint` と同じ語を使う。
 *
 * | 単位制約  | 許可する単位 | 該当する既定項目           |
 * | --------- | ------------ | -------------------------- |
 * | `mass`    | `kg` `lb`    | 体重                       |
 * | `percent` | `percent`    | 体脂肪率                   |
 * | `index`   | `index`      | BMI（無次元）              |
 * | `length`  | `cm` `inch`  | ウエスト等の周囲・長さ     |
 * | `custom`  | `custom`     | 単位を持たないカスタム項目 |
 */
export const MEASUREMENT_UNIT_CONSTRAINTS = [
  "mass",
  "percent",
  "index",
  "length",
  "custom",
] as const;
export type MeasurementUnitConstraint = (typeof MEASUREMENT_UNIT_CONSTRAINTS)[number];

export const UNITS_BY_CONSTRAINT: Readonly<
  Record<MeasurementUnitConstraint, readonly MeasurementUnit[]>
> = Object.freeze({
  mass: ["kg", "lb"],
  percent: ["percent"],
  index: ["index"],
  length: ["cm", "inch"],
  custom: ["custom"],
});

/** 単位制約に対して単位が許されるか（DB の `body_measurement_unit_is_allowed()` と同じ判定）。 */
export function isUnitAllowedFor(
  constraint: MeasurementUnitConstraint,
  unit: MeasurementUnit,
): boolean {
  return UNITS_BY_CONSTRAINT[constraint].includes(unit);
}

/* -------------------------------------------------------------------------- */
/* 相互変換（実装仕様書 5.3節）                                                */
/* -------------------------------------------------------------------------- */

export const poundsToKilograms = (pounds: number): number => pounds * KILOGRAMS_PER_POUND;
export const kilogramsToPounds = (kilograms: number): number => kilograms / KILOGRAMS_PER_POUND;
export const inchesToCentimeters = (inches: number): number => inches * CENTIMETERS_PER_INCH;
export const centimetersToInches = (centimeters: number): number =>
  centimeters / CENTIMETERS_PER_INCH;

/**
 * 集計・グラフ・CSV用の正規化。`mass -> kg`、`length -> cm`、
 * `percent -> percent`、`index -> index`、`custom` は正規化しない（`null`）。
 *
 * DB 側は `body_measurements.normalized_value` / `normalized_unit` の生成列が
 * 同じ規則で保存する。API 応答はDBの生成列の値をそのまま返すため、
 * この関数はフロントの下書き表示（保存前のプレビュー）で使う。
 */
export type NormalizedMeasurement = {
  readonly value: number;
  readonly unit: Extract<MeasurementUnit, "kg" | "cm" | "percent" | "index">;
};

export function normalizeMeasurement(
  value: number,
  unit: MeasurementUnit,
): NormalizedMeasurement | null {
  switch (unit) {
    case "kg":
      return { value, unit: "kg" };
    case "lb":
      return { value: poundsToKilograms(value), unit: "kg" };
    case "cm":
      return { value, unit: "cm" };
    case "inch":
      return { value: inchesToCentimeters(value), unit: "cm" };
    case "percent":
      return { value, unit: "percent" };
    case "index":
      return { value, unit: "index" };
    case "custom":
      return null;
  }
}

/* -------------------------------------------------------------------------- */
/* BMI（実装仕様書 5.3節）                                                     */
/* -------------------------------------------------------------------------- */

/** 小数 `digits` 桁へ丸める。二進小数の誤差で `1.05 -> 1.0` にならないよう指数表記を経由する。 */
export function roundTo(value: number, digits: number): number {
  if (!Number.isFinite(value)) {
    return Number.NaN;
  }
  const shifted = Number(`${value}e${digits}`);
  return Number(`${Math.round(shifted)}e-${digits}`);
}

/** BMI の小数桁数（実装仕様書 5.3節「小数1桁」）。 */
export const BMI_FRACTION_DIGITS = 1;

/**
 * BMI = `体重kg / (身長m)^2` を小数1桁で返す。
 *
 * 身長・体重が数値として妥当でない（0以下・非有限）場合は `null` を返す。
 * 実装仕様書 5.2節の入力検証（身長30〜300cm、体重10〜500kg）は入力側の責務であり、
 * ここでは計算不能な入力だけを弾く。
 */
export function calculateBmi(weightKilograms: number, heightCentimeters: number): number | null {
  if (!Number.isFinite(weightKilograms) || !Number.isFinite(heightCentimeters)) {
    return null;
  }
  if (weightKilograms <= 0 || heightCentimeters <= 0) {
    return null;
  }

  const heightMeters = heightCentimeters / 100;
  return roundTo(weightKilograms / (heightMeters * heightMeters), BMI_FRACTION_DIGITS);
}
