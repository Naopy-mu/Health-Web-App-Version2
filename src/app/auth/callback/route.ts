/**
 * `GET /auth/callback` — OAuth / Magic Link のコード交換（実装仕様書 5.1節 / 7章）。
 *
 * PKCEのコードをセッションへ交換し、検証済みの `next` へ送る。
 * `next` は `sanitizeNextPath` を通すため、`//evil.example` のような値は
 * `/auth/session` へ丸められる（オープンリダイレクト対策）。
 */

import { NextResponse, type NextRequest } from "next/server";

import { sanitizeNextPath } from "@/features/auth/redirect";
import { resolveAppOrigin } from "@/lib/app-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { NO_STORE_HEADERS } from "@/server/api/errors";

/** 失敗時にログイン画面で出し分けるための理由コード（値そのものは載せない）。 */
type AuthCallbackError = "service_unavailable" | "missing_code" | "exchange_failed";

function redirectToSignIn(origin: string, reason: AuthCallbackError): NextResponse {
  const url = new URL("/auth", origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, { headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = resolveAppOrigin(request);
  const requestUrl = new URL(request.url);
  const next = sanitizeNextPath(requestUrl.searchParams.get("next"));

  // プロバイダー側で拒否された場合（`error` / `error_description` が付く）。
  if (requestUrl.searchParams.get("error")) {
    return redirectToSignIn(origin, "exchange_failed");
  }

  const code = requestUrl.searchParams.get("code");
  if (!code) {
    return redirectToSignIn(origin, "missing_code");
  }

  // 実装仕様書 3.3節: Supabase未設定なら認証は成立しえない。
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return redirectToSignIn(origin, "service_unavailable");
  }

  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return redirectToSignIn(origin, "exchange_failed");
  }

  return NextResponse.redirect(new URL(next, origin), { headers: NO_STORE_HEADERS });
}
