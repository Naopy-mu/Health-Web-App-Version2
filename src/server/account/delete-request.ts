import "server-only";

/**
 * 削除系APIのリクエストボディ検証（実装仕様書 3.2節 / 5.1節 / 9.2節）。
 *
 * > 所有者IDは**必ず検証済みサーバーセッションから導出**し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。（3.2節）
 *
 * > 全入力をZodで検証し（`.strict()` で未知フィールドを拒否）……（9.2節）
 *
 * `DELETE /api/account` と `DELETE /api/account/data` は本体が未実装（501）だが、
 * **検証を素通りして 501 に到達させない**。骨格の段階で「所有者IDを送れば
 * 受け付ける経路がある」と誤解させないため、また本実装時に検証の追加を
 * 忘れないための土台として、ここで形を固定しておく。
 *
 * 現時点の両APIは**追加の入力を一切取らない**。空ボディ（`undefined`）と
 * 空オブジェクト `{}` のみを受け付け、それ以外はすべて 400 で落とす。
 * 将来フィールドを足す場合も、このスキーマを `.strict()` のまま拡張すること。
 */

import { z } from "zod";

import { invalidRequest } from "../api/errors";
import type { GuardResult } from "../api/guards";

/**
 * ボディに現れたら拒否する所有者関連フィールド（実装仕様書 3.2節）。
 *
 * `.strict()` だけでも未知フィールドとして落ちるが、所有者IDの持ち込みは
 * 「たまたま未知だった」ではなく**明示的に禁じられている**入力なので、
 * 専用の判定と文言を用意して意図を残す。
 */
export const REJECTED_OWNER_BODY_FIELDS = [
  "owner_id",
  "ownerId",
  "user_id",
  "userId",
  "owner",
  "uid",
  "sub",
  "id",
] as const;

/** 実装仕様書 9.2節: 未知フィールドを拒否する。現時点で受け付ける項目は無い。 */
export const accountDeleteRequestSchema = z.object({}).strict();

export type AccountDeleteRequest = z.infer<typeof accountDeleteRequestSchema>;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * 削除系APIのボディを検証する。
 *
 * - 空ボディ（`readJsonBody` が返す `undefined`）と `null` は「入力なし」とみなす。
 * - オブジェクト以外（配列・文字列・数値）は 400。
 * - 所有者関連フィールドを含むものは 400（専用の文言）。
 * - 残りは `.strict()` に通し、未知フィールドがあれば 400。
 */
export function parseAccountDeleteRequest(body: unknown): GuardResult<AccountDeleteRequest> {
  const candidate = body === undefined || body === null ? {} : body;

  if (!isPlainObject(candidate)) {
    return {
      ok: false,
      response: invalidRequest("リクエストボディはJSONオブジェクトで送信してください。"),
    };
  }

  const ownerField = REJECTED_OWNER_BODY_FIELDS.find((field) => Object.hasOwn(candidate, field));
  if (ownerField) {
    // 実装仕様書 9.2節: 文言に受け取った値そのものを含めない。
    return {
      ok: false,
      response: invalidRequest(
        "リクエストボディに所有者ID（owner_id / user_id など）を含めることはできません。対象は認証済みセッションから決まります。",
      ),
    };
  }

  const parsed = accountDeleteRequestSchema.safeParse(candidate);
  if (!parsed.success) {
    return {
      ok: false,
      response: invalidRequest("この操作は追加の入力を受け付けません。"),
    };
  }

  return { ok: true, value: parsed.data };
}
