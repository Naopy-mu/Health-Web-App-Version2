/**
 * 身体測定 API の確定契約（実装仕様書 5.3節 / 7章 / 9.2節）。
 *
 * **このモジュールが `/api/measurements` 系の唯一の契約源**。
 * フロントエンド（`/measurements` 画面）はここから型とスキーマを import して、
 * リクエストの組み立てとレスポンスの解釈に使う。
 * 詳しい説明・エラーコード一覧・ページング方式は `docs/api/measurements.md`。
 *
 * 実装仕様書 9.2節に従い、全オブジェクトを `.strict()` にして未知フィールドを拒否する。
 * 所有者ID（`owner_id` / `user_id` など）はどのスキーマにも存在しない。
 * 所有者は常に検証済みサーバーセッションから導出する（実装仕様書 3.2節）。
 *
 * サーバー／クライアント双方から読み込むため、秘密値やサーバー専用の依存を
 * 持ち込まないこと。
 */

import { z } from "zod";

import { MEASUREMENT_UNIT_CONSTRAINTS, MEASUREMENT_UNITS } from "./units";

/* -------------------------------------------------------------------------- */
/* 値の基本形                                                                  */
/* -------------------------------------------------------------------------- */

/** 実装仕様書 6.3節: 瞬間は `timestamptz`。オフセット付き ISO 8601 のみ受け付ける。 */
export const isoDateTimeSchema = z.iso.datetime({ offset: true });

/** 実装仕様書 6.3節: 日単位は `date`。 */
export const isoDateSchema = z.iso.date();

export const measurementUnitSchema = z.enum(MEASUREMENT_UNITS);
export const measurementUnitConstraintSchema = z.enum(MEASUREMENT_UNIT_CONSTRAINTS);

/** DB の `numeric(10,3)` に合わせ、小数第3位までに制限する（暗黙の丸めを起こさない）。 */
const MEASUREMENT_VALUE_DECIMALS = 3;

const hasAtMostDecimals = (value: number, decimals: number): boolean => {
  const fraction = value.toString().split(".")[1];
  return fraction === undefined || fraction.length <= decimals;
};

/** 実装仕様書 5.3節「値（0超1000以下）」。 */
export const measurementValueSchema = z
  .number()
  .finite()
  .gt(0, { message: "値は0より大きい必要があります。" })
  .lte(1000, { message: "値は1000以下で入力してください。" })
  .refine((value) => hasAtMostDecimals(value, MEASUREMENT_VALUE_DECIMALS), {
    message: "値は小数第3位までで入力してください。",
  });

/** 実装仕様書 5.3節「メモ（500字）」。 */
export const measurementNoteSchema = z
  .string()
  .max(500, { message: "メモは500文字以内で入力してください。" });

/** 測定条件（例: 起床直後、食後2時間）。 */
export const measurementConditionSchema = z
  .string()
  .min(1)
  .max(200, { message: "測定条件は200文字以内で入力してください。" });

/** 測定部位（例: 左、右、上腕中央）。 */
export const measurementBodySiteSchema = z
  .string()
  .min(1)
  .max(100, { message: "測定部位は100文字以内で入力してください。" });

/** 実装仕様書 5.3節「カスタム項目キー（`^[a-z][a-z0-9_]{1,49}$`）」。 */
export const MEASUREMENT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export const measurementKeySchema = z.string().regex(MEASUREMENT_KEY_PATTERN, {
  message: "項目キーは英小文字で始まり、英小文字・数字・アンダースコアで2〜50文字にしてください。",
});

export const measurementDisplayNameSchema = z
  .string()
  .min(1, { message: "表示名を入力してください。" })
  .max(100, { message: "表示名は100文字以内で入力してください。" });

/** 実装仕様書 6.4節: 楽観ロックの期待版番号。 */
export const rowVersionSchema = z.number().int().min(1);

/** 実装仕様書 6.4節: オフライン再送の冪等キー。 */
export const clientMutationIdSchema = z.uuid();

/* -------------------------------------------------------------------------- */
/* 写真参照（実装仕様書 5.3節 / 6.6節）                                        */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 5.3節:
 * > 写真参照（HTTPS URL または `storage://health-images/<uuid>/...` 形式のみ許可）
 *
 * `<uuid>` は実装仕様書 6.6節のオブジェクトパス `<auth.uid()>/<random-uuid>.<ext>`
 * の先頭セグメント、すなわち所有者のIDにあたる。**所有者一致の検査はサーバー側**
 * （`src/server/body-measurements/photo-reference.ts`）で行い、DBの CHECK 制約も
 * 同じ形を要求する。ここでは形だけを見る。
 */
export const PHOTO_REFERENCE_MAX_LENGTH = 2048;
export const STORAGE_PHOTO_REFERENCE_PREFIX = "storage://health-images/";

const UUID_SEGMENT = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

export const STORAGE_PHOTO_REFERENCE_PATTERN = new RegExp(
  `^storage://health-images/(${UUID_SEGMENT})/([A-Za-z0-9._~%-]+(?:/[A-Za-z0-9._~%-]+)*)$`,
);

export type StoragePhotoReference = {
  readonly ownerId: string;
  readonly objectPath: string;
};

/** `storage://health-images/<uuid>/<path>` を分解する。形が違えば `null`。 */
export function parseStoragePhotoReference(reference: string): StoragePhotoReference | null {
  const matched = STORAGE_PHOTO_REFERENCE_PATTERN.exec(reference);
  if (!matched) {
    return null;
  }
  return { ownerId: matched[1] ?? "", objectPath: matched[2] ?? "" };
}

const isHttpsUrl = (value: string): boolean => {
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
};

export const photoReferenceSchema = z
  .string()
  .max(PHOTO_REFERENCE_MAX_LENGTH, { message: "写真参照が長すぎます。" })
  .refine((value) => isHttpsUrl(value) || parseStoragePhotoReference(value) !== null, {
    message:
      "写真参照は HTTPS URL または storage://health-images/<uuid>/... 形式で指定してください。",
  });

/* -------------------------------------------------------------------------- */
/* レスポンスの形                                                              */
/* -------------------------------------------------------------------------- */

/** `public.body_measurement_types` の1行（API 表現）。 */
export const measurementTypeSchema = z
  .object({
    id: z.uuid(),
    measurementKey: z.string(),
    displayName: z.string(),
    unitConstraint: measurementUnitConstraintSchema,
    defaultUnit: measurementUnitSchema,
    isDefault: z.boolean(),
    sortOrder: z.number().int(),
    archivedAt: isoDateTimeSchema.nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type MeasurementType = z.infer<typeof measurementTypeSchema>;

/** 正規化値の単位（実装仕様書 6.3節の集計用の値）。`custom` の記録では `null`。 */
export const normalizedUnitSchema = z.enum(["kg", "cm", "percent", "index"]);

/** `public.body_measurements` の1行（API 表現）。 */
export const measurementSchema = z
  .object({
    id: z.uuid(),
    typeId: z.uuid(),
    /** 参照の手間を省くため種別の識別子・表示名を同梱する（CSV・グラフ用）。 */
    measurementKey: z.string(),
    displayName: z.string(),
    measuredAt: isoDateTimeSchema,
    value: z.number(),
    unit: measurementUnitSchema,
    /** 実装仕様書 6.3節の集計用の正規化値。DBの生成列の値をそのまま返す。 */
    normalizedValue: z.number().nullable(),
    normalizedUnit: normalizedUnitSchema.nullable(),
    note: z.string().nullable(),
    measurementCondition: z.string().nullable(),
    bodySite: z.string().nullable(),
    photoReference: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type Measurement = z.infer<typeof measurementSchema>;

/** `public.body_measurement_goals` の1行（API 表現）。 */
export const measurementGoalSchema = z
  .object({
    id: z.uuid(),
    typeId: z.uuid(),
    measurementKey: z.string(),
    displayName: z.string(),
    targetValue: z.number(),
    unit: measurementUnitSchema,
    startValue: z.number().nullable(),
    targetDate: isoDateSchema.nullable(),
    note: z.string().nullable(),
    achievedAt: isoDateTimeSchema.nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type MeasurementGoal = z.infer<typeof measurementGoalSchema>;

/**
 * BMI の算出結果（実装仕様書 5.3節）。
 * 身長は確定プロフィール（`user_profiles.settings.confirmed_profile.heightCm`）由来。
 * 身長または体重が無い場合は `bmi` が `null` になる。
 */
export const measurementContextSchema = z
  .object({
    heightCm: z.number().nullable(),
    latestWeightKg: z.number().nullable(),
    latestWeightMeasuredAt: isoDateTimeSchema.nullable(),
    bmi: z.number().nullable(),
  })
  .strict();

export type MeasurementContext = z.infer<typeof measurementContextSchema>;

/* -------------------------------------------------------------------------- */
/* GET /api/measurements                                                       */
/* -------------------------------------------------------------------------- */

/** 一覧の並び順。既定は新しい順。 */
export const measurementOrderSchema = z.enum(["asc", "desc"]);

export const MEASUREMENT_PAGE_SIZE_DEFAULT = 100;
export const MEASUREMENT_PAGE_SIZE_MAX = 500;

/**
 * クエリ文字列の検証。`URLSearchParams` から作った素のオブジェクトを渡す。
 * 数値・真偽値は文字列で届くため、ここで変換する。
 */
export const measurementListQuerySchema = z
  .object({
    typeId: z.uuid().optional(),
    measurementKey: measurementKeySchema.optional(),
    /** `measuredAt >= from`（含む）。 */
    from: isoDateTimeSchema.optional(),
    /** `measuredAt <= to`（含む）。 */
    to: isoDateTimeSchema.optional(),
    order: measurementOrderSchema.default("desc"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(MEASUREMENT_PAGE_SIZE_MAX)
      .default(MEASUREMENT_PAGE_SIZE_DEFAULT),
    /** 前ページの `page.nextCursor` をそのまま渡す（不透明な文字列）。 */
    cursor: z.string().min(1).max(512).optional(),
  })
  .strict();

export type MeasurementListQuery = z.infer<typeof measurementListQuerySchema>;

export const measurementPageSchema = z
  .object({
    limit: z.number().int(),
    order: measurementOrderSchema,
    /** 次ページがあればカーソル、無ければ `null`。 */
    nextCursor: z.string().nullable(),
  })
  .strict();

export const measurementListResponseSchema = z
  .object({
    data: z
      .object({
        measurements: z.array(measurementSchema),
        /** 所有者の測定種別（アーカイブ済みを含む全件）。ラベル解決に使う。 */
        types: z.array(measurementTypeSchema),
        context: measurementContextSchema,
        page: measurementPageSchema,
      })
      .strict(),
  })
  .strict();

export type MeasurementListResponse = z.infer<typeof measurementListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/measurements                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 保存の結果。
 * - `created`: 新規作成した
 * - `updated`: 楽観ロックを通して更新した
 * - `idempotent_replay`: 同じ `clientMutationId` が適用済みで、既存の行を返した
 */
export const mutationOutcomeSchema = z.enum(["created", "updated", "idempotent_replay"]);
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;

const measurementInputShape = {
  /** 省略で新規作成、指定で更新（`expectedRowVersion` が必須になる）。 */
  id: z.uuid().optional(),
  /** 実装仕様書 6.4節: 更新時の期待版番号。不一致は 409。 */
  expectedRowVersion: rowVersionSchema.optional(),
  typeId: z.uuid(),
  measuredAt: isoDateTimeSchema,
  value: measurementValueSchema,
  unit: measurementUnitSchema,
  note: measurementNoteSchema.nullable().optional(),
  measurementCondition: measurementConditionSchema.nullable().optional(),
  bodySite: measurementBodySiteSchema.nullable().optional(),
  photoReference: photoReferenceSchema.nullable().optional(),
};

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

export const measurementInputSchema = z
  .object(measurementInputShape)
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type MeasurementInput = z.infer<typeof measurementInputSchema>;

export const saveMeasurementRequestSchema = z
  .object({
    /** 実装仕様書 6.4節: オフラインキューの再送で二重登録しないための冪等キー。 */
    clientMutationId: clientMutationIdSchema.optional(),
    measurement: measurementInputSchema,
  })
  .strict();

export type SaveMeasurementRequest = z.infer<typeof saveMeasurementRequestSchema>;

export const saveMeasurementResponseSchema = z
  .object({
    data: z
      .object({
        measurement: measurementSchema,
        outcome: mutationOutcomeSchema,
        /**
         * 実装仕様書 5.3節の BMI。**既定の体重種別**（`isDefault: true` かつ
         * `measurementKey: "weight"`）の記録を保存したとき、確定プロフィールの身長が
         * 分かっていれば算出して返す。カスタムの `kg`/`lb` 種別からは算出しない（`null`）。
         */
        derivedBmi: z.number().nullable(),
      })
      .strict(),
  })
  .strict();

export type SaveMeasurementResponse = z.infer<typeof saveMeasurementResponseSchema>;

/* -------------------------------------------------------------------------- */
/* DELETE /api/measurements                                                    */
/* -------------------------------------------------------------------------- */

export const deleteMeasurementRequestSchema = z
  .object({
    measurementId: z.uuid(),
    /** 省略可。指定した場合は版番号が一致する行だけを削除する（不一致は 409）。 */
    expectedRowVersion: rowVersionSchema.optional(),
  })
  .strict();

export type DeleteMeasurementRequest = z.infer<typeof deleteMeasurementRequestSchema>;

export const deleteResponseSchema = z
  .object({ data: z.object({ deletedId: z.uuid() }).strict() })
  .strict();

export type DeleteResponse = z.infer<typeof deleteResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/measurements/types                                                */
/* -------------------------------------------------------------------------- */

export const createMeasurementTypeInputSchema = z
  .object({
    measurementKey: measurementKeySchema,
    displayName: measurementDisplayNameSchema,
    unitConstraint: measurementUnitConstraintSchema,
    defaultUnit: measurementUnitSchema,
    sortOrder: z.number().int().min(0).max(100000).optional(),
  })
  .strict();

export type CreateMeasurementTypeInput = z.infer<typeof createMeasurementTypeInputSchema>;

/**
 * `action` による判別。
 * - `seed_defaults`: 既定10種別を冪等に投入する（`seed_default_body_measurement_types` RPC）
 * - `create`: カスタム種別を1件追加する
 *
 * 既定種別かどうか（`isDefault`）はクライアントから指定できない。
 */
export const measurementTypeRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("seed_defaults") }).strict(),
  z
    .object({
      action: z.literal("create"),
      clientMutationId: clientMutationIdSchema.optional(),
      type: createMeasurementTypeInputSchema,
    })
    .strict(),
]);

export type MeasurementTypeRequest = z.infer<typeof measurementTypeRequestSchema>;

export const measurementTypeOutcomeSchema = z.enum(["seeded", "created", "idempotent_replay"]);

export const measurementTypeResponseSchema = z
  .object({
    data: z
      .object({
        /** `seed_defaults` は既定10種別、`create` は追加した1件。 */
        types: z.array(measurementTypeSchema),
        outcome: measurementTypeOutcomeSchema,
      })
      .strict(),
  })
  .strict();

export type MeasurementTypeResponse = z.infer<typeof measurementTypeResponseSchema>;

/* -------------------------------------------------------------------------- */
/* PATCH /api/measurements/types/{id}                                          */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 5.3節:
 * > カスタム種別は**アーカイブ（`archived_at`）による無効化**のみを許可し、
 * > 削除（DELETE）は提供しない（既存の測定記録・目標を保護するため）。
 * > 既定種別はアーカイブも不可とする。
 *
 * `archived: true` で `archived_at` を設定し、`false` で解除する。
 * 既定種別に対する要求は 400 で拒否される（DB の CHECK 制約も同じ形を禁じる）。
 */
export const archiveMeasurementTypeRequestSchema = z
  .object({
    clientMutationId: clientMutationIdSchema.optional(),
    /** 実装仕様書 6.4節: 楽観ロックの期待版番号。 */
    expectedRowVersion: rowVersionSchema,
    archived: z.boolean(),
  })
  .strict();

export type ArchiveMeasurementTypeRequest = z.infer<typeof archiveMeasurementTypeRequestSchema>;

export const measurementTypeUpdateOutcomeSchema = z.enum(["updated", "idempotent_replay"]);

export const archiveMeasurementTypeResponseSchema = z
  .object({
    data: z
      .object({ type: measurementTypeSchema, outcome: measurementTypeUpdateOutcomeSchema })
      .strict(),
  })
  .strict();

export type ArchiveMeasurementTypeResponse = z.infer<typeof archiveMeasurementTypeResponseSchema>;

/* -------------------------------------------------------------------------- */
/* /api/measurements/goals                                                     */
/* -------------------------------------------------------------------------- */

export const measurementGoalListQuerySchema = z
  .object({
    typeId: z.uuid().optional(),
    /** 既定では未達成の目標だけを返す。 */
    includeAchieved: z
      .enum(["true", "false"])
      .default("false")
      .transform((value) => value === "true"),
  })
  .strict();

export type MeasurementGoalListQuery = z.infer<typeof measurementGoalListQuerySchema>;

export const measurementGoalListResponseSchema = z
  .object({
    data: z.object({ goals: z.array(measurementGoalSchema) }).strict(),
  })
  .strict();

export type MeasurementGoalListResponse = z.infer<typeof measurementGoalListResponseSchema>;

export const measurementGoalInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    typeId: z.uuid(),
    targetValue: measurementValueSchema,
    unit: measurementUnitSchema,
    startValue: measurementValueSchema.nullable().optional(),
    targetDate: isoDateSchema.nullable().optional(),
    note: measurementNoteSchema.nullable().optional(),
    /** 達成日時。設定すると「未達成は種別ごとに1件」の制約から外れる。 */
    achievedAt: isoDateTimeSchema.nullable().optional(),
  })
  .strict()
  .superRefine(requireRowVersionOnUpdate);

export type MeasurementGoalInput = z.infer<typeof measurementGoalInputSchema>;

export const saveMeasurementGoalRequestSchema = z
  .object({
    clientMutationId: clientMutationIdSchema.optional(),
    goal: measurementGoalInputSchema,
  })
  .strict();

export type SaveMeasurementGoalRequest = z.infer<typeof saveMeasurementGoalRequestSchema>;

export const saveMeasurementGoalResponseSchema = z
  .object({
    data: z.object({ goal: measurementGoalSchema, outcome: mutationOutcomeSchema }).strict(),
  })
  .strict();

export type SaveMeasurementGoalResponse = z.infer<typeof saveMeasurementGoalResponseSchema>;

export const deleteMeasurementGoalRequestSchema = z
  .object({
    goalId: z.uuid(),
    expectedRowVersion: rowVersionSchema.optional(),
  })
  .strict();

export type DeleteMeasurementGoalRequest = z.infer<typeof deleteMeasurementGoalRequestSchema>;

/* -------------------------------------------------------------------------- */
/* エラー応答                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 7章のエラー形式。詳細なコード一覧は `docs/api/measurements.md`。
 * `code` は増える可能性があるため文字列として受ける（未知コードで解釈に失敗させない）。
 */
export const apiErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
