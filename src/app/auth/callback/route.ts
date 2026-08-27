/**
 * `GET /auth/callback` — OAuth / Magic Link のコード交換（実装仕様書 4章の画面表 / 5.1節 / 7章）。
 *
 * > OAuth／Magic Link のコールバックは `/auth/callback` で処理する。
 *
 * Magic Link のメールは既定の `{{ .ConfirmationURL }}` を使うため
 * （`supabase/templates/magic_link.html`）、Supabase の `/auth/v1/verify` を
 * 経由して `?code=` 付きでここへ戻る。
 *
 * ただし **`token_hash` 形式のリンクもここへ届きうる**。GoTrue は宛先が未登録・
 * メール未確認のとき、`signInWithOtp()` でも `magic_link` ではなく
 * `confirmation`（サインアップ確認）テンプレートを選ぶため、
 * `{{ .RedirectTo }}`（= `/auth/callback?next=…`）へ `&token_hash=…&type=signup`
 * を足したリンクが送られてくる（実地検証の記録は docs/known-issues.md P2-5）。
 * その場合は `/auth/confirm` と同じ OTP 検証へ回す。`code` 前提のまま
 * `missing_code` で弾くと、サインアップ済みで未確認の利用者が
 * どのメールからもログインできなくなる。
 *
 * PKCEのコードをセッションへ交換し、検証済みの `next` へ送る。
 * `next` は `sanitizeNextPath` を通すため、`//evil.example` のような値は
 * `/auth/session` へ丸められる（オープンリダイレクト対策）。
 */

import { NextResponse, type NextRequest } from "next/server";

import type { AuthErrorCode } from "@/features/auth/constants";
import { hasEmailOtpToken, verifyEmailOtpLink } from "@/features/auth/email-otp";
import { sanitizeNextPath } from "@/features/auth/redirect";
import { resolveAppOrigin } from "@/lib/app-origin";
import { createSupabaseServerClient } from "@/lib/supabase/server";

import { NO_STORE_HEADERS } from "@/server/api/errors";

/**
 * 失敗時にログイン画面で出し分けるための理由コード（値そのものは載せない）。
 * ログイン画面の文言表（`AUTH_ERROR_MESSAGES`）と型で結び付けてある。
 */
type AuthCallbackError = Extract<
  AuthErrorCode,
  | "service_unavailable"
  | "missing_code"
  | "exchange_failed"
  | "invalid_link"
  | "verification_failed"
>;

function redirectToSignIn(origin: string, reason: AuthCallbackError): NextResponse {
  const url = new URL("/auth", origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, { headers: NO_STORE_HEADERS });
}

function redirectToNext(origin: string, next: string): NextResponse {
  return NextResponse.redirect(new URL(next, origin), { headers: NO_STORE_HEADERS });
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
    // `token_hash` 形式のメールリンク（上の説明を参照）。`/auth/confirm` と同じ検証を行う。
    if (hasEmailOtpToken(requestUrl.searchParams)) {
      const result = await verifyEmailOtpLink(requestUrl.searchParams);

      switch (result.status) {
        case "invalid":
          return redirectToSignIn(origin, "invalid_link");
        case "unavailable":
          return redirectToSignIn(origin, "service_unavailable");
        case "failed":
          return redirectToSignIn(origin, "verification_failed");
        case "verified":
          return redirectToNext(origin, result.next);
      }
    }

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

  return redirectToNext(origin, next);
}
