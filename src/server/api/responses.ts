import "server-only";

/**
 * 成功応答の共通形（実装仕様書 7章）。
 *
 * エラーが `{ error: { code, message } }` なのに対し、成功は `{ data: ... }` で
 * 包む。トップレベルに配列や裸の値を置かないことで、後からページング情報などの
 * 兄弟フィールドを足しても契約が壊れない。
 *
 * > `Cache-Control: no-store` の応答ヘッダーを適用する。（実装仕様書 7章）
 *
 * 認証済み利用者の健康データを共有キャッシュへ載せないため、
 * 成功応答にも必ず `no-store` を付ける。
 */

import { NextResponse } from "next/server";

import { NO_STORE_HEADERS } from "./errors";

export function jsonData<T>(data: T, status = 200): NextResponse {
  return NextResponse.json({ data }, { status, headers: NO_STORE_HEADERS });
}
