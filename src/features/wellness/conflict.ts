/**
 * 409（競合）のあとに対象行を特定するためのクエリ組み立て
 * （実装仕様書 5.5節 / 6.4節、`docs/api/wellness.md` 1.7節）。
 *
 * ## なぜ専用のモジュールがあるのか
 *
 * Phase 3b（身体測定フロントエンド）では「409 のあとに `limit` 付きの一覧を
 * 取り直すだけ」では対象行を見失う不具合が繰り返し見つかった。対処として
 * 「編集開始時の永続値（記録日時・種別）で絞り込む」方法を採ったが、これにも
 * 穴がある。**競合した側の更新がその記録日時・種別そのものを変更していた**場合、
 * 絞り込みは0件になり「削除された」と誤判定してしまう（行はまだ存在する）。
 *
 * 対象特定は**行の主キー（`id`）で行うのが正しい**。`id` は行の生存期間中ずっと
 * 変わらないので、
 *
 *   - 1件返る → それが最新の状態。`rowVersion` を取り直して再試行できる
 *   - 0件返る → **本当に削除された**（またはもう所有していない）
 *
 * という判定がそのまま成立する。記録日時・種別による絞り込みは、
 * **`id` をまだ持っていない新規作成の重複競合**でだけ使う後退手段にする。
 *
 * サーバー／クライアント双方から読み込むため、秘密値やサーバー専用の依存を
 * 持ち込まないこと。
 */

import type { SleepKind } from "./units";

/**
 * 対象特定の相手。`id` は**編集開始時にサーバーから受け取った永続値**を渡す
 * （送信値ではない。利用者が日時や種別を編集していても `id` は変わらない）。
 *
 * 新規作成の重複競合（`WELLNESS_DUPLICATE_CONFLICT`）では `id` がまだ無いので
 * 省略する。そのときだけ記録日時・種別による絞り込みへ後退する。
 */
export type WellnessConflictTarget =
  | {
      readonly resource: "sleep";
      readonly id?: string;
      /** 編集開始時の永続値。`id` が無いときの後退手段に使う。 */
      readonly sleepKind: SleepKind;
      readonly sleepAt: string;
    }
  | {
      readonly resource: "hydration";
      readonly id?: string;
      readonly beverageTypeId: string;
      readonly recordedAt: string;
    }
  | {
      readonly resource: "condition";
      readonly id?: string;
      readonly recordedAt: string;
    };

/** 対象特定に使った手段。0件だったときの解釈が手段によって変わる。 */
export type WellnessRefetchStrategy =
  /** 主キーで直接引いた。0件は「本当に削除された」を意味する。 */
  | "id"
  /**
   * 記録日時・種別で引いた。0件は「削除された」**とは限らない**
   * （競合した側がその日時・種別を変更しただけかもしれない）。
   */
  | "identifier";

export type WellnessRefetchQuery = {
  readonly strategy: WellnessRefetchStrategy;
  readonly params: URLSearchParams;
};

/**
 * `GET /api/wellness` へ投げる対象特定クエリを組み立てる。
 * `id` があれば必ず主キーの1件取得を選ぶ。
 */
export function buildWellnessRefetchQuery(target: WellnessConflictTarget): WellnessRefetchQuery {
  if (target.id !== undefined) {
    // 一覧の絞り込みとは併用できない（併用すると API が 400 を返す）。
    return {
      strategy: "id",
      params: new URLSearchParams({ resource: target.resource, id: target.id }),
    };
  }

  if (target.resource === "sleep") {
    return {
      strategy: "identifier",
      params: new URLSearchParams({
        resource: "sleep",
        sleepKind: target.sleepKind,
        from: target.sleepAt,
        to: target.sleepAt,
        limit: "1",
      }),
    };
  }

  if (target.resource === "hydration") {
    return {
      strategy: "identifier",
      params: new URLSearchParams({
        resource: "hydration",
        beverageTypeId: target.beverageTypeId,
        from: target.recordedAt,
        to: target.recordedAt,
        limit: "1",
      }),
    };
  }

  return {
    strategy: "identifier",
    params: new URLSearchParams({
      resource: "condition",
      from: target.recordedAt,
      to: target.recordedAt,
      limit: "1",
    }),
  };
}

/**
 * 対象特定の結果をどう扱うかを決める。
 *
 * `id` で引いた0件だけを「削除された」と断定する。記録日時・種別で引いた0件は
 * 断定できないので、一覧の取り直しへ倒す（誤って編集内容を捨てさせない）。
 */
export type WellnessRefetchOutcome<Entry> =
  | { readonly kind: "found"; readonly entry: Entry }
  | { readonly kind: "deleted" }
  | { readonly kind: "unresolved" };

export function interpretWellnessRefetch<Entry>(
  strategy: WellnessRefetchStrategy,
  entries: readonly Entry[],
): WellnessRefetchOutcome<Entry> {
  const entry = entries[0];
  if (entry !== undefined) {
    return { kind: "found", entry };
  }
  return strategy === "id" ? { kind: "deleted" } : { kind: "unresolved" };
}
