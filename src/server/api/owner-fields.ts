import "server-only";

/**
 * リクエストボディへの所有者ID持ち込みを拒否する共通検査（実装仕様書 3.2節 / 9.2節）。
 *
 * > 所有者IDは**必ず検証済みサーバーセッションから導出**し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。
 *
 * `.strict()` でも未知フィールドとして落ちるが、所有者IDの持ち込みは
 * 「たまたま未知だった」ではなく**明示的に禁じられている**入力なので、
 * 専用の判定と文言を用意して意図を残す（`src/server/account/delete-request.ts`
 * が Phase 2 で同じ考え方を導入した）。
 *
 * こちらは機能APIから使う汎用版で、ネストしたオブジェクト・配列も走査する。
 * `id`（行の主キー）は更新・削除で正当に必要になるため**含めない**。
 * 所有者の詐称に使えるのは所有者を名指しするキーだけであり、`id` は
 * 所有者スコープの WHERE 句（`owner_id = <session uid>`）を素通りできない。
 */

import { invalidRequest } from "./errors";
import type { GuardResult } from "./guards";

/** 拒否する所有者関連フィールド名。 */
export const REJECTED_OWNER_FIELDS = [
  "owner_id",
  "ownerId",
  "user_id",
  "userId",
  "owner",
  "uid",
  "sub",
] as const;

/** 走査するネストの深さの上限（循環・深いネストによる走査の暴走を防ぐ）。 */
const MAX_SCAN_DEPTH = 8;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** ボディのどこか（ネストを含む）に所有者関連フィールドがあるか。 */
export function containsOwnerField(value: unknown, depth = 0): boolean {
  if (depth > MAX_SCAN_DEPTH) {
    return false;
  }

  if (Array.isArray(value)) {
    return value.some((item) => containsOwnerField(item, depth + 1));
  }

  if (!isPlainObject(value)) {
    return false;
  }

  if (REJECTED_OWNER_FIELDS.some((field) => Object.hasOwn(value, field))) {
    return true;
  }

  return Object.values(value).some((item) => containsOwnerField(item, depth + 1));
}

/**
 * 所有者関連フィールドを含むボディを 400 で弾く。
 * 実装仕様書 9.2節に従い、文言に受け取った値そのものを含めない。
 */
export function rejectOwnerFields(body: unknown): GuardResult<null> {
  if (containsOwnerField(body)) {
    return {
      ok: false,
      response: invalidRequest(
        "リクエストボディに所有者ID（owner_id / user_id など）を含めることはできません。対象は認証済みセッションから決まります。",
      ),
    };
  }

  return { ok: true, value: null };
}
