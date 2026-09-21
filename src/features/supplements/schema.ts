/**
 * サプリメント API の確定契約（実装仕様書 5.6節 / 7章 / 9.2節）。
 *
 * **このモジュールが `/api/supplements` の唯一の契約源**。
 * フロントエンド（サプリメント画面）はここから型とスキーマを import して、
 * リクエストの組み立てとレスポンスの解釈に使う。
 * 詳しい説明・FEFO の挙動・エラーコード一覧・409 後の対象特定方法は
 * `docs/api/supplements.md`。
 *
 * 実装仕様書 9.2節に従い、全オブジェクトを `.strict()` にして未知フィールドを拒否する。
 * 所有者ID（`owner_id` / `user_id` など）はどのスキーマにも存在しない。
 * 所有者は常に検証済みサーバーセッションから導出する（実装仕様書 3.2節）。
 *
 * サーバー／クライアント双方から読み込むため、秘密値やサーバー専用の依存を
 * 持ち込まないこと。
 */

import { z } from "zod";

import {
  SUPPLEMENT_AMOUNT_DECIMALS,
  SUPPLEMENT_AMOUNT_MAX,
  SUPPLEMENT_CATEGORIES,
  SUPPLEMENT_FORMS,
  SUPPLEMENT_IDEMPOTENCY_KEY_MAX,
  SUPPLEMENT_IDEMPOTENCY_KEY_MIN,
  SUPPLEMENT_INTAKE_STATUSES,
  SUPPLEMENT_MEAL_RELATIONS,
  SUPPLEMENT_MOVEMENT_KINDS,
  SUPPLEMENT_QUANTITY_MAX,
  SUPPLEMENT_RECORDABLE_STATUSES,
  SUPPLEMENT_SCHEDULE_KINDS,
  SUPPLEMENT_UNITS,
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

/** 実装仕様書 6.3節: 表示タイムゾーンは IANA 名。 */
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

/** 実装仕様書 6.4節 / 8.1節: オフライン再送の冪等キー（共通パターン）。 */
export const clientMutationIdSchema = z.uuid();

/**
 * 実装仕様書 5.6節「冪等キー（8〜200文字）」。
 *
 * 服用記録**固有**のキーで、`clientMutationId`（UUID）とは別物
 * （docs/api/supplements.md 1.6節）。「この1回の服用」を所有者ごとに一意にし、
 * 同じ服用が二重に在庫を減らすのを防ぐ。
 */
export const supplementIdempotencyKeySchema = z
  .string()
  .min(SUPPLEMENT_IDEMPOTENCY_KEY_MIN, { message: "冪等キーは8〜200文字で指定してください。" })
  .max(SUPPLEMENT_IDEMPOTENCY_KEY_MAX, { message: "冪等キーは8〜200文字で指定してください。" });

/** 商品の stableKey。身体測定・睡眠の種別キーと同じ形をそのまま使う。 */
export const PRODUCT_KEY_PATTERN = /^[a-z][a-z0-9_]{1,49}$/;

export const productKeySchema = z.string().regex(PRODUCT_KEY_PATTERN, {
  message: "商品キーは英小文字で始まり、英小文字・数字・アンダースコアで2〜50文字にしてください。",
});

export const noteSchema = z.string().max(500, { message: "メモは500文字以内で入力してください。" });

const hasAtMostDecimals = (value: number, decimals: number): boolean => {
  const fraction = value.toString().split(".")[1];
  return fraction === undefined || fraction.length <= decimals;
};

const decimalMessage = "小数第4位までで入力してください。";

/** 服用量・既定量・予定量（0超 100,000以下）。 */
export const supplementAmountSchema = z
  .number()
  .finite()
  .gt(0, { message: "量は0より大きい必要があります。" })
  .lte(SUPPLEMENT_AMOUNT_MAX, { message: "量は100,000以下で入力してください。" })
  .refine((value) => hasAtMostDecimals(value, SUPPLEMENT_AMOUNT_DECIMALS), {
    message: decimalMessage,
  });

/** 在庫の数量（0超 1,000,000以下）。 */
export const supplementQuantitySchema = z
  .number()
  .finite()
  .gt(0, { message: "数量は0より大きい必要があります。" })
  .lte(SUPPLEMENT_QUANTITY_MAX, { message: "数量は1,000,000以下で入力してください。" })
  .refine((value) => hasAtMostDecimals(value, SUPPLEMENT_AMOUNT_DECIMALS), {
    message: decimalMessage,
  });

/** 残量・しきい値・消費量（0以上 1,000,000以下）。0 を許すのが上との違い。 */
export const supplementNonNegativeQuantitySchema = z
  .number()
  .finite()
  .min(0, { message: "0以上で入力してください。" })
  .lte(SUPPLEMENT_QUANTITY_MAX, { message: "1,000,000以下で入力してください。" })
  .refine((value) => hasAtMostDecimals(value, SUPPLEMENT_AMOUNT_DECIMALS), {
    message: decimalMessage,
  });

/** 実装仕様書 5.6節「対象曜日」。0=日曜〜6=土曜、1〜7件、重複なし。 */
export const weekdaysSchema = z
  .array(z.number().int().min(0).max(6))
  .min(1, { message: "対象曜日を1つ以上選んでください。" })
  .max(7, { message: "対象曜日は7件までです。" })
  .refine((days) => new Set(days).size === days.length, {
    message: "対象曜日が重複しています。",
  });

/** 実装仕様書 5.6節「HTTPS URL」。http:// や javascript: は受け付けない。 */
export const httpsUrlSchema = z
  .string()
  .max(2048, { message: "URLが長すぎます。" })
  .regex(/^https:\/\/\S+$/, { message: "URLは https:// で始まる形式で入力してください。" });

export const supplementCategorySchema = z.enum(SUPPLEMENT_CATEGORIES);
export const supplementFormSchema = z.enum(SUPPLEMENT_FORMS);
export const supplementUnitSchema = z.enum(SUPPLEMENT_UNITS);
export const supplementScheduleKindSchema = z.enum(SUPPLEMENT_SCHEDULE_KINDS);
export const supplementMealRelationSchema = z.enum(SUPPLEMENT_MEAL_RELATIONS);
export const supplementIntakeStatusSchema = z.enum(SUPPLEMENT_INTAKE_STATUSES);
export const supplementRecordableStatusSchema = z.enum(SUPPLEMENT_RECORDABLE_STATUSES);
export const supplementMovementKindSchema = z.enum(SUPPLEMENT_MOVEMENT_KINDS);

/* -------------------------------------------------------------------------- */
/* レスポンスの形                                                              */
/* -------------------------------------------------------------------------- */

/**
 * 商品ごとの在庫の要約。`supplement_product_stock()` が返す値。
 * 低在庫の警告と「あと何回分あるか」の表示に使う。
 */
export const supplementStockSchema = z
  .object({
    /** 有効な全ロットの残量合計（商品の `defaultUnit` で数える）。 */
    remainingTotal: z.number(),
    /** 残量が 0 より大きいロットの件数。 */
    lotCount: z.number().int(),
    /** 残量のあるロットのうち最も近い使用期限。無ければ `null`。 */
    nearestExpiresOn: isoDateSchema.nullable(),
    /** 実装仕様書 5.6節「低在庫商品数」。`lowStockThreshold` 未設定なら常に `false`。 */
    lowStock: z.boolean(),
  })
  .strict();

export type SupplementStock = z.infer<typeof supplementStockSchema>;

/** `public.supplement_products` の1行（API 表現）。 */
export const supplementProductSchema = z
  .object({
    id: z.uuid(),
    /** stableKey。作成後は変更できない。 */
    productKey: z.string(),
    name: z.string(),
    /** 実装仕様書 5.6節の重複禁止の判定キー（NFKC・空白畳み込み・小文字化）。 */
    nameNormalized: z.string(),
    brand: z.string().nullable(),
    category: supplementCategorySchema,
    form: supplementFormSchema,
    defaultAmount: z.number().nullable(),
    /** 既定量の単位。**在庫ロットの単位も必ずこれに揃う**。 */
    defaultUnit: supplementUnitSchema,
    amountPerContainer: z.number().nullable(),
    lowStockThreshold: z.number().nullable(),
    ingredientNote: z.string().nullable(),
    safetyNote: z.string().nullable(),
    url: z.string().nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    stock: supplementStockSchema,
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SupplementProduct = z.infer<typeof supplementProductSchema>;

/** 記録・予定・ロットの応答へ同梱する商品の識別情報（再問い合わせを省くため）。 */
const productLabelShape = {
  productId: z.uuid(),
  productKey: z.string(),
  productName: z.string(),
} as const;

/** `public.supplement_schedules` の1行（API 表現）。 */
export const supplementScheduleSchema = z
  .object({
    id: z.uuid(),
    ...productLabelShape,
    scheduleKind: supplementScheduleKindSchema,
    /** `HH:MM`。必要時（`as_needed`）は `null`。 */
    timeOfDay: z.string().nullable(),
    timezone: z.string(),
    /** 週次のときだけ配列、それ以外は `null`。 */
    weekdays: z.array(z.number().int()).nullable(),
    startDate: isoDateSchema,
    endDate: isoDateSchema.nullable(),
    amount: z.number(),
    unit: supplementUnitSchema,
    mealRelation: supplementMealRelationSchema,
    note: z.string().nullable(),
    archivedAt: isoDateTimeSchema.nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SupplementSchedule = z.infer<typeof supplementScheduleSchema>;

/** `public.supplement_inventory_lots` の1行（API 表現）。 */
export const supplementLotSchema = z
  .object({
    id: z.uuid(),
    ...productLabelShape,
    lotCode: z.string().nullable(),
    /** 入荷時の数量。 */
    quantity: z.number(),
    /** いま残っている量。0未満・`quantity` 超にはならない（DB の CHECK 制約）。 */
    remainingQuantity: z.number(),
    unit: supplementUnitSchema,
    purchasedOn: isoDateSchema.nullable(),
    openedOn: isoDateSchema.nullable(),
    expiresOn: isoDateSchema.nullable(),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SupplementLot = z.infer<typeof supplementLotSchema>;

/** `public.supplement_intake_logs` の1行（API 表現）。 */
export const supplementIntakeSchema = z
  .object({
    id: z.uuid(),
    ...productLabelShape,
    scheduleId: z.uuid().nullable(),
    status: supplementIntakeStatusSchema,
    scheduledFor: isoDateTimeSchema.nullable(),
    recordedAt: isoDateTimeSchema,
    timezone: z.string(),
    amount: z.number(),
    unit: supplementUnitSchema,
    /**
     * FEFO で実際にロットから引いた合計。
     * **取消しても 0 には戻らない**（記録当時の消費量として残す）。
     * 在庫が戻ったかどうかは `status === "voided"` で判断する。
     */
    consumedQuantity: z.number(),
    /** 実装仕様書 5.6節の冪等キー（8〜200文字）。 */
    idempotencyKey: z.string(),
    voidedAt: isoDateTimeSchema.nullable(),
    voidReason: z.string().nullable(),
    note: z.string().nullable(),
    rowVersion: z.number().int(),
    clientMutationId: z.uuid().nullable(),
    createdAt: isoDateTimeSchema,
    updatedAt: isoDateTimeSchema,
  })
  .strict();

export type SupplementIntake = z.infer<typeof supplementIntakeSchema>;

/** `public.supplement_inventory_movements` の1行（API 表現）。追記専用の監査証跡。 */
export const supplementMovementSchema = z
  .object({
    id: z.uuid(),
    ...productLabelShape,
    lotId: z.uuid(),
    /** 服用に伴う動きならその記録のID。ロット登録・手動調整では `null`。 */
    intakeLogId: z.uuid().nullable(),
    movementKind: supplementMovementKindSchema,
    /** 残量の増減。消費は負、復元・登録は正。 */
    quantityDelta: z.number(),
    unit: supplementUnitSchema,
    occurredAt: isoDateTimeSchema,
    note: z.string().nullable(),
    createdAt: isoDateTimeSchema,
  })
  .strict();

export type SupplementMovement = z.infer<typeof supplementMovementSchema>;

/** 実装仕様書 5.6節「集計」。`supplement_summary()` が返す値。 */
export const supplementSummarySchema = z
  .object({
    /** 直近7日間に発生するはずだった予定の回数（必要時は数えない）。 */
    weeklyScheduledCount: z.number().int(),
    /** 直近7日間の服用回数（`taken` / `as_needed`。取消・スキップは数えない）。 */
    weeklyTakenCount: z.number().int(),
    /** 直近30日間の服用回数。 */
    monthlyTakenCount: z.number().int(),
    /** 低在庫の商品数（しきい値が設定され、残量合計がそれ以下）。 */
    lowStockProductCount: z.number().int(),
    /** 期限接近ロット数（残量があり、期限が既定30日以内）。 */
    expiringLotCount: z.number().int(),
  })
  .strict();

export type SupplementSummary = z.infer<typeof supplementSummarySchema>;

/* -------------------------------------------------------------------------- */
/* GET /api/supplements                                                        */
/* -------------------------------------------------------------------------- */

/**
 * ページングする一覧リソース。1回の GET で1つだけ取る。
 *
 * 商品（`products`）は**どの応答にも全件入る**ので、ここには含めない
 * （睡眠・水分・体調の種別・目標と同じ扱い。docs/api/supplements.md 1.8節）。
 */
export const SUPPLEMENT_LIST_RESOURCES = ["schedule", "lot", "intake", "movement"] as const;
export const supplementListResourceSchema = z.enum(SUPPLEMENT_LIST_RESOURCES);
export type SupplementListResource = z.infer<typeof supplementListResourceSchema>;

export const supplementOrderSchema = z.enum(["asc", "desc"]);

export const SUPPLEMENT_PAGE_SIZE_DEFAULT = 100;
export const SUPPLEMENT_PAGE_SIZE_MAX = 500;

/** `id` と併用できない絞り込み（1件取得は他の条件に一切依存しない）。 */
const ID_EXCLUSIVE_PARAMS = ["from", "to", "cursor", "productId", "status"] as const;

/**
 * クエリ文字列の検証。`URLSearchParams` から作った素のオブジェクトを渡す。
 * 数値は文字列で届くため、ここで変換する。
 *
 * 取得方法は2つある（`docs/api/supplements.md` 1.7節）。
 *
 * 1. **`id` による1件取得**（409 後の対象特定はこちらを使う）。
 *    `resource` + `id` を指定すると、その行だけを所有者スコープで直接返す。
 *    `limit` にも日時・商品による絞り込みにも一切依存しない。
 * 2. **一覧**（`id` を指定しないとき）。`from` / `to` が比較する列は
 *    リソースごとに違う（下表）。
 *
 * | resource   | 時間軸       | 併用する絞り込み       |
 * | ---------- | ------------ | ---------------------- |
 * | `schedule` | `createdAt`  | `productId`            |
 * | `lot`      | `createdAt`  | `productId`            |
 * | `intake`   | `recordedAt` | `productId` / `status` |
 * | `movement` | `occurredAt` | `productId`            |
 */
export const supplementListQuerySchema = z
  .object({
    resource: supplementListResourceSchema.default("intake"),
    /**
     * 指定するとその1件だけを返す（0件なら**本当に存在しない**）。
     * 他の絞り込みとは併用できない。
     */
    id: z.uuid().optional(),
    /** 時間軸 >= from（含む）。 */
    from: isoDateTimeSchema.optional(),
    /** 時間軸 <= to（含む）。 */
    to: isoDateTimeSchema.optional(),
    order: supplementOrderSchema.default("desc"),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(SUPPLEMENT_PAGE_SIZE_MAX)
      .default(SUPPLEMENT_PAGE_SIZE_DEFAULT),
    /** 前ページの `page.nextCursor` をそのまま渡す（不透明な文字列）。 */
    cursor: z.string().min(1).max(512).optional(),
    /** どのリソースでも使える商品での絞り込み。 */
    productId: z.uuid().optional(),
    /** `resource=intake` のときだけ意味がある。 */
    status: supplementIntakeStatusSchema.optional(),
  })
  .strict()
  .superRefine((query, ctx) => {
    if (query.status !== undefined && query.resource !== "intake") {
      ctx.addIssue({
        code: "custom",
        path: ["status"],
        message: "status は resource=intake のときだけ指定できます。",
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

export type SupplementListQuery = z.infer<typeof supplementListQuerySchema>;

export const supplementPageSchema = z
  .object({
    limit: z.number().int(),
    order: supplementOrderSchema,
    /** 次ページがあればカーソル、無ければ `null`。 */
    nextCursor: z.string().nullable(),
  })
  .strict();

/** GET の応答に常に含まれる、リソース非依存の部分。 */
const supplementListCommonShape = {
  /** 所有者の商品カタログ全件（アーカイブ済みを含む）。名称順。 */
  products: z.array(supplementProductSchema),
  summary: supplementSummarySchema,
  page: supplementPageSchema,
};

/**
 * ページングされる一覧は `resource` で判別する。
 * フロントは `data.resource` で分岐すれば `entries` の型が確定する。
 */
export const supplementListDataSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("schedule"),
      entries: z.array(supplementScheduleSchema),
      ...supplementListCommonShape,
    })
    .strict(),
  z
    .object({
      resource: z.literal("lot"),
      entries: z.array(supplementLotSchema),
      ...supplementListCommonShape,
    })
    .strict(),
  z
    .object({
      resource: z.literal("intake"),
      entries: z.array(supplementIntakeSchema),
      ...supplementListCommonShape,
    })
    .strict(),
  z
    .object({
      resource: z.literal("movement"),
      entries: z.array(supplementMovementSchema),
      ...supplementListCommonShape,
    })
    .strict(),
]);

export const supplementListResponseSchema = z.object({ data: supplementListDataSchema }).strict();

export type SupplementListResponse = z.infer<typeof supplementListResponseSchema>;

/* -------------------------------------------------------------------------- */
/* POST /api/supplements — 入力                                                */
/* -------------------------------------------------------------------------- */

/**
 * 保存の結果。
 * - `created`: 新規作成した
 * - `updated`: 楽観ロックを通して更新した
 * - `idempotent_replay`: 同じ冪等キーが適用済みで、当時の行を返した
 */
export const mutationOutcomeSchema = z.enum(["created", "updated", "idempotent_replay"]);
export type MutationOutcome = z.infer<typeof mutationOutcomeSchema>;

/** 服用記録は更新しない（訂正は取消して録り直す）。 */
export const intakeOutcomeSchema = z.enum(["created", "idempotent_replay"]);
export type IntakeOutcome = z.infer<typeof intakeOutcomeSchema>;

/** 取消は「今回取り消した」か「既に取消済みだった」かのどちらか。 */
export const voidOutcomeSchema = z.enum(["voided", "idempotent_replay"]);
export type VoidOutcome = z.infer<typeof voidOutcomeSchema>;

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

/* --------------------------------- 商品 ----------------------------------- */

/**
 * 商品の作成・更新。
 *
 * `productKey`（stableKey）は**作成のときだけ**送れる。更新で送ると 400
 * （DB の列レベル権限も UPDATE を許していない）。キーを変えると、その商品に
 * 紐づく過去の服用記録・在庫の意味が後から変わってしまうため。
 */
export const supplementProductInputSchema = z
  .object({
    /** 省略 → 作成 / 指定 → 更新（`expectedRowVersion` が必須になる）。 */
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    /** 作成時のみ必須。`^[a-z][a-z0-9_]{1,49}$`。 */
    productKey: productKeySchema.optional(),
    name: z
      .string()
      .min(1, { message: "商品名を入力してください。" })
      .max(200, { message: "商品名は200文字以内で入力してください。" }),
    brand: z
      .string()
      .min(1)
      .max(100, { message: "ブランド名は100文字以内で入力してください。" })
      .nullable()
      .optional(),
    category: supplementCategorySchema,
    form: supplementFormSchema,
    defaultAmount: supplementAmountSchema.nullable().optional(),
    /**
     * 既定量の単位。**在庫の単位でもある**ので、在庫ロットが1件でもある商品では
     * 変更しないこと（変更すると既存ロットの単位と食い違い、DB のトリガーが
     * そのロットの更新を拒むようになる）。
     */
    defaultUnit: supplementUnitSchema,
    amountPerContainer: supplementQuantitySchema.nullable().optional(),
    lowStockThreshold: supplementNonNegativeQuantitySchema.nullable().optional(),
    ingredientNote: z
      .string()
      .min(1)
      .max(2000, { message: "成分メモは2,000文字以内で入力してください。" })
      .nullable()
      .optional(),
    safetyNote: z
      .string()
      .min(1)
      .max(2000, { message: "安全上の注意は2,000文字以内で入力してください。" })
      .nullable()
      .optional(),
    url: httpsUrlSchema.nullable().optional(),
    /** `true` でアーカイブ、`false` で解除。省略すると現状のまま。 */
    archived: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    requireRowVersionOnUpdate(input, ctx);
    if (input.id === undefined && input.productKey === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["productKey"],
        message: "productKey は新規作成のときに必須です。",
      });
    }
    if (input.id !== undefined && input.productKey !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["productKey"],
        message: "productKey は作成後に変更できません。更新では送らないでください。",
      });
    }
  });

export type SupplementProductInput = z.infer<typeof supplementProductInputSchema>;

/* -------------------------------- 摂取予定 --------------------------------- */

export const supplementScheduleInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    productId: z.uuid(),
    scheduleKind: supplementScheduleKindSchema,
    /** `HH:MM`。必要時（`as_needed`）以外では必須。 */
    timeOfDay: localTimeSchema.nullable().optional(),
    timezone: timezoneSchema.optional(),
    /** 週次では必須、それ以外では送れない。 */
    weekdays: weekdaysSchema.nullable().optional(),
    startDate: isoDateSchema,
    /** 実装仕様書 5.6節「終了日は開始日以降」。単発では開始日と同じ日のみ。 */
    endDate: isoDateSchema.nullable().optional(),
    amount: supplementAmountSchema,
    unit: supplementUnitSchema,
    mealRelation: supplementMealRelationSchema.optional(),
    note: noteSchema.nullable().optional(),
    archived: z.boolean().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    requireRowVersionOnUpdate(input, ctx);

    const weekdays = input.weekdays ?? null;
    const timeOfDay = input.timeOfDay ?? null;

    if (input.scheduleKind === "weekly") {
      if (weekdays === null) {
        ctx.addIssue({
          code: "custom",
          path: ["weekdays"],
          message: "週次の予定では対象曜日が必須です。",
        });
      }
    } else if (weekdays !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "対象曜日は週次の予定でのみ指定できます。",
      });
    }

    if (input.scheduleKind === "as_needed") {
      if (timeOfDay !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["timeOfDay"],
          message: "必要時の予定では時刻を指定できません。",
        });
      }
    } else if (timeOfDay === null) {
      ctx.addIssue({
        code: "custom",
        path: ["timeOfDay"],
        message: "単発・毎日・週次の予定では時刻が必須です。",
      });
    }

    if (input.endDate != null && input.endDate < input.startDate) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "終了日は開始日以降にしてください。",
      });
    }

    if (
      input.scheduleKind === "once" &&
      input.endDate != null &&
      input.endDate !== input.startDate
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["endDate"],
        message: "単発の予定では終了日を開始日と同じ日にしてください。",
      });
    }
  });

export type SupplementScheduleInput = z.infer<typeof supplementScheduleInputSchema>;

/* -------------------------------- 在庫ロット -------------------------------- */

export const supplementLotInputSchema = z
  .object({
    id: z.uuid().optional(),
    expectedRowVersion: rowVersionSchema.optional(),
    productId: z.uuid(),
    /** 任意の表示名。指定すると商品内で一意（同じ値の2件目は 409）。 */
    lotCode: z
      .string()
      .min(1)
      .max(50, { message: "ロット名は50文字以内で入力してください。" })
      .nullable()
      .optional(),
    quantity: supplementQuantitySchema,
    /**
     * 残量。省略すると**作成時は `quantity` と同じ**（開封前の新品）。
     * 更新時に省略すると現在の残量を保つ。
     * 明示すると手動調整として在庫の動き（`adjustment`）に記録される。
     */
    remainingQuantity: supplementNonNegativeQuantitySchema.optional(),
    /**
     * 単位。省略すると商品の `defaultUnit`。
     * 指定する場合も商品の `defaultUnit` と一致していなければ 400
     * （在庫は商品の単位で数える）。
     */
    unit: supplementUnitSchema.optional(),
    purchasedOn: isoDateSchema.nullable().optional(),
    openedOn: isoDateSchema.nullable().optional(),
    expiresOn: isoDateSchema.nullable().optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    requireRowVersionOnUpdate(input, ctx);

    if (input.remainingQuantity !== undefined && input.remainingQuantity > input.quantity) {
      ctx.addIssue({
        code: "custom",
        path: ["remainingQuantity"],
        message: "残量は数量以下にしてください。",
      });
    }
    if (input.openedOn != null && input.purchasedOn != null && input.openedOn < input.purchasedOn) {
      ctx.addIssue({
        code: "custom",
        path: ["openedOn"],
        message: "開封日は購入日以降にしてください。",
      });
    }
    if (
      input.expiresOn != null &&
      input.purchasedOn != null &&
      input.expiresOn < input.purchasedOn
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["expiresOn"],
        message: "使用期限は購入日以降にしてください。",
      });
    }
  });

export type SupplementLotInput = z.infer<typeof supplementLotInputSchema>;

/* -------------------------------- 服用記録 --------------------------------- */

/**
 * 服用の記録（実装仕様書 5.6節）。
 *
 * 更新（`id` + `expectedRowVersion`）は無い。**記録は作るか取り消すかのどちらか**で、
 * 訂正は「取消して録り直す」。在庫を動かした記録をあとから書き換えられると、
 * 消費量と実際の在庫の対応が崩れるため。
 *
 * `idempotencyKey` は**必須**。これが「この1回の服用」の識別子になり、
 * 再送しても在庫が二重に減らない唯一の保証になる。
 */
export const supplementIntakeInputSchema = z
  .object({
    productId: z.uuid(),
    /** 実装仕様書 5.6節「冪等キー（8〜200文字）」。 */
    idempotencyKey: supplementIdempotencyKeySchema,
    recordedAt: isoDateTimeSchema,
    /** 省略すると `taken`。`voided` は指定できない（取消は `void_intake`）。 */
    status: supplementRecordableStatusSchema.optional(),
    /** 省略すると商品の `defaultAmount`（未設定なら 400）。 */
    amount: supplementAmountSchema.optional(),
    /** 省略すると商品の `defaultUnit`。 */
    unit: supplementUnitSchema.optional(),
    /** 予定に対する記録ならその予定のID。予定外の服用では省略する。 */
    scheduleId: z.uuid().nullable().optional(),
    /** 実装仕様書 5.6節「予定発生日時」。予定外の服用では省略する。 */
    scheduledFor: isoDateTimeSchema.nullable().optional(),
    /**
     * 在庫から引く量（**商品の `defaultUnit` で数える**）。
     *
     * - 省略 & `status: "skipped"` → 0
     * - 省略 & `unit` が商品の `defaultUnit` と同じ → `amount` をそのまま引く
     * - 省略 & `unit` が違う → 400（`SUPPLEMENT_UNIT_MISMATCH`）。
     *   換算はアプリ側の責任なので、明示させる
     * - `0` を明示すると在庫を引かずに記録だけ残せる（手持ちの別在庫から飲んだ場合など）
     */
    consumeQuantity: supplementNonNegativeQuantitySchema.optional(),
    timezone: timezoneSchema.optional(),
    note: noteSchema.nullable().optional(),
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.status === "skipped" && input.consumeQuantity !== undefined) {
      if (input.consumeQuantity !== 0) {
        ctx.addIssue({
          code: "custom",
          path: ["consumeQuantity"],
          message: "スキップした服用では在庫を消費できません。",
        });
      }
    }
  });

export type SupplementIntakeInput = z.infer<typeof supplementIntakeInputSchema>;

/**
 * 服用の取消（実装仕様書 5.6節）。
 *
 * 対象は**主キー `id`** で指定する。`expectedRowVersion` は任意だが、
 * 画面から取り消すときは必ず送ること（一覧を開いたまま別端末で操作された場合に
 * 気づかず取り消すのを防げる）。既に取消済みの記録への再送は 409 にならず、
 * `idempotent_replay` としてその行が返る。
 */
export const supplementVoidInputSchema = z
  .object({
    id: z.uuid(),
    expectedRowVersion: rowVersionSchema.optional(),
    reason: z
      .string()
      .min(1)
      .max(200, { message: "取消理由は200文字以内で入力してください。" })
      .nullable()
      .optional(),
  })
  .strict();

export type SupplementVoidInput = z.infer<typeof supplementVoidInputSchema>;

/* ------------------------- POST のリクエスト全体 --------------------------- */

export const saveSupplementRequestSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("product"),
      clientMutationId: clientMutationIdSchema.optional(),
      product: supplementProductInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("schedule"),
      clientMutationId: clientMutationIdSchema.optional(),
      schedule: supplementScheduleInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("lot"),
      clientMutationId: clientMutationIdSchema.optional(),
      lot: supplementLotInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("intake"),
      clientMutationId: clientMutationIdSchema.optional(),
      intake: supplementIntakeInputSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("void_intake"),
      clientMutationId: clientMutationIdSchema.optional(),
      void: supplementVoidInputSchema,
    })
    .strict(),
]);

export type SaveSupplementRequest = z.infer<typeof saveSupplementRequestSchema>;

/* ------------------------- POST のレスポンス全体 --------------------------- */

/**
 * 在庫を動かした保存（`intake` / `void_intake` / `lot`）は、動いたあとの
 * 商品の在庫要約（`stock`）を必ず同梱する。画面が低在庫の警告を出し直すために
 * 一覧を取り直す必要をなくすため。
 */
export const saveSupplementDataSchema = z.discriminatedUnion("resource", [
  z
    .object({
      resource: z.literal("product"),
      product: supplementProductSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("schedule"),
      schedule: supplementScheduleSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("lot"),
      lot: supplementLotSchema,
      stock: supplementStockSchema,
      outcome: mutationOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("intake"),
      intake: supplementIntakeSchema,
      stock: supplementStockSchema,
      outcome: intakeOutcomeSchema,
    })
    .strict(),
  z
    .object({
      resource: z.literal("void_intake"),
      intake: supplementIntakeSchema,
      stock: supplementStockSchema,
      outcome: voidOutcomeSchema,
    })
    .strict(),
]);

export const saveSupplementResponseSchema = z.object({ data: saveSupplementDataSchema }).strict();

export type SaveSupplementResponse = z.infer<typeof saveSupplementResponseSchema>;

/* -------------------------------------------------------------------------- */
/* DELETE /api/supplements                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 削除できるのは摂取予定と在庫ロットだけ。
 *
 * - 商品は削除しない（`archived: true` で無効化）。消すと紐づく服用記録・在庫・
 *   監査証跡が CASCADE で全部消える。
 * - 服用記録は削除しない（`void_intake` で取り消す）。実装仕様書 5.6節が
 *   取消を定めており、物理削除は在庫の動きの証跡を壊す。
 * - 在庫ロットは、**服用に使われていなければ**削除できる（打ち間違えたロットの
 *   取り消し）。使われていれば 409（`SUPPLEMENT_LOT_IN_USE`）。
 */
export const SUPPLEMENT_DELETABLE_RESOURCES = ["schedule", "lot"] as const;

export const supplementDeletableResourceSchema = z.enum(SUPPLEMENT_DELETABLE_RESOURCES);
export type SupplementDeletableResource = z.infer<typeof supplementDeletableResourceSchema>;

export const deleteSupplementRequestSchema = z
  .object({
    resource: supplementDeletableResourceSchema,
    id: z.uuid(),
    /** 省略可。指定した場合は版番号が一致する行だけを削除する（不一致は 409）。 */
    expectedRowVersion: rowVersionSchema.optional(),
  })
  .strict();

export type DeleteSupplementRequest = z.infer<typeof deleteSupplementRequestSchema>;

export const deleteSupplementResponseSchema = z
  .object({
    data: z
      .object({
        resource: supplementDeletableResourceSchema,
        deletedId: z.uuid(),
      })
      .strict(),
  })
  .strict();

export type DeleteSupplementResponse = z.infer<typeof deleteSupplementResponseSchema>;

/* -------------------------------------------------------------------------- */
/* エラー応答                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 7章のエラー形式。詳細なコード一覧は `docs/api/supplements.md`。
 * `code` は増える可能性があるため文字列として受ける（未知コードで解釈に失敗させない）。
 */
export const apiErrorResponseSchema = z
  .object({
    error: z.object({ code: z.string(), message: z.string() }).strict(),
  })
  .strict();

export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
