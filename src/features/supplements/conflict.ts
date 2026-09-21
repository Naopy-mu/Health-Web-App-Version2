/**
 * 409（競合）のあとに対象行を特定するためのクエリ組み立て
 * （実装仕様書 5.6節 / 6.4節、`docs/api/supplements.md` 1.7節）。
 *
 * ## なぜ専用のモジュールがあるのか
 *
 * Phase 3b（身体測定フロントエンド）では「409 のあとに `limit` 付きの一覧を
 * 取り直すだけ」では対象行を見失う不具合が繰り返し見つかった。対処として
 * 「編集開始時の永続値（日時・種別）で絞り込む」方法を採ったが、これにも穴がある。
 * **競合した側の更新がその日時・種別そのものを変更していた**場合、絞り込みは
 * 0件になり「削除された」と誤判定してしまう（行はまだ存在する）。
 *
 * 対象特定は**行の主キー（`id`）で行うのが正しい**。`id` は行の生存期間中ずっと
 * 変わらないので、
 *
 *   - 1件返る → それが最新の状態。`rowVersion` を取り直して再試行できる
 *   - 0件返る → **本当に削除された**（またはもう所有していない）
 *
 * という判定がそのまま成立する。識別子による絞り込みは、
 * **`id` をまだ持っていない新規作成の重複競合**でだけ使う後退手段にする。
 *
 * ## サプリメント固有の事情
 *
 * - **商品**は `id` で引く必要すらない。どの `GET /api/supplements` の応答にも
 *   `products` として全件入るので、その中から `id` で探せばよい（1.7節）。
 * - **服用記録**は更新しないので、409 は取消（`void_intake`）でしか起きない。
 *   取消対象は必ず `id` を持っている（一覧から選ぶ操作なので）。
 * - **在庫ロット**の新規作成が重複で 409 になるのは `lotCode` を指定したときだけ。
 *   そのときは `productId` で絞って `lotCode` を突き合わせる（API は `lotCode`
 *   での絞り込みを持たないため、1ページ読んでクライアント側で探す）。
 *
 * サーバー／クライアント双方から読み込むため、秘密値やサーバー専用の依存を
 * 持ち込まないこと。
 */

import type { SupplementScheduleKind } from "./units";

/**
 * 対象特定の相手。`id` は**編集開始時にサーバーから受け取った永続値**を渡す
 * （送信値ではない。利用者が日時や商品を編集していても `id` は変わらない）。
 *
 * 新規作成の重複競合（`SUPPLEMENT_DUPLICATE_CONFLICT`）では `id` がまだ無いので
 * 省略する。そのときだけ識別子による絞り込みへ後退する。
 */
export type SupplementConflictTarget =
  | {
      readonly resource: "schedule";
      readonly id?: string;
      /** 編集開始時の永続値。`id` が無いときの後退手段に使う。 */
      readonly productId: string;
      readonly scheduleKind: SupplementScheduleKind;
      readonly startDate: string;
    }
  | {
      readonly resource: "lot";
      readonly id?: string;
      readonly productId: string;
      /** `null` のロットは重複しえないので、後退手段は使えない。 */
      readonly lotCode: string | null;
    }
  | {
      readonly resource: "intake";
      /** 服用記録は一覧から選んで取り消すので、`id` は必ずある。 */
      readonly id: string;
    };

/** 対象特定に使った手段。0件だったときの解釈が手段によって変わる。 */
export type SupplementRefetchStrategy =
  /** 主キーで直接引いた。0件は「本当に削除された」を意味する。 */
  | "id"
  /**
   * 識別子（商品・種別・開始日など）で引いた。0件は「削除された」**とは限らない**
   * （競合した側がその識別子を変更しただけかもしれない）。
   */
  | "identifier";

export type SupplementRefetchQuery = {
  readonly strategy: SupplementRefetchStrategy;
  readonly params: URLSearchParams;
};

/**
 * `GET /api/supplements` へ投げる対象特定クエリを組み立てる。
 * `id` があれば必ず主キーの1件取得を選ぶ。
 *
 * 後退手段では `productId` で絞ったうえで**1ページ読み**、返ってきた
 * `entries` から識別子が一致する行を呼び出し側で探す
 * （API は `startDate` / `lotCode` での絞り込みを持たない。
 * 一意制約に対応する絞り込みを増やすより、`id` を持たせる設計に倒す方針）。
 */
export function buildSupplementRefetchQuery(
  target: SupplementConflictTarget,
): SupplementRefetchQuery {
  if (target.id !== undefined) {
    // 一覧の絞り込みとは併用できない（併用すると API が 400 を返す）。
    return {
      strategy: "id",
      params: new URLSearchParams({ resource: target.resource, id: target.id }),
    };
  }

  // 服用記録は `id` を必ず持つ（型の上でも必須）ので、ここへは来ない。
  // 型の網羅性のために残しておき、万一届いたら主キー取得を選ぶ。
  if (target.resource === "intake") {
    return {
      strategy: "id",
      params: new URLSearchParams({ resource: "intake", id: target.id }),
    };
  }

  return {
    strategy: "identifier",
    params: new URLSearchParams({
      resource: target.resource,
      productId: target.productId,
      limit: "500",
    }),
  };
}

/**
 * 後退手段で取得した一覧から、識別子が一致する行を探す述語。
 * `buildSupplementRefetchQuery` が `"identifier"` を返したときに使う。
 */
export function matchesSupplementIdentifier(
  target: SupplementConflictTarget,
  entry: Record<string, unknown>,
): boolean {
  if (target.resource === "schedule") {
    return entry["scheduleKind"] === target.scheduleKind && entry["startDate"] === target.startDate;
  }
  if (target.resource === "lot") {
    return target.lotCode !== null && entry["lotCode"] === target.lotCode;
  }
  return false;
}

/**
 * 対象特定の結果をどう扱うかを決める。
 *
 * `id` で引いた0件だけを「削除された」と断定する。識別子で引いた0件は
 * 断定できないので、一覧の取り直しへ倒す（誤って編集内容を捨てさせない）。
 */
export type SupplementRefetchOutcome<Entry> =
  | { readonly kind: "found"; readonly entry: Entry }
  | { readonly kind: "deleted" }
  | { readonly kind: "unresolved" };

export function interpretSupplementRefetch<Entry extends Record<string, unknown>>(
  strategy: SupplementRefetchStrategy,
  entries: readonly Entry[],
  target?: SupplementConflictTarget,
): SupplementRefetchOutcome<Entry> {
  if (strategy === "id") {
    const entry = entries[0];
    return entry === undefined ? { kind: "deleted" } : { kind: "found", entry };
  }

  const matched =
    target === undefined
      ? undefined
      : entries.find((entry) => matchesSupplementIdentifier(target, entry));

  return matched === undefined ? { kind: "unresolved" } : { kind: "found", entry: matched };
}
