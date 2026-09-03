/**
 * 睡眠・水分・体調 API の確定契約（実装仕様書 5.5節 / 7章 / 9.2節）。
 *
 * **このモジュールが `/api/wellness` の唯一の契約源**。
 * フロントエンド（睡眠・水分・体調の画面）はここから型とスキーマを import して、
 * リクエストの組み立てとレスポンスの解釈に使う。
 * 詳しい説明・エラーコード一覧・409 後の対象特定方法は `docs/api/wellness.md`。
 *
 * 実装仕様書 9.2節に従い、全オブジェクトを `.strict()` にして未知フィールドを拒否する。
 * 所有者ID（`owner_id` / `user_id` など）はどのスキーマにも存在しない。
 * 所有者は常に検証済みサーバーセッションから導出する（実装仕様書 3.2節）。
 *
 * サーバー／クライアント双方から読み込むため、秘密値やサーバー専用の依存を
 * 持ち込まないこと。
 */

import { z } from "zod";

import { CONDITION_ENTRY_SYMPTOM_MAX, CONDITION_FREE_TEXT_SYMPTOM_MAX } from "./defaults";
import {
  HYDRATION_AMOUNT_MAX,
  HYDRATION_UNITS,
  SLEEP_AWAKE_MINUTES_MAX,
  SLEEP_AWAKENINGS_MAX,
  SLEEP_KINDS,
} from "./units";

/* -------------------------------------------------------------------------- */
/* 値の基本形                                                                  */
/* -------------------------------------------------------------------------- */

/** 実装仕様書 6.3節: 瞬間は `timestamptz`。オフセット付き ISO 8601 のみ受け付ける。 */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** 実装仕様書 6.3節: 日単位は `date`。 */
export const isoDateSchema = z.iso.date();

/** 実装仕様書 6.3節: ローカル時刻は `time`。`HH:MM`（24時間表記）で受け渡す。 */
export const LOCAL_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

export const localTimeSchema = z.string().regex(LOCAL_TIME_PATTERN, {
  message: "時刻は HH:MM（24時間表記）で入力してください。",
});

/** 実装仕様書 6.3節: 表示タイムゾーンは IANA 名（DB の users と同じ形）。 */
export const IANA_TIMEZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(\/[A-Za-z0-9_+-]+){0,2}$/;

export const timezoneSchema = z
  .string()
  .max(64, { message: "タイムゾーン名が長すぎます。" })
  .regex(IANA_TIMEZONE_PATTERN, {
    message: "タイムゾーンは IANA 名（例: Asia/Tokyo）で指定してください。",
  });

/** 実装仕様書 1章: 既定タイムゾーン。 */
export const DEFAULT_TIMEZONE = "Asia/Tokyo";

/** 実装仕様書 6.4節: 楽観ロックの期待版番号。 */
export const rowVersionSchema = z.number().int().min(1);

/** 実装仕様書 6.4節: オフライン再送の冪等キー。 */
export const clientMutationIdSchema = z.uuid();

/** メモ（実装仕様書 5.5節）。 */
export const noteSchema = z.string().max(500, { message: "メモは500文字以内で入力してください。" });

/** 種別の項目キー。身体測定（実装仕様書 5.3節）と同じ形をそのまま使う。 */
export const TYPE_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export const typeKeySchema = z.string().regex(TYPE_KEY_PATTERN, {
  message: "項目キーは英小文字で始まり、英小文字・数字・アンダースコアで2〜50文字にしてください。",
});

export const displayNameSchema = z
  .string()
  .min(1, { message: "表示名を入力してください。" })
  .max(100, { message: "表示名は100文字以内で入力してください。" });

export const sortOrderSchema = z.number().int().min(0).max(100000);

/** DB の `numeric(10,3)` に合わせ、小数第3位までに制限する（暗黙の丸めを起こさない）。 */
const AMOUNT_DECIMALS = 3;

const hasAtMostDecimals = (value: number, decimals: number): boolean => {
  const fraction = value.toString().split(".")[1];
  return fraction === undefined || fraction.length <= decimals;
};

/** 実装仕様書 5.5節「量（0超10,000以下）」。 */
export const hydrationAmountSchema = z
  .number()
  .finite()
  .gt(0, { message: "量は0より大きい必要があります。" })
  .lte(HYDRATION_AMOUNT_MAX, { message: "量は10,000以下で入力してください。" })
  .refine((value) => hasAtMostDecimals(value, AMOUNT_DECIMALS), {
    message: "量は小数第3位までで入力してください。",
  });

/** 実装仕様書 5.5節「総合・疲労・活力・ストレス・痛み・気分（各0〜10）」。 */
export const conditionScoreSchema = z
  .number()
  .int()
  .min(0, { message: "スコアは0〜10で入力してください。" })
  .max(10, { message: "スコアは0〜10で入力してください。" });

/** 実装仕様書 5.5節「睡眠の質（1〜5）」「起床時の感覚（1〜5）」。 */
export const fivePointScaleSchema = z
  .number()
  .int()
  .min(1, { message: "1〜5で入力してください。" })
  .max(5, { message: "1〜5で入力してください。" });

/** 実装仕様書 5.5節「対象曜日」。0=日曜〜6=土曜、1〜7件、重複なし。 */
export const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1, { message: "対象曜日を1つ以上選んでください。" })
  .max(7, { message: "対象曜日は7件までです。" })
  .refine((days) => new Set(days).size === days.length, {
    message: "対象曜日が重複しています。",
  });

export const sleepKindSchema = z.enum(SLEEP_KINDS);
export const hydrationUnitSchema = z.enum(HYDRATION_UNITS);

/* -------------------------------------------------------------------------- */
/* レスポンスの形                                                              */
/* -------------------------------------------------------------------------- */

/** `public.beverage_types` の1行（API 表現）。 */
export const beverageTypeSchema = z
  .object({
    id: z.uuid(),
    beverageKey: z.string(),
    displayName: z.string(),
    defaultUnit: hydrationUnitSchema,
    /** 入力欄の初期値に使う既定量。未設定なら `null`。 */
    defaultAmount: z.number().nullable(),
    containsCaffeine: z.boolean(),
    containsAlcohol: z.boolean(),
    /** 既定カタログ由来なら `true`。クライアントからは指定・変更できない。 */
    isDefault: z.boolean(),
    sortOrder: z.number().int(),
    archivedAt: isoDateTimeSchema.nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type BeverageType = z.infer<typeof beverageTypeSchema>;

/** `public.symptom_types` の1行（API 表現）。 */
export const symptomTypeSchema = z
  .object({
    id: z.uuid(),
    symptomKey: z.string(),
    displayName: z.string(),
    isDefault: z.boolean(),
    sortOrder: z.number().int(),
    archivedAt: isoDateTimeSchema.nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SymptomType = z.infer<typeof symptomTypeSchema>;

/** `public.sleep_entries` の1行（API 表現）。 */
export const sleepEntrySchema = z
  .object({
    id: z.uuid(),
    sleepKind: sleepKindSchema,
    bedAt: isoDateTimeSchema,
    sleepAt: isoDateTimeSchema,
    wakeAt: isoDateTimeSchema,
    outOfBedAt: isoDateTimeSchema,
    timezone: z.string(),
    awakeningsCount: z.number().int(),
    awakeMinutes: z.number().int(),
    quality: z.number().int().nullable(),
    morningFeeling: z.number().int().nullable(),
    note: z.string().nullable(),
    /** 実装仕様書 5.5節「睡眠時間は `起床-入眠-覚醒時間`」。DB の生成列の値。 */
    sleepMinutes: z.number().int(),
    /** 就床から離床までの分数。DB の生成列の値。 */
    timeInBedMinutes: z.number().int(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SleepEntry = z.infer<typeof sleepEntrySchema>;

/** `public.hydration_entries` の1行（API 表現）。 */
export const hydrationEntrySchema = z
  .object({
    id: z.uuid(),
    beverageTypeId: z.uuid(),
    /** 種別を引き直さずにラベル・CSVを作れるよう同梱する。 */
    beverageKey: z.string(),
    displayName: z.string(),
    recordedAt: isoDateTimeSchema,
    unit: hydrationUnitSchema,
    amount: z.number(),
    /** 実装仕様書 5.5節「集計用に `ml` 正規化値を保持する」。DB の生成列の値。 */
    amountMl: z.number(),
    containsCaffeine: z.boolean(),
    containsAlcohol: z.boolean(),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type HydrationEntry = z.infer<typeof hydrationEntrySchema>;

/** `public.condition_entry_symptoms` の1行（API 表現）。 */
export const conditionEntrySymptomSchema = z
  .object({
    id: z.uuid(),
    symptomTypeId: z.uuid(),
    symptomKey: z.string(),
    displayName: z.string(),
    severity: z.number().int().nullable(),
    note: z.string().nullable(),
  })
  .strict();

export type ConditionEntrySymptom = z.infer<typeof conditionEntrySymptomSchema>;

/** `public.condition_entries` の1行（API 表現）。 */
export const conditionEntrySchema = z
  .object({
    id: z.uuid(),
    recordedAt: isoDateTimeSchema,
    timezone: z.string(),
    overallScore: z.number().int().nullable(),
    fatigueScore: z.number().int().nullable(),
    energyScore: z.number().int().nullable(),
    stressScore: z.number().int().nullable(),
    painScore: z.number().int().nullable(),
    moodScore: z.number().int().nullable(),
    bodyTemperatureC: z.number().nullable(),
    /** 実装仕様書 5.5節「自由記述症状（10件まで）」。 */
    freeTextSymptoms: z.array(z.string()),
    /** 紐づく症状。並びは症状種別の `sortOrder` 昇順 → `symptomKey` 昇順。 */
    symptoms: z.array(conditionEntrySymptomSchema),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type ConditionEntry = z.infer<typeof conditionEntrySchema>;

/** `public.sleep_goals` の1行（API 表現）。 */
export const sleepGoalSchema = z
  .object({
    id: z.uuid(),
    targetSleepMinutes: z.number().int(),
    weekdays: z.array(z.number().int()),
    targetBedtime: z.string().nullable(),
    targetWakeTime: z.string().nullable(),
    timezone: z.string(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable(),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SleepGoal = z.infer<typeof sleepGoalSchema>;

/** `public.hydration_goals` の1行（API 表現）。 */
export const hydrationGoalSchema = z
  .object({
    id: z.uuid(),
    targetAmountMl: z.number(),
    weekdays: z.array(z.number().int()),
    timezone: z.string(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable(),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type HydrationGoal = z.infer<typeof hydrationGoalSchema>;

/**
 * 画面上部の「今の目標」に使う文脈。`endDate` が `null`（＝終了日未設定）の
 * 目標は所有者ごとに1件までなので、必ず0件か1件になる。
 */
export const wellnessContextSchema = z
  .object({
    activeSleepGoal: sleepGoalSchema.nullable(),
    activeHydrationGoal: hydrationGoalSchema.nullable(),
  })
  .strict();

export type WellnessContext = z.infer<typeof wellnessContextSchema>;

/* -------------------------------------------------------------------------- */
/* GET /api/wellness                                                           */
/* -------------------------------------------------------------------------- */

/** ページングする時系列リソース。1回の GET で1つだけ取る。 */
export const WELLNESS_LIST_RESOURCES = ["sleep", "hydration", "condition"] as const;
export const wellnessListResourceSchema = z.enum(WELLNESS_LIST_RESOURCES);
export type WellnessListResource = z.infer<typeof wellnessListResourceSchema>;

export const wellnessOrderSchema = z.enum(["asc", "desc"]);

export const WELLNESS_PAGE_SIZE_DEFAULT = 100;
export const WELLNESS_PAGE_SIZE_MAX = 500;

/** `id` と併用できない絞り込み（1件取得は他の条件に一切依存しない）。 */
const ID_EXCLUSIVE_PARAMS = ["from", "to", "cursor", "sleepKind", "beverageTypeId"] as const;

/**
 * クエリ文字列の検証。`URLSearchParams` から作った素のオブジェクトを渡す。
 * 数値・真偽値は文字列で届くため、ここで変換する。
 *
 * 取得方法は2つある（`docs/api/wellness.md` 1.7節）。
 *
 * 1. **`id` による1件取得**（409 後の対象特定はこちらを使う）。
 *    `resource` + `id` を指定すると、その行だけを所有者スコープで直接返す。
 *    `limit` にも記録日時・種別による絞り込みにも一切依存しない。
 * 2. **一覧**（`id` を指定しないとき）。`from` / `to` が比較する列は
 *    リソースごとに違う（下表）。
 *
 * | resource    | 時間軸       | 併用する絞り込み |
 * | ----------- | ------------ | ---------------- |
 * | `sleep`     | `sleepAt`    | `sleepKind`      |
 * | `hydration` | `recordedAt` | `beverageTypeId` |
 * | `condition` | `recordedAt` | —                |
 */
export const wellnessListQuerySchema = z
  .object({
    resource: wellnessListResourceSchema.default("sleep"),
    /**
     * 指定するとその1件だけを返す（0件なら**本当に存在しない**）。
     * 他の絞り込みとは併用できない。
     */
    id: z.uuid().optional(),
    /** 時間軸 >= from（含む）。 */
    from: isoDateTimeSchema.optional(),
    /** 時間軸 <= to（含む）。 */
    to: isoDateTimeSchema.optional(),
    order: wellnessOrderSchema.default("desc"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(WELLNESS_PAGE_SIZE_MAX)
      .default(WELLNESS_PAGE_SIZE_DEFAULT),
    /** 前ページの `page.nextCursor` をそのまま渡す（不透明な文字列）。 */
    cursor: z.string().min(1).max(512).optional(),
    /** `resource=sleep` のときだけ意味がある。 */
    sleepKind: sleepKindSchema.optional(),
    /** `resource=hydration` のときだけ意味がある。 */
    beverageTypeId: z.uuid().optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.sleepKind !== undefined && query.resource !== "sleep") {
      ctx.addIssue({
        code: "custom",
        path: ["sleepKind"],
        message: "sleepKind は resource=sleep のときだけ指定できます。",
      });
    }
    if (query.beverageTypeId !== undefined && query.resource !== "hydration") {
      ctx.addIssue({
        code: "custom",
        path: ["beverageTypeId"],
        message: "beverageTypeId は resource=hydration のときだけ指定できます。",
      });
    }
    // 1件取得は「他の条件に依存しない」ことに意味がある。併用を黙って無視すると、
    // 呼び出し側が絞り込みが効いていると誤解したまま結果を読んでしまう。
    if (query.id !== undefined) {
      for (const name of ID_EXCLUSIVE_PARAMS) {
        if (query[name] !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: [name],
            message: `${name} は id による1件取得と併用できません。`,
          });
        }
      }
    }
  });

export type WellnessListQuery = z.infer<typeof wellnessListQuerySchema>;

export const wellnessPageSchema = z
  .object({
    limit: z.number().int(),
    order: wellnessOrderSchema,
    /** 次ページがあればカーソル、無ければ `null`。 */
    nextCursor: z.string().nullable(),
  })
  .strict();

/** GET の応答に常に含まれる、リソース非依存の部分。 */
const wellnessListCommonShape = {
  beverageTypes: z.array(beverageTypeSchema),
  symptomTypes: z.array(symptomTypeSchema),
  sleepGoals: z.array(sleepGoalSchema),
  hydrationGoals: z.array(hydrationGoalSchema),
  context: wellnessContextSchema,
  page: wellnessPageSchema,
};

/**
 * ページングされる一覧は `resource` で判別する。
 * フロントは `data.resource` で分岐すれば `entries` の型が確定する。
 */
export const wellnessListDataSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("sleep"),
      entries: z.array(sleepEntrySchema),
      ...wellnessListCommonShape,
    })
    .strict(),
  z
    .object({
      resource: z.literal("hydration"),
      entries: z.array(hydrationEntrySchema),
      ...wellnessListCommonShape,
    })
    .strict(),
  z
    .object({
      resource: z.literal("condition"),
      entries: z.array(conditionEntrySchema),
      ...wellnessListCommonShape,
    })
    .strict(),
]);

export const wellnessListResponseSchema = z.object({ data: wellnessListDataSchema }).strict();

export type WellnessListResponse = z.infer<typeof wellnessListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/wellness — 入力                                                   */
/* -------------------------------------------------------------------------- */

/**
 * 保存の結果。
 * - `created`: 新規作成した
 * - `updated`: 楽観ロックを通して更新した
 * - `idempotent_replay`: 同じ `clientMutationId` が適用済みで、当時の行を返した
 */
export const mutationOutcomeSchema = z.enum(["created", "updated", "idempotent_replay"]);
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;

/** 更新のときだけ `expectedRowVersion` を必須にする（実装仕様書 6.4節）。 */
const requireRowVersionOnUpdate = (
  input: { id?: string; expectedRowVersion?: number },
  ctx: z.RefinementCtx,
): void => {
  if (input.id !== undefined && input.expectedRowVersion === undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["expectedRowVersion"],
      message: "更新には expectedRowVersion が必要です。",
    });
  }
  if (input.id === undefined && input.expectedRowVersion !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: ["id"],
      message: "expectedRowVersion は更新（id 指定）のときだけ送ってください。",
    });
  }
};

/* ------------------------------- 睡眠記録 --------------------------------- */

export const sleepEntryInputSchema = z
  .object({
    /** 省略 → 作成 / 指定 → 更新（`expectedRowVersion` が必須になる）。 */
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    sleepKind: sleepKindSchema,
    bedAt: isoDateTimeSchema,
    sleepAt: isoDateTimeSchema,
    wakeAt: isoDateTimeSchema,
    outOfBedAt: isoDateTimeSchema,
    timezone: timezoneSchema.optional(),
    awakeningsCount: z.number().int().min(0).max(SLEEP_AWAKENINGS_MAX).optional(),
    awakeMinutes: z.number().int().min(0).max(SLEEP_AWAKE_MINUTES_MAX).optional(),
    quality: fivePointScaleSchema.nullable().optional(),
    morningFeeling: fivePointScaleSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type SleepEntryInput = z.infer<typeof sleepEntryInputSchema>;

/* ------------------------------- 水分記録 --------------------------------- */

export const hydrationEntryInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    beverageTypeId: z.uuid(),
    recordedAt: isoDateTimeSchema,
    unit: hydrationUnitSchema,
    amount: hydrationAmountSchema,
    /** 省略すると飲み物種別の既定値（`containsCaffeine`）を使う。 */
    containsCaffeine: z.boolean().optional(),
    /** 省略すると飲み物種別の既定値（`containsAlcohol`）を使う。 */
    containsAlcohol: z.boolean().optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type HydrationEntryInput = z.infer<typeof hydrationEntryInputSchema>;

/* ------------------------------- 体調記録 --------------------------------- */

export const conditionSymptomInputSchema = z
  .object({
    symptomTypeId: z.uuid(),
    severity: conditionScoreSchema.nullable().optional(),
    note: z
      .string()
      .max(200, { message: "症状メモは200文字以内で入力してください。" })
      .nullable()
      .optional(),
  })
  .strict();

export type ConditionSymptomInput = z.infer<typeof conditionSymptomInputSchema>;

export const conditionEntryInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    recordedAt: isoDateTimeSchema,
    timezone: timezoneSchema.optional(),
    overallScore: conditionScoreSchema.nullable().optional(),
    fatigueScore: conditionScoreSchema.nullable().optional(),
    energyScore: conditionScoreSchema.nullable().optional(),
    stressScore: conditionScoreSchema.nullable().optional(),
    painScore: conditionScoreSchema.nullable().optional(),
    moodScore: conditionScoreSchema.nullable().optional(),
    /** 実装仕様書 5.5節「体温（30〜45℃）」。小数第1位まで。 */
    bodyTemperatureC: z
      .number()
      .min(30, { message: "体温は30〜45℃で入力してください。" })
      .max(45, { message: "体温は30〜45℃で入力してください。" })
      .refine((value) => hasAtMostDecimals(value, 1), {
        message: "体温は小数第1位までで入力してください。",
      })
      .nullable()
      .optional(),
    /** 実装仕様書 5.5節「自由記述症状（10件まで）」。 */
    freeTextSymptoms: z
      .array(z.string().min(1).max(100, { message: "自由記述症状は100文字以内です。" }))
      .max(CONDITION_FREE_TEXT_SYMPTOM_MAX, {
        message: "自由記述症状は10件までです。",
      })
      .optional(),
    /**
     * 紐づける症状の**全集合**。送ると既存のリンクは置き換わる（部分更新ではない）。
     * 省略した場合は既存のリンクをそのまま残す。
     */
    symptoms: z
      .array(conditionSymptomInputSchema)
      .max(CONDITION_ENTRY_SYMPTOM_MAX, {
        message: "1件の記録に紐づけられる症状は43件までです。",
      })
      .refine(
        (symptoms) =>
          new Set(symptoms.map((symptom) => symptom.symptomTypeId)).size === symptoms.length,
        { message: "同じ症状を重複して指定できません。" },
      )
      .optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type ConditionEntryInput = z.infer<typeof conditionEntryInputSchema>;

/* --------------------------------- 目標 ----------------------------------- */

export const sleepGoalInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    /** 実装仕様書 5.5節「睡眠…の目標量」。60〜1440分。 */
    targetSleepMinutes: z.number().int().min(60).max(1440),
    weekdays: weekdaysSchema.optional(),
    targetBedtime: localTimeSchema.nullable().optional(),
    targetWakeTime: localTimeSchema.nullable().optional(),
    timezone: timezoneSchema.optional(),
    startDate: isoDateSchema,
    /** 省略・`null` なら「現在有効な目標」。所有者ごとに1件まで。 */
    endDate: isoDateSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type SleepGoalInput = z.infer<typeof sleepGoalInputSchema>;

export const hydrationGoalInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    /** 実装仕様書 5.5節「…水分の目標量」。ml で持つ（0超20,000以下）。 */
    targetAmountMl: z
      .number()
      .finite()
      .gt(0, { message: "目標量は0より大きい必要があります。" })
      .lte(20000, { message: "目標量は20,000ml以下で入力してください。" })
      .refine((value) => hasAtMostDecimals(value, AMOUNT_DECIMALS), {
        message: "目標量は小数第3位までで入力してください。",
      }),
    weekdays: weekdaysSchema.optional(),
    timezone: timezoneSchema.optional(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type HydrationGoalInput = z.infer<typeof hydrationGoalInputSchema>;

/* --------------------------------- 種別 ----------------------------------- */

/**
 * 種別の作成・更新。`id` の有無で分岐するのは記録・目標と同じ。
 *
 * 項目キー（`beverageKey` / `symptomKey`）は**作成のときだけ**送れる。
 * 更新で送ると 400 になる（DB の列レベル権限も UPDATE を許していない）。
 * キーを変えると、その種別に紐づく過去の記録の意味が後から変わってしまうため。
 *
 * `isDefault` はどちらの場合も送れない（既定種別を作れるのは seed のみ）。
 * アーカイブ／解除は `archived` で行う。既定種別はアーカイブできない。
 */
const requireKeyOnCreateOnly = (
  input: { id?: string },
  key: string | undefined,
  keyName: string,
  ctx: z.RefinementCtx,
): void => {
  if (input.id === undefined && key === undefined) {
    ctx.addIssue({
      code: "custom",
      path: [keyName],
      message: `${keyName} は新規作成のときに必須です。`,
    });
  }
  if (input.id !== undefined && key !== undefined) {
    ctx.addIssue({
      code: "custom",
      path: [keyName],
      message: `${keyName} は作成後に変更できません。更新では送らないでください。`,
    });
  }
};

export const beverageTypeInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    /** 作成時のみ必須。`^[a-z][a-z0-9_]{1,49}$`。既定カタログのキーは予約語。 */
    beverageKey: typeKeySchema.optional(),
    displayName: displayNameSchema,
    defaultUnit: hydrationUnitSchema,
    defaultAmount: hydrationAmountSchema.nullable().optional(),
    containsCaffeine: z.boolean().optional(),
    containsAlcohol: z.boolean().optional(),
    sortOrder: sortOrderSchema.optional(),
    /** `true` でアーカイブ、`false` で解除。省略すると現状のまま。 */
    archived: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    requireRowVersionOnUpdate(input, ctx);
    requireKeyOnCreateOnly(input, input.beverageKey, "beverageKey", ctx);
  });

export type BeverageTypeInput = z.infer<typeof beverageTypeInputSchema>;

export const symptomTypeInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    /** 作成時のみ必須。`^[a-z][a-z0-9_]{1,49}$`。既定カタログのキーは予約語。 */
    symptomKey: typeKeySchema.optional(),
    displayName: displayNameSchema,
    sortOrder: sortOrderSchema.optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    requireRowVersionOnUpdate(input, ctx);
    requireKeyOnCreateOnly(input, input.symptomKey, "symptomKey", ctx);
  });

export type SymptomTypeInput = z.infer<typeof symptomTypeInputSchema>;

/* ------------------------- POST のリクエスト全体 --------------------------- */

/**
 * `resource` で判別する。`seed_defaults` だけは冪等キーを取らない
 * （既定投入そのものが冪等なので、再送しても増えない）。
 */
export const saveWellnessRequestSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("sleep"),
      clientMutationId: clientMutationIdSchema.optional(),
      entry: sleepEntryInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("hydration"),
      clientMutationId: clientMutationIdSchema.optional(),
      entry: hydrationEntryInputSchema,
    })
    .strict(),
  // 体調記録だけ `clientMutationId` を**必須**にする。本体と症状リンクは
  // DB 関数 `save_condition_entry` が1トランザクションで書くが、応答を
  // 受け取れなかったときに「適用済みか未適用か」を判断できるのは冪等キーだけ。
  // キー無しで再送すると、新規作成では一意制約（所有者・記録日時）に当たって
  // 409 になり、利用者が自力で復帰できない（docs/api/wellness.md 6.2節）。
  z
    .object({
      resource: z.literal("condition"),
      clientMutationId: clientMutationIdSchema,
      entry: conditionEntryInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("sleep_goal"),
      clientMutationId: clientMutationIdSchema.optional(),
      goal: sleepGoalInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("hydration_goal"),
      clientMutationId: clientMutationIdSchema.optional(),
      goal: hydrationGoalInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("beverage_type"),
      clientMutationId: clientMutationIdSchema.optional(),
      type: beverageTypeInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("symptom_type"),
      clientMutationId: clientMutationIdSchema.optional(),
      type: symptomTypeInputSchema,
    })
    .strict(),
  z.object({ resource: z.literal("seed_defaults") }).strict(),
]);

export type SaveWellnessRequest = z.infer<typeof saveWellnessRequestSchema>;

/* ------------------------- POST のレスポンス全体 --------------------------- */

export const saveWellnessDataSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("sleep"),
      entry: sleepEntrySchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("hydration"),
      entry: hydrationEntrySchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("condition"),
      entry: conditionEntrySchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("sleep_goal"),
      goal: sleepGoalSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("hydration_goal"),
      goal: hydrationGoalSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("beverage_type"),
      type: beverageTypeSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("symptom_type"),
      type: symptomTypeSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("seed_defaults"),
      beverageTypes: z.array(beverageTypeSchema),
      symptomTypes: z.array(symptomTypeSchema),
      outcome: z.literal("seeded"),
    })
    .strict(),
]);

export const saveWellnessResponseSchema = z.object({ data: saveWellnessDataSchema }).strict();

export type SaveWellnessResponse = z.infer<typeof saveWellnessResponseSchema>;

/* -------------------------------------------------------------------------- */
/* DELETE /api/wellness                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 削除できるのは記録と目標だけ。種別（`beverage_type` / `symptom_type`）は
 * 削除せず、`archived: true` で無効化する（過去の記録を守るため）。
 */
export const WELLNESS_DELETABLE_RESOURCES = [
  "sleep",
  "hydration",
  "condition",
  "sleep_goal",
  "hydration_goal",
] as const;

export const wellnessDeletableResourceSchema = z.enum(WELLNESS_DELETABLE_RESOURCES);
export type WellnessDeletableResource = z.infer<typeof wellnessDeletableResourceSchema>;

export const deleteWellnessRequestSchema = z
  .object({
    resource: wellnessDeletableResourceSchema,
    id: z.uuid(),
    /** 省略可。指定した場合は版番号が一致する行だけを削除する（不一致は 409）。 */
    expectedRowVersion: rowVersionSchema.optional(),
  })
  .strict();

export type DeleteWellnessRequest = z.infer<typeof deleteWellnessRequestSchema>;

export const deleteWellnessResponseSchema = z
  .object({
    data: z
      .object({
        resource: wellnessDeletableResourceSchema,
        deletedId: z.uuid(),
      })
      .strict(),
  })
  .strict();

export type DeleteWellnessResponse = z.infer<typeof deleteWellnessResponseSchema>;

/* -------------------------------------------------------------------------- */
/* エラー応答                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 7章のエラー形式。詳細なコード一覧は `docs/api/wellness.md`。
 * `code` は増える可能性があるため文字列として受ける（未知コードで解釈に失敗させない）。
 */
export const apiErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
