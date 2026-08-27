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
  /** 400: 単位が測定種別の単位制約に合わない（実装仕様書 5.3節）。 */
  MEASUREMENT_UNIT_NOT_ALLOWED: "MEASUREMENT_UNIT_NOT_ALLOWED",
  /** 404: 測定種別が所有者スコープに見つからない（実装仕様書 5.3節）。 */
  MEASUREMENT_TYPE_NOT_FOUND: "MEASUREMENT_TYPE_NOT_FOUND",
  /** 400: アーカイブ済みの測定種別へ新規登録しようとした（実装仕様書 5.3節）。 */
  MEASUREMENT_TYPE_ARCHIVED: "MEASUREMENT_TYPE_ARCHIVED",
  /** 400: 既定カタログで予約された項目キーをカスタム種別に使おうとした（実装仕様書 5.3節）。 */
  MEASUREMENT_TYPE_KEY_RESERVED: "MEASUREMENT_TYPE_KEY_RESERVED",
  /** 409: 測定記録の版番号不一致、または対象が存在しない（実装仕様書 6.4節）。 */
  MEASUREMENT_CONFLICT: "MEASUREMENT_CONFLICT",
  /** 409: 同一の所有者・種別・日時の重複登録（実装仕様書 5.3節）。 */
  MEASUREMENT_DUPLICATE_CONFLICT: "MEASUREMENT_DUPLICATE_CONFLICT",
  /** 409: 測定種別の項目キー重複、または版番号不一致（実装仕様書 5.3節）。 */
  MEASUREMENT_TYPE_CONFLICT: "MEASUREMENT_TYPE_CONFLICT",
  /** 409: 未達成の測定目標が既にある、または版番号不一致（実装仕様書 5.3節）。 */
  MEASUREMENT_GOAL_CONFLICT: "MEASUREMENT_GOAL_CONFLICT",
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

/* 身体測定（実装仕様書 5.3節）。詳細は docs/api/measurements.md のエラーコード一覧。 */

export const measurementUnitNotAllowed = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_UNIT_NOT_ALLOWED,
    "この測定種別では指定した単位を使用できません。",
    400,
  );

export const measurementTypeNotFound = () =>
  apiError(API_ERROR_CODES.MEASUREMENT_TYPE_NOT_FOUND, "測定種別が見つかりません。", 404);

/**
 * 実装仕様書 5.3節:
 * > アーカイブ済み種別に対する新規の測定記録・目標登録は拒否する。
 */
export const measurementTypeArchived = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_TYPE_ARCHIVED,
    "アーカイブ済みの測定種別には新しく登録できません。アーカイブを解除してからお試しください。",
    400,
  );

/**
 * 実装仕様書 5.3節: 既定カタログのキーは既定種別（`is_default=true`）専用。
 * カスタム種別が同じキーを名乗ると既定種別の偽装になるため拒否する。
 */
export const measurementTypeKeyReserved = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_TYPE_KEY_RESERVED,
    "この項目キーは既定の測定種別で予約されています。別のキーを指定してください。",
    400,
  );

/**
 * 実装仕様書 6.4節 / docs/database/table-conventions.md 3.1節:
 * 「行が存在しない場合と版番号が古い場合を区別せず 409 にする」。
 * 他利用者の行の存在有無を漏らさないため、文言でも区別しない。
 */
export const measurementConflict = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_CONFLICT,
    "測定記録が他の操作で更新されています。最新の内容を取得してからやり直してください。",
    409,
  );

export const measurementDuplicateConflict = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_DUPLICATE_CONFLICT,
    "同じ測定種別・日時の記録が既に存在します。",
    409,
  );

/**
 * 項目キーの重複（作成）と版番号不一致・対象なし（アーカイブ更新）の双方で使う。
 * 実装仕様書 6.4節に従い、行の不在と版番号違いは文言でも区別しない。
 */
export const measurementTypeConflict = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_TYPE_CONFLICT,
    "測定種別を保存できませんでした。同じ項目キーの種別が既にあるか、他の操作で更新されています。",
    409,
  );

export const measurementGoalConflict = () =>
  apiError(
    API_ERROR_CODES.MEASUREMENT_GOAL_CONFLICT,
    "この測定種別には未達成の目標が既に存在します。既存の目標を更新してください。",
    409,
  );
