/**
 * アプリのオリジン解決（実装仕様書 5.1節 / 7章 / 9.2節 / 13.1節）。
 *
 * 用途が2つあり、要求される強度が異なるため関数を分けている。
 *
 * 1. `getTrustedAppOrigin()` — same-origin検査（実装仕様書 7章「状態変更APIは
 *    same-origin ... を検証する」）の比較対象。**`NEXT_PUBLIC_APP_URL` に明示された
 *    オリジンだけ**を信頼し、未設定なら `null` を返す。呼び出し側は `null` を
 *    「検査不能＝拒否」として扱う（フェイルクローズ）。
 * 2. `resolveAppOrigin(request)` / `resolveAppOriginFromHeaders(headers)` —
 *    リダイレクト先やメール内リンクの絶対URLを組み立てるための基準。
 *    設定が無ければリクエスト自身のオリジン（`Host`）へフォールバックする。
 *
 * `X-Forwarded-Host` / `X-Forwarded-Proto` は**いずれの経路でも信頼しない**。
 * これらは最前段のリバースプロキシが付け替えられる前提のヘッダーで、
 * 構成によっては攻撃者が任意の値を送り込める。以前の実装はこれを
 * same-origin検査の「正」にしていたため、`Origin: https://evil.example` と
 * `X-Forwarded-Host: evil.example` を揃えるだけで検査を素通りできた。
 *
 * 配置先（Vercel等）で `request.url` が内部ホストになる構成では、
 * 実装仕様書 13.1節の `NEXT_PUBLIC_APP_URL` を必ず設定すること。
 * 本番・ステージングでは同変数が未設定だと状態変更APIが 403 を返す。
 */

import { getConfiguredAppUrl } from "./supabase/config";

/** `Host` ヘッダーも取れない実行時（テスト等）の最終フォールバック。 */
const DEVELOPMENT_FALLBACK_ORIGIN = "http://localhost:3000";

/** ヘッダー取得だけを要求する最小インターフェース（`Headers` と `headers()` の共通部分）。 */
type HeaderReader = { get(name: string): string | null };

/** ループバックホストだけは `http`、それ以外は `https` を既定にする。 */
const schemeForHost = (host: string): string => {
  const hostname = host.split(":")[0]?.toLowerCase() ?? "";
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]"
    ? "http"
    : "https";
};

/**
 * same-origin検査で信頼できるオリジン。未設定・不正な値なら `null`。
 *
 * ここで **リクエスト由来の値へフォールバックしない**ことが本関数の要点で、
 * 「アプリのオリジン」を攻撃者が持ち込んだヘッダーで定義させないためにある。
 */
export function getTrustedAppOrigin(): string | null {
  return getConfiguredAppUrl();
}

/**
 * ヘッダーからオリジンを組み立てる（絶対URLの基準用）。
 * `NEXT_PUBLIC_APP_URL` → `Host` → 開発用の既定値、の順。
 */
export function resolveAppOriginFromHeaders(headers: HeaderReader): string {
  const configured = getTrustedAppOrigin();
  if (configured) {
    return configured;
  }

  const host = headers.get("host")?.trim();
  if (host) {
    try {
      return new URL(`${schemeForHost(host)}://${host}`).origin;
    } catch {
      // 壊れた Host ヘッダーは既定値へ落とす。
    }
  }

  return DEVELOPMENT_FALLBACK_ORIGIN;
}

/**
 * リクエストからオリジンを組み立てる（リダイレクト先の絶対URL用）。
 * `NEXT_PUBLIC_APP_URL` → `request.url` 自身のオリジン、の順。
 */
export function resolveAppOrigin(request: Request): string {
  const configured = getTrustedAppOrigin();
  if (configured) {
    return configured;
  }

  return new URL(request.url).origin;
}
