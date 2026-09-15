/**
 * サプリメントの列挙値と在庫の計算（実装仕様書 5.6節）。
 *
 * DB 側の定義域関数（`supabase/migrations/20260915000100_supplements_core.sql` の
 * `supplement_category_is_allowed()` ほか）と**1対1に対応**させる。
 * ずれると「API は通るが DB の CHECK に落ちる」値ができてしまうため、
 * 一致は `tests/db/supplements.test.ts` の契約テストで固定する。
 *
 * サーバー／クライアント双方から読み込むので、サーバー専用の依存を持ち込まない。
 */

/* -------------------------------------------------------------------------- */
/* 列挙値                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 実装仕様書 5.6節:
 * > カテゴリ（ビタミン、ミネラル、プロテイン、アミノ酸、食物繊維、
 * > プロバイオティクス、植物性、その他）
 */
export const SUPPLEMENT_CATEGORIES = [
  "vitamin",
  "mineral",
  "protein",
  "amino_acid",
  "fiber",
  "probiotic",
  "botanical",
  "other",
] as const;

export type SupplementCategory = (typeof SUPPLEMENT_CATEGORIES)[number];

/** 実装仕様書 5.6節: 剤形（錠剤、カプセル、粉末、液体、グミ、顆粒、その他）。 */
export const SUPPLEMENT_FORMS = [
  "tablet",
  "capsule",
  "powder",
  "liquid",
  "gummy",
  "granule",
  "other",
] as const;

export type SupplementForm = (typeof SUPPLEMENT_FORMS)[number];

/**
 * 実装仕様書 5.6節「既定量と単位」。
 *
 * **在庫もこの単位で数える。** 商品の `defaultUnit` が在庫単位を兼ね、
 * 在庫ロットの単位は必ずそれに揃う（DB のトリガーが強制する）。
 */
export const SUPPLEMENT_UNITS = [
  "tablet",
  "capsule",
  "gummy",
  "sachet",
  "scoop",
  "drop",
  "piece",
  "g",
  "mg",
  "mcg",
  "ml",
] as const;

export type SupplementUnit = (typeof SUPPLEMENT_UNITS)[number];

/** 実装仕様書 5.6節: 摂取予定は単発／毎日／週次／必要時。 */
export const SUPPLEMENT_SCHEDULE_KINDS = ["once", "daily", "weekly", "as_needed"] as const;

export type SupplementScheduleKind = (typeof SUPPLEMENT_SCHEDULE_KINDS)[number];

/** 実装仕様書 5.6節: 食事との関係（指定なし／食前／食中／食後／表示に従う）。 */
export const SUPPLEMENT_MEAL_RELATIONS = [
  "unspecified",
  "before_meal",
  "with_meal",
  "after_meal",
  "as_labeled",
] as const;

export type SupplementMealRelation = (typeof SUPPLEMENT_MEAL_RELATIONS)[number];

/** 実装仕様書 5.6節: 服用記録の状態（服用／スキップ／取消／必要時）。 */
export const SUPPLEMENT_INTAKE_STATUSES = ["taken", "skipped", "voided", "as_needed"] as const;

export type SupplementIntakeStatus = (typeof SUPPLEMENT_INTAKE_STATUSES)[number];

/**
 * 記録時に指定できる状態。`voided` は含まれない。
 * 取消は `resource: "void_intake"`（`void_supplement_intake` RPC）からのみ行える
 * ——在庫を戻さずに「取消済み」の記録を作れてしまうと在庫が合わなくなるため。
 */
export const SUPPLEMENT_RECORDABLE_STATUSES = ["taken", "skipped", "as_needed"] as const;

export type SupplementRecordableStatus = (typeof SUPPLEMENT_RECORDABLE_STATUSES)[number];

/** 在庫の動きの種別（監査証跡）。 */
export const SUPPLEMENT_MOVEMENT_KINDS = [
  "purchase",
  "intake_consume",
  "intake_void_restore",
  "adjustment",
] as const;

export type SupplementMovementKind = (typeof SUPPLEMENT_MOVEMENT_KINDS)[number];

/* -------------------------------------------------------------------------- */
/* 値域（DB の CHECK 制約と同じ数値）                                          */
/* -------------------------------------------------------------------------- */

/** 実装仕様書 5.6節「冪等キー（8〜200文字）」。 */
export const SUPPLEMENT_IDEMPOTENCY_KEY_MIN = 8;
export const SUPPLEMENT_IDEMPOTENCY_KEY_MAX = 200;

/** 服用量・既定量・予定量の上限。 */
export const SUPPLEMENT_AMOUNT_MAX = 100_000;

/** 在庫ロットの数量、容器あたり量、低在庫しきい値の上限。 */
export const SUPPLEMENT_QUANTITY_MAX = 1_000_000;

/** `numeric(14, 4)` に合わせ、小数第4位までに制限する（暗黙の丸めを起こさない）。 */
export const SUPPLEMENT_AMOUNT_DECIMALS = 4;

/** 期限接近ロットの既定の判定幅（日）。`supplement_summary()` の既定値と揃える。 */
export const SUPPLEMENT_EXPIRING_WITHIN_DAYS_DEFAULT = 30;

/* -------------------------------------------------------------------------- */
/* 在庫の計算                                                                  */
/* -------------------------------------------------------------------------- */

/** 在庫ロットのうち、残量の計算に使う部分。 */
export type SupplementLotLike = {
  readonly productId: string;
  readonly remainingQuantity: number;
  readonly expiresOn: string | null;
};

/**
 * 商品ごとの残量合計。低在庫の判定と画面表示に使う。
 * サーバーの応答（`lots`）からフロントでも同じ値を出せるよう、ここに置く。
 */
export function sumRemainingByProduct(
  lots: readonly SupplementLotLike[],
): ReadonlyMap<string, number> {
  const totals = new Map<string, number>();
  for (const lot of lots) {
    totals.set(lot.productId, (totals.get(lot.productId) ?? 0) + lot.remainingQuantity);
  }
  return totals;
}

/**
 * 低在庫かどうか（実装仕様書 5.6節「低在庫しきい値」「低在庫商品数」）。
 *
 * しきい値が未設定の商品は判定しない（`false`）。
 * 判定は `残量合計 <= しきい値`。DB の `supplement_summary()` と同じ式。
 */
export function isLowStock(remainingTotal: number, lowStockThreshold: number | null): boolean {
  return lowStockThreshold !== null && remainingTotal <= lowStockThreshold;
}

/**
 * 期限接近かどうか（実装仕様書 5.6節「期限接近ロット数」）。
 *
 * 残量が 0 のロットは数えない（使い切ったロットの期限は警告する意味がない）。
 * 既に期限切れのロットも「接近」に含める（画面で強調すべき対象なので外さない）。
 * `reference` / `expiresOn` はどちらも `YYYY-MM-DD` のローカル日で比較する。
 */
export function isExpiringSoon(
  lot: Pick<SupplementLotLike, "remainingQuantity" | "expiresOn">,
  referenceDate: string,
  withinDays: number = SUPPLEMENT_EXPIRING_WITHIN_DAYS_DEFAULT,
): boolean {
  if (lot.remainingQuantity <= 0 || lot.expiresOn === null) {
    return false;
  }

  const reference = Date.parse(`${referenceDate}T00:00:00Z`);
  const expires = Date.parse(`${lot.expiresOn}T00:00:00Z`);
  if (Number.isNaN(reference) || Number.isNaN(expires)) {
    return false;
  }

  const limit = reference + withinDays * 24 * 60 * 60 * 1000;
  return expires <= limit;
}

/**
 * FEFO（First-Expired-First-Out）の並び順。
 *
 * **DB の `record_supplement_intake()` が使う `ORDER BY` と同じ順序**
 * （migration 20260915000400）。フロントが「次はどのロットから減る見込みか」を
 * 表示するときに、サーバーと違う順を見せないためにここへ写す。
 *
 *   1. 使用期限が近い順（未設定は最後）
 *   2. 開封済みを先に（未開封は最後）
 *   3. 先に買ったものから（未設定は最後）
 *   4. 登録が古い順 → id 順（完全な決定性のための最終タイブレーク）
 *
 * 破壊的ではないソート（新しい配列を返す）。
 */
export type SupplementFefoLot = {
  readonly id: string;
  readonly expiresOn: string | null;
  readonly openedOn: string | null;
  readonly purchasedOn: string | null;
  readonly createdAt: string;
};

const nullsLast = (a: string | null, b: string | null): number => {
  if (a === b) {
    return 0;
  }
  if (a === null) {
    return 1;
  }
  if (b === null) {
    return -1;
  }
  return a < b ? -1 : 1;
};

export function sortLotsByFefo<T extends SupplementFefoLot>(lots: readonly T[]): T[] {
  return [...lots].sort(
    (a, b) =>
      nullsLast(a.expiresOn, b.expiresOn) ||
      nullsLast(a.openedOn, b.openedOn) ||
      nullsLast(a.purchasedOn, b.purchasedOn) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.id.localeCompare(b.id),
  );
}

/**
 * FEFO 消費の見積もり（画面のプレビュー用）。
 *
 * サーバーは同じ順序で実際に引く。**在庫不足かどうかの判定はサーバーが正**で、
 * ここでの結果は送信前の警告表示にだけ使う（送信までの間に別端末が消費しうる）。
 */
export type SupplementFefoPlanStep = {
  readonly lotId: string;
  readonly quantity: number;
};

export type SupplementFefoPlan = {
  readonly steps: readonly SupplementFefoPlanStep[];
  /** 在庫が足りなかった分。0 より大きければサーバーは 409 で拒否する。 */
  readonly shortfall: number;
};

export function planFefoConsumption(
  lots: readonly (SupplementFefoLot & { readonly remainingQuantity: number })[],
  quantity: number,
): SupplementFefoPlan {
  const steps: SupplementFefoPlanStep[] = [];
  let outstanding = quantity;

  for (const lot of sortLotsByFefo(lots)) {
    if (outstanding <= 0) {
      break;
    }
    if (lot.remainingQuantity <= 0) {
      continue;
    }
    const take = Math.min(lot.remainingQuantity, outstanding);
    steps.push({ lotId: lot.id, quantity: take });
    outstanding -= take;
  }

  return { steps, shortfall: outstanding > 0 ? outstanding : 0 };
}

/**
 * 名称の正規化（実装仕様書 5.6節「名称正規化…の重複を禁止する」）。
 *
 * DB の `supplement_normalized_name()` と同じ手順
 * （NFKC → 空白畳み込み → trim → 小文字化）。フロントが送信前に
 * 「その名前は既にある」と気づけるようにするためのもので、
 * **重複の最終判定は DB の一意制約**（`supplement_products_owner_name_key`）。
 */
export function normalizeSupplementName(name: string): string {
  return name.normalize("NFKC").replace(/\s+/gu, " ").trim().toLowerCase();
}
