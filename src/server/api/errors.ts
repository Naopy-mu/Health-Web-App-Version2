import "server-only";

/**
 * API のエラー応答形式（実装仕様書 7章）。
 *
 * > エラー応答は `{ error: { code, message } }` 形式で、主なコードは
 * > `AUTHENTICATION_REQUIRED`（401）、`ACCOUNT_INACTIVE`（403）、
 * > `SAME_ORIGIN_REQUIRED`（403）、`JSON_REQUIRED`（415）、`*_CONFLICT`（409）、
 * > `ACCOUNT_SERVICE_UNAVAILABLE`（503）。
 *
 * メッセージには入力値・健康データ・秘密値を含めない（実装仕様書 9.2節）。
 */

import { NextResponse } from "next/server";

/**
 * 実装仕様書 7章: 状態変更を行うRoute Handlerは `Cache-Control: no-store` を返す。
 * 認証情報に依存する応答が共有キャッシュへ載らないようにする。
 */
export const NO_STORE_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  "Cache-Control": "no-store",
});

export const API_ERROR_CODES = {
  /** 401: 検証済みセッションが無い。 */
  AUTHENTICATION_REQUIRED: "AUTHENTICATION_REQUIRED",
  /** 403: `users.status` が active 以外（実装仕様書 5.1節）。 */
  ACCOUNT_INACTIVE: "ACCOUNT_INACTIVE",
  /** 403: Origin / Sec-Fetch-Site が同一オリジンでない。 */
  SAME_ORIGIN_REQUIRED: "SAME_ORIGIN_REQUIRED",
  /** 403: 直近の再認証が無い（実装仕様書 5.1節）。 */
  REAUTHENTICATION_REQUIRED: "REAUTHENTICATION_REQUIRED",
  /** 415: `Content-Type: application/json` でない。 */
  JSON_REQUIRED: "JSON_REQUIRED",
  /** 400: JSONとして解釈できない、またはスキーマに合致しない。 */
  INVALID_REQUEST: "INVALID_REQUEST",
  /** 413: リクエストボディが64KiBを超えた（実装仕様書 7章）。 */
  PAYLOAD_TOO_LARGE: "PAYLOAD_TOO_LARGE",
  /** 501: 後続フェーズで実装する骨格（実装仕様書 5.1節の削除フロー）。 */
  NOT_IMPLEMENTED: "NOT_IMPLEMENTED",
  /** 503: Supabase未設定（実装仕様書 3.3節）。 */
  ACCOUNT_SERVICE_UNAVAILABLE: "ACCOUNT_SERVICE_UNAVAILABLE",
} as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[keyof typeof API_ERROR_CODES];

export type ApiErrorBody = {
  readonly error: {
    readonly code: ApiErrorCode;
    readonly message: string;
  };
};

/** 実装仕様書 7章の形式でエラー応答を組み立てる。 */
export function apiError(code: ApiErrorCode, message: string, status: number): NextResponse {
  const body: ApiErrorBody = { error: { code, message } };
  return NextResponse.json(body, { status, headers: NO_STORE_HEADERS });
}

/* 以降は呼び出し側で使い回す定型のエラー。文言は利用者向けの日本語にする。 */

export const authenticationRequired = () =>
  apiError(API_ERROR_CODES.AUTHENTICATION_REQUIRED, "ログインが必要です。", 401);

export const accountInactive = () =>
  apiError(
    API_ERROR_CODES.ACCOUNT_INACTIVE,
    "アカウントが現在利用できない状態です。処理が完了するまでお待ちください。",
    403,
  );

export const sameOriginRequired = () =>
  apiError(
    API_ERROR_CODES.SAME_ORIGIN_REQUIRED,
    "同一オリジンからのリクエストのみ受け付けます。",
    403,
  );

export const reauthenticationRequired = () =>
  apiError(
    API_ERROR_CODES.REAUTHENTICATION_REQUIRED,
    "この操作には直近の再認証が必要です。もう一度ログインしてからお試しください。",
    403,
  );

export const jsonRequired = () =>
  apiError(API_ERROR_CODES.JSON_REQUIRED, "Content-Type: application/json が必要です。", 415);

export const invalidRequest = (message = "リクエストの内容が正しくありません。") =>
  apiError(API_ERROR_CODES.INVALID_REQUEST, message, 400);

export const payloadTooLarge = () =>
  apiError(API_ERROR_CODES.PAYLOAD_TOO_LARGE, "リクエストの内容が大きすぎます。", 413);

export const accountServiceUnavailable = () =>
  apiError(
    API_ERROR_CODES.ACCOUNT_SERVICE_UNAVAILABLE,
    "アカウント機能は現在利用できません。デモモードをご利用ください。",
    503,
  );

export const notImplemented = (message: string) =>
  apiError(API_ERROR_CODES.NOT_IMPLEMENTED, message, 501);
