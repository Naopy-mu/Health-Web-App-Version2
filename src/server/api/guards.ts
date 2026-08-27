import "server-only";

/**
 * 状態変更 Route Handler の共通境界（実装仕様書 7章 / 9.2節）。
 *
 * > すべてのRoute Handlerは、状態変更時に **same-origin検証** と
 * > **`Content-Type: application/json` の要求**、**リクエストボディ64KiB上限**、
 * > `Cache-Control: no-store` の応答ヘッダーを適用する。
 * > 所有者は常に検証済みセッションから導出する。
 *
 * 所有者の導出は `session.ts` の `requireActiveUser()` が担当する。
 * このモジュールはリクエストの形だけを検査し、認証には触れない。
 */

import { getTrustedAppOrigin } from "@/lib/app-origin";

import { jsonRequired, invalidRequest, payloadTooLarge, sameOriginRequired } from "./errors";

/** 実装仕様書 7章「リクエストボディ64KiB上限」。 */
export const MAX_REQUEST_BODY_BYTES = 64 * 1024;

/**
 * same-origin 検証。
 *
 * - 比較対象のオリジンは `NEXT_PUBLIC_APP_URL`（実装仕様書 13.1節）**のみ**から採る。
 *   未設定なら「何と比べるべきか分からない」ため常に拒否する＝フェイルクローズ。
 *   以前は `X-Forwarded-Host` / `X-Forwarded-Proto` へフォールバックしていたが、
 *   これらは詐称されうるため、攻撃者が `Origin` と揃えるだけで検査を素通りできた。
 * - `Origin` があればアプリのオリジンと完全一致を要求する。
 * - `Origin` が無い場合（同一オリジンのGET/HEADナビゲーションではブラウザが
 *   送らない）は `Sec-Fetch-Site: same-origin` を要求する。
 * - どちらも無いリクエスト（curl等）は拒否する＝フェイルクローズ。
 */
export function isSameOriginRequest(request: Request): boolean {
  const expectedOrigin = getTrustedAppOrigin();
  if (expectedOrigin === null) {
    return false;
  }

  const origin = request.headers.get("origin");

  if (origin !== null) {
    return origin === expectedOrigin;
  }

  const secFetchSite = request.headers.get("sec-fetch-site");
  if (secFetchSite !== null) {
    return secFetchSite === "same-origin";
  }

  return false;
}

/** `Content-Type` が `application/json`（charset付きも可）か。 */
export function isJsonContentType(request: Request): boolean {
  const contentType = request.headers.get("content-type");
  if (!contentType) {
    return false;
  }

  const mediaType = contentType.split(";")[0]?.trim().toLowerCase();
  return mediaType === "application/json";
}

/**
 * `Content-Length` による事前判定。宣言が無い（チャンク転送）場合は `false` を
 * 返し、実バイト数での判定へ委ねる。
 */
export function exceedsDeclaredBodyLimit(request: Request): boolean {
  const contentLength = request.headers.get("content-length");
  if (contentLength === null) {
    return false;
  }

  const declared = Number(contentLength);
  return Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES;
}

export type GuardFailure = { readonly ok: false; readonly response: Response };
export type GuardSuccess<T> = { readonly ok: true; readonly value: T };
export type GuardResult<T> = GuardSuccess<T> | GuardFailure;

/**
 * 状態変更リクエストの入口検査。ボディは読まない
 * （GET のデータ出力など、ボディを持たない経路からも使うため）。
 */
export function guardMutationRequest(
  request: Request,
  options: { requireJsonBody?: boolean } = {},
): GuardResult<null> {
  if (!isSameOriginRequest(request)) {
    return { ok: false, response: sameOriginRequired() };
  }

  if (options.requireJsonBody !== false && !isJsonContentType(request)) {
    return { ok: false, response: jsonRequired() };
  }

  if (exceedsDeclaredBodyLimit(request)) {
    return { ok: false, response: payloadTooLarge() };
  }

  return { ok: true, value: null };
}

/**
 * ボディを64KiB上限で読み、JSONとして解釈する。
 *
 * `Content-Length` を信用せず、実際に読み込んだバイト数でも上限を確認する
 * （チャンク転送や偽装されたヘッダーへの対処）。
 */
export async function readJsonBody(request: Request): Promise<GuardResult<unknown>> {
  if (exceedsDeclaredBodyLimit(request)) {
    return { ok: false, response: payloadTooLarge() };
  }

  let raw: ArrayBuffer;
  try {
    raw = await request.arrayBuffer();
  } catch {
    return { ok: false, response: invalidRequest("リクエストの読み取りに失敗しました。") };
  }

  if (raw.byteLength > MAX_REQUEST_BODY_BYTES) {
    return { ok: false, response: payloadTooLarge() };
  }

  if (raw.byteLength === 0) {
    return { ok: true, value: undefined };
  }

  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: invalidRequest("JSONとして解釈できません。") };
  }
}
