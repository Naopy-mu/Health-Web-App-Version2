import "server-only";

/**
 * 機能APIに共通の入力検証（実装仕様書 9.2節）。
 *
 * > 全入力をZodで検証し（`.strict()` で未知フィールドを拒否）、DB制約とRLSを
 * > 最終防衛線とする。
 *
 * 検証は次の順で行う。
 *   1. ボディがJSONオブジェクトであること（配列・文字列・数値は拒否）
 *   2. 所有者IDの持ち込みが無いこと（実装仕様書 3.2節）
 *   3. `.strict()` のスキーマに合致すること
 *
 * 失敗時の文言に**受け取った値そのものを含めない**（実装仕様書 9.2節）。
 * Zod のメッセージは自前で書いた日本語のみを使い、入力値を反映する
 * `received`/`input` は応答へ出さない。
 *
 * Phase 3a では `src/server/body-measurements/request.ts` に置いていたが、
 * Phase 4-1a（睡眠・水分・体調）でも同じ手順が要るため、機能に依らない
 * 共通層へ移した。`body-measurements/request.ts` は互換のため再エクスポートする。
 */

import type { z } from "zod";

import { invalidRequest } from "./errors";
import type { GuardResult } from "./guards";
import { rejectOwnerFields } from "./owner-fields";

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Zod の失敗から利用者向けの1行を作る。
 * 自前のメッセージ（日本語）だけを採用し、Zod 既定の英語メッセージや
 * 入力値を含みうる表現は汎用文言へ丸める。
 */
function firstSafeMessage(error: z.ZodError): string {
  const issue = error.issues[0];
  if (issue === undefined) {
    return "リクエストの内容が正しくありません。";
  }

  // 日本語のメッセージ（自前で与えたもの）だけを外へ出す。
  if (/[぀-ヿ一-鿿]/.test(issue.message)) {
    return issue.message;
  }

  const path = issue.path.filter((segment) => typeof segment === "string").join(".");
  return path === "" ? "リクエストの内容が正しくありません。" : `${path} の値が正しくありません。`;
}

/** 状態変更APIのボディを検証する。 */
export function parseRequestBody<T>(schema: z.ZodType<T>, body: unknown): GuardResult<T> {
  if (!isPlainObject(body)) {
    return {
      ok: false,
      response: invalidRequest("リクエストボディはJSONオブジェクトで送信してください。"),
    };
  }

  // 実装仕様書 3.2節: 所有者IDはセッションから導出する。ボディの持ち込みは拒否。
  const ownerCheck = rejectOwnerFields(body);
  if (!ownerCheck.ok) {
    return ownerCheck;
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, response: invalidRequest(firstSafeMessage(parsed.error)) };
  }

  return { ok: true, value: parsed.data };
}

/**
 * クエリ文字列を検証する。同じキーが複数回現れた場合は最初の値だけを使う
 * （配列としては受け取らない）。
 */
export function parseQueryParams<T>(
  schema: z.ZodType<T>,
  searchParams: URLSearchParams,
): GuardResult<T> {
  const raw: Record<string, string> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!Object.hasOwn(raw, key)) {
      raw[key] = value;
    }
  }

  const ownerCheck = rejectOwnerFields(raw);
  if (!ownerCheck.ok) {
    return ownerCheck;
  }

  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: invalidRequest(firstSafeMessage(parsed.error)) };
  }

  return { ok: true, value: parsed.data };
}
