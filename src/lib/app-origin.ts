/**
 * アプリのオリジン解決（実装仕様書 5.1節「オープンリダイレクト対策」/ 7章
 * 「same-origin検証」で共通に使う）。
 *
 * 優先順位:
 *   1. `NEXT_PUBLIC_APP_URL`（配置先で明示されたオリジン。実装仕様書 13.1節）
 *   2. リバースプロキシが付与する `X-Forwarded-Host` / `X-Forwarded-Proto`
 *   3. リクエストURL自身のオリジン
 *
 * 2 を採用するのはVercel等のプロキシ配下で `request.url` が内部ホストになる
 * ためだが、ヘッダーは詐称されうるので、本番では 1 を設定して固定すること。
 */

import { getConfiguredAppUrl } from "./supabase/config";

const firstHeaderValue = (value: string | null): string | null => {
  const first = value?.split(",")[0]?.trim();
  return first ? first : null;
};

export function resolveAppOrigin(request: Request): string {
  const configured = getConfiguredAppUrl();
  if (configured) {
    return configured;
  }

  const requestUrl = new URL(request.url);
  const forwardedHost = firstHeaderValue(request.headers.get("x-forwarded-host"));
  const forwardedProto = firstHeaderValue(request.headers.get("x-forwarded-proto"));

  if (forwardedHost) {
    const protocol = forwardedProto ?? requestUrl.protocol.replace(":", "");
    try {
      return new URL(`${protocol}://${forwardedHost}`).origin;
    } catch {
      // 詐称・破損したヘッダーはリクエストURLへフォールバックする。
    }
  }

  return requestUrl.origin;
}
