import "server-only";

/**
 * メールリンクの `token_hash` + `type` を検証する共通処理（実装仕様書 5.1節 / 7章）。
 *
 * `/auth/confirm` の本来の担当だが、`/auth/callback` も**同じ形のリンクを
 * 受け取りうる**ため、両方から呼べるようにここへ切り出してある。
 *
 * なぜ `/auth/callback` にも来るのか（実地検証で判明。docs/known-issues.md P2-5）:
 * GoTrue はメールの宛先が **未登録** または **メール未確認** のとき、
 * `signInWithOtp()`（Magic Link）であってもテンプレートに
 * `magic_link` ではなく **`confirmation`（サインアップ確認）** を選ぶ。
 * `confirmation.html` は `{{ .RedirectTo }}&token_hash=…&type=signup` を組み立て、
 * この `RedirectTo` は Magic Link の Server Action が渡した
 * `/auth/callback?next=…` なので、**`code` を持たない `token_hash` 形式のリンクが
 * `/auth/callback` へ届く**。`code` 前提のままでは `missing_code` で行き止まりになり、
 * サインアップ済みで未確認の利用者はどのメールからもログインできなくなる。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { UPDATE_PASSWORD_PATH } from "./constants";
import { sanitizeNextPath } from "./redirect";
import { emailOtpTypeSchema } from "./schema";

/**
 * 検証結果。失敗の種別はログイン画面の文言表（`AUTH_ERROR_MESSAGES`）へ
 * 呼び出し側が対応付ける。値そのもの（トークン等）は一切持ち出さない。
 */
export type EmailOtpResult =
  | { readonly status: "verified"; readonly next: string }
  /** `token_hash` が無い、または `type` が未知。 */
  | { readonly status: "invalid" }
  /** Supabase未設定（実装仕様書 3.3節）。 */
  | { readonly status: "unavailable" }
  /** `verifyOtp()` が失敗した（期限切れ・使用済み）。 */
  | { readonly status: "failed" };

/** リンクに `token_hash` が載っているか。`/auth/callback` の分岐判定に使う。 */
export function hasEmailOtpToken(searchParams: URLSearchParams): boolean {
  return Boolean(searchParams.get("token_hash"));
}

/**
 * `token_hash` + `type` を `verifyOtp()` で検証し、着地先の `next` を返す。
 *
 * `type=recovery` は `next` の指定によらず常に `/auth/update-password` へ送る
 * （実装仕様書 4章の画面表）。それ以外は `sanitizeNextPath` を通した `next`。
 */
export async function verifyEmailOtpLink(
  searchParams: URLSearchParams,
  options: { readonly createClient?: () => Promise<SupabaseClient | null> } = {},
): Promise<EmailOtpResult> {
  const tokenHash = searchParams.get("token_hash");
  const parsedType = emailOtpTypeSchema.safeParse(searchParams.get("type"));

  if (!tokenHash || !parsedType.success) {
    return { status: "invalid" };
  }

  const createClient = options.createClient ?? createSupabaseServerClient;
  const supabase = await createClient();
  if (!supabase) {
    return { status: "unavailable" };
  }

  const { error } = await supabase.auth.verifyOtp({
    type: parsedType.data,
    token_hash: tokenHash,
  });

  if (error) {
    return { status: "failed" };
  }

  const next =
    parsedType.data === "recovery"
      ? UPDATE_PASSWORD_PATH
      : sanitizeNextPath(searchParams.get("next"));

  return { status: "verified", next };
}
