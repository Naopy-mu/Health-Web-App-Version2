/**
 * 既定カタログ（実装仕様書 5.5節）。
 *
 * > **水分**: …既定の飲み物候補10種を提供し、任意の種別を追加できる。
 * > **体調**: …症状（既定13種＋任意30件まで）…
 *
 * DB 側の正本は migration 20260903000100 の
 * `public.default_beverage_types()` / `public.default_symptom_types()`。
 * ここはフロントが**投入前でも**候補を描けるようにするための写しで、
 * 内容が一致することは `tests/db/wellness.test.ts` が検証する。
 *
 * 既定カタログのキーは**予約語**で、カスタム種別には使えない
 * （使えると既定種別になりすませてしまう。実装仕様書 5.3節が身体測定へ
 * 課しているのと同じ理由）。入力欄では `isDefaultBeverageKey()` /
 * `isDefaultSymptomKey()` で先に弾くこと。
 *
 * サーバー専用の依存を持ち込まないこと（クライアントから import する）。
 */

import type { HydrationUnit } from "./units";

export type DefaultBeverageType = {
  readonly beverageKey: string;
  readonly displayName: string;
  readonly defaultUnit: HydrationUnit;
  readonly defaultAmount: number;
  readonly containsCaffeine: boolean;
  readonly containsAlcohol: boolean;
  readonly sortOrder: number;
};

/** 実装仕様書 5.5節「既定の飲み物候補10種」。 */
export const DEFAULT_BEVERAGE_TYPES: readonly DefaultBeverageType[] = Object.freeze([
  {
    beverageKey: "water",
    displayName: "水",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 10,
  },
  {
    beverageKey: "green_tea",
    displayName: "緑茶",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: true,
    containsAlcohol: false,
    sortOrder: 20,
  },
  {
    beverageKey: "coffee",
    displayName: "コーヒー",
    defaultUnit: "ml",
    defaultAmount: 150,
    containsCaffeine: true,
    containsAlcohol: false,
    sortOrder: 30,
  },
  {
    beverageKey: "black_tea",
    displayName: "紅茶",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: true,
    containsAlcohol: false,
    sortOrder: 40,
  },
  {
    beverageKey: "barley_tea",
    displayName: "麦茶",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 50,
  },
  {
    beverageKey: "milk",
    displayName: "牛乳",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 60,
  },
  {
    beverageKey: "juice",
    displayName: "ジュース",
    defaultUnit: "ml",
    defaultAmount: 200,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 70,
  },
  {
    beverageKey: "sports_drink",
    displayName: "スポーツドリンク",
    defaultUnit: "ml",
    defaultAmount: 500,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 80,
  },
  {
    beverageKey: "soup",
    displayName: "スープ",
    defaultUnit: "ml",
    defaultAmount: 150,
    containsCaffeine: false,
    containsAlcohol: false,
    sortOrder: 90,
  },
  {
    beverageKey: "beer",
    displayName: "ビール",
    defaultUnit: "ml",
    defaultAmount: 350,
    containsCaffeine: false,
    containsAlcohol: true,
    sortOrder: 100,
  },
]);

export type DefaultSymptomType = {
  readonly symptomKey: string;
  readonly displayName: string;
  readonly sortOrder: number;
};

/** 実装仕様書 5.5節「症状（既定13種＋任意30件まで）」の既定13種。 */
export const DEFAULT_SYMPTOM_TYPES: readonly DefaultSymptomType[] = Object.freeze([
  { symptomKey: "headache", displayName: "頭痛", sortOrder: 10 },
  { symptomKey: "stomachache", displayName: "腹痛", sortOrder: 20 },
  { symptomKey: "nausea", displayName: "吐き気", sortOrder: 30 },
  { symptomKey: "dizziness", displayName: "めまい", sortOrder: 40 },
  { symptomKey: "fever", displayName: "発熱", sortOrder: 50 },
  { symptomKey: "cough", displayName: "咳", sortOrder: 60 },
  { symptomKey: "runny_nose", displayName: "鼻水", sortOrder: 70 },
  { symptomKey: "sore_throat", displayName: "のどの痛み", sortOrder: 80 },
  { symptomKey: "fatigue", displayName: "倦怠感", sortOrder: 90 },
  { symptomKey: "joint_pain", displayName: "関節痛", sortOrder: 100 },
  { symptomKey: "muscle_pain", displayName: "筋肉痛", sortOrder: 110 },
  { symptomKey: "diarrhea", displayName: "下痢", sortOrder: 120 },
  { symptomKey: "constipation", displayName: "便秘", sortOrder: 130 },
]);

/** 既定カタログの飲み物キー（カスタム種別が名乗れない予約語）。 */
export const DEFAULT_BEVERAGE_KEYS: readonly string[] = Object.freeze(
  DEFAULT_BEVERAGE_TYPES.map((type) => type.beverageKey),
);

/** 既定カタログの症状キー（カスタム種別が名乗れない予約語）。 */
export const DEFAULT_SYMPTOM_KEYS: readonly string[] = Object.freeze(
  DEFAULT_SYMPTOM_TYPES.map((type) => type.symptomKey),
);

export const isDefaultBeverageKey = (key: string): boolean => DEFAULT_BEVERAGE_KEYS.includes(key);

export const isDefaultSymptomKey = (key: string): boolean => DEFAULT_SYMPTOM_KEYS.includes(key);

/** 実装仕様書 5.5節「任意30件まで」。カスタム症状種別の所有者ごとの上限。 */
export const CUSTOM_SYMPTOM_TYPE_MAX = 30;

/** 1件の体調記録に紐づけられる症状の上限（既定13種 + カスタム30件）。 */
export const CONDITION_ENTRY_SYMPTOM_MAX = DEFAULT_SYMPTOM_TYPES.length + CUSTOM_SYMPTOM_TYPE_MAX;

/** 実装仕様書 5.5節「自由記述症状（10件まで）」。 */
export const CONDITION_FREE_TEXT_SYMPTOM_MAX = 10;
