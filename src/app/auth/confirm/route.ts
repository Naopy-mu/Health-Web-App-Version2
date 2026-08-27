/**
 * `GET /auth/confirm` — メール確認（実装仕様書 4章の画面表 / 5.1節 / 7章）。
 *
 * > メール確認は `/auth/confirm` ... で処理する。
 *
 * サインアップ確認・パスワード再設定・メールアドレス変更の `token_hash` を
 * `verifyOtp()` で検証してセッションを確立する。この方式は
 * `supabase/templates/` の各テンプレートが `{{ .TokenHash }}` 形式のリンクを
 * 組み立てることを前提とする（`supabase/config.toml` の `[auth.email.template.*]`）。
 *
 * Magic Link は実装仕様書 4章の画面表どおり `/auth/callback`（code交換）が
 * 担当する。`magiclink` を種別として受け付けたままにしてあるのは、
 * 既に送信済みのリンクや手動で `token_hash` 方式に切り替えた運用を
 * 取りこぼさないためで、既定の送信経路はここを通らない。
 *
 * 検証そのものは `@/features/auth/email-otp` に切り出してある。
 * `/auth/callback` も同じ形のリンクを受け取りうるため（同モジュールの説明を参照）、
 * 両方が同一の判定・同一の着地先を使う。
 */

import { NextResponse, type NextRequest } from "next/server";

import type { AuthErrorCode } from "@/features/auth/constants";
import { verifyEmailOtpLink } from "@/features/auth/email-otp";
import { resolveAppOrigin } from "@/lib/app-origin";

import { NO_STORE_HEADERS } from "@/server/api/errors";

/** ログイン画面の文言表（`AUTH_ERROR_MESSAGES`）と型で結び付けてある。 */
type AuthConfirmError = Extract<
  AuthErrorCode,
  "service_unavailable" | "invalid_link" | "verification_failed"
>;

function redirectToSignIn(origin: string, reason: AuthConfirmError): NextResponse {
  const url = new URL("/auth", origin);
  url.searchParams.set("error", reason);
  return NextResponse.redirect(url, { headers: NO_STORE_HEADERS });
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const origin = resolveAppOrigin(request);
  const requestUrl = new URL(request.url);

  const result = await verifyEmailOtpLink(requestUrl.searchParams);

  switch (result.status) {
    case "invalid":
      return redirectToSignIn(origin, "invalid_link");
    case "unavailable":
      return redirectToSignIn(origin, "service_unavailable");
    case "failed":
      return redirectToSignIn(origin, "verification_failed");
    case "verified":
      // 再設定リンクは常に新しいパスワードの設定画面へ着地させる（`verifyEmailOtpLink` が決める）。
      return NextResponse.redirect(new URL(result.next, origin), { headers: NO_STORE_HEADERS });
  }
}
