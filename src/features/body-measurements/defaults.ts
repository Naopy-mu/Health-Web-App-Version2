/**
 * 既定の測定種別カタログ（実装仕様書 5.3節）。
 *
 * > 既定項目: 体重、体脂肪率、BMI、ウエスト、へそ周り、骨盤周り、ヒップ、
 * > 太もも、ふくらはぎ、肩幅。
 *
 * DB 側 `public.default_body_measurement_types()`（migration
 * `20260827000500_body_measurements.sql`）の写し。**投入の実行主体は常にDBの
 * `seed_default_body_measurement_types()` RPC** であり、この配列はフロントが
 * ラベルや並び順を先読みするための参照用。両者が一致することは
 * `tests/db/body-measurements.test.ts` が検証する。
 */

import type { MeasurementUnit, MeasurementUnitConstraint } from "./units";

export type DefaultMeasurementType = {
  /** 実装仕様書 5.3節の項目キー（`^[a-z][a-z0-9_]{1,49}$`）。 */
  readonly measurementKey: string;
  readonly displayName: string;
  readonly unitConstraint: MeasurementUnitConstraint;
  readonly defaultUnit: MeasurementUnit;
  readonly sortOrder: number;
};

export const DEFAULT_MEASUREMENT_TYPES: readonly DefaultMeasurementType[] = Object.freeze([
  {
    measurementKey: "weight",
    displayName: "体重",
    unitConstraint: "mass",
    defaultUnit: "kg",
    sortOrder: 10,
  },
  {
    measurementKey: "body_fat_percentage",
    displayName: "体脂肪率",
    unitConstraint: "percent",
    defaultUnit: "percent",
    sortOrder: 20,
  },
  {
    // 実装仕様書 5.3節「BMIは無次元のため `index`」。`percent` にすると %表示の誤表示になる。
    measurementKey: "bmi",
    displayName: "BMI",
    unitConstraint: "index",
    defaultUnit: "index",
    sortOrder: 30,
  },
  {
    measurementKey: "waist",
    displayName: "ウエスト",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 40,
  },
  {
    measurementKey: "navel_girth",
    displayName: "へそ周り",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 50,
  },
  {
    measurementKey: "pelvis_girth",
    displayName: "骨盤周り",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 60,
  },
  {
    measurementKey: "hip",
    displayName: "ヒップ",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 70,
  },
  {
    measurementKey: "thigh",
    displayName: "太もも",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 80,
  },
  {
    measurementKey: "calf",
    displayName: "ふくらはぎ",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 90,
  },
  {
    measurementKey: "shoulder_width",
    displayName: "肩幅",
    unitConstraint: "length",
    defaultUnit: "cm",
    sortOrder: 100,
  },
] satisfies readonly DefaultMeasurementType[]);

/** 体重の項目キー。BMI の算出元（実装仕様書 5.3節）。 */
export const WEIGHT_MEASUREMENT_KEY = "weight";

/** BMI の項目キー。 */
export const BMI_MEASUREMENT_KEY = "bmi";

export const DEFAULT_MEASUREMENT_KEYS: readonly string[] = Object.freeze(
  DEFAULT_MEASUREMENT_TYPES.map((type) => type.measurementKey),
);

export const isDefaultMeasurementKey = (key: string): boolean =>
  DEFAULT_MEASUREMENT_KEYS.includes(key);

/** BMI の算出元として認める種別の形（実装仕様書 5.3節）。 */
export type WeightTypeCandidate = {
  readonly measurementKey: string;
  readonly unitConstraint: string;
  readonly isDefault: boolean;
};

/**
 * 実装仕様書 5.3節:
 * > BMIの自動算出は、**既定の体重種別（`is_default=true`かつ `weight` に対応する種別）を
 * > 用いた記録に限定**する。任意のカスタム`kg`/`lb`種別からは算出しない。
 *
 * 単に「単位制約が mass」で判定すると、利用者が作った任意の kg 種別（例: 荷物の重さ）から
 * BMI が出てしまう。既定カタログ由来であることまで確かめる。
 */
export const isDefaultWeightType = (type: WeightTypeCandidate): boolean =>
  type.isDefault &&
  type.measurementKey === WEIGHT_MEASUREMENT_KEY &&
  type.unitConstraint === "mass";
