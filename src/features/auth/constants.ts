/**
 * 認証まわりの定数（実装仕様書 5.1節）。
 */

/**
 * Googleログインで要求するスコープ。
 *
 * > Googleログインは認証に必要な**最小スコープのみ**を要求し、
 * > **Google Calendarの権限同意とは完全に分離**する。
 *
 * ここに Calendar 系スコープ（`https://www.googleapis.com/auth/calendar*`）を
 * 決して追加しないこと。Calendar連携は `/api/calendar/google/connect` が
 * 独自のOAuth（PKCE・別トークン保管）で行う別スコープの機能であり、
 * ログイン時の同意画面に混ぜてはならない（実装仕様書 5.11節）。
 */
export const GOOGLE_SIGN_IN_SCOPES = "openid email profile";

/** メール確認・コールバックのRoute Handler（実装仕様書 5.1節・7章）。 */
export const AUTH_CALLBACK_PATH = "/auth/callback";
export const AUTH_CONFIRM_PATH = "/auth/confirm";

/** パスワード再設定リンクの着地先（実装仕様書 4章）。 */
export const UPDATE_PASSWORD_PATH = "/auth/update-password";

/**
 * 認証フローの失敗理由（実装仕様書 5.1節 / 3.3節）。
 *
 * `/auth/callback`・`/auth/confirm`・プロキシ（`src/lib/supabase/proxy.ts`）が
 * `/auth?error=<コード>` の形で渡し、ログイン画面が文言へ変換して表示する。
 *
 * コードは固定の列挙にとどめ、**入力値・トークン・メールアドレスなどを
 * クエリへ載せない**（実装仕様書 9.2節）。
 */
export const AUTH_ERROR_MESSAGES = {
  /** Supabase未設定（実装仕様書 3.3節）。 */
  service_unavailable: "アカウント機能は現在利用できません。デモモードをご利用ください。",
  /** `/auth/callback` に `code` が無い（リンクの欠損・直接アクセス）。 */
  missing_code: "ログイン用リンクが正しくありません。もう一度お試しください。",
  /** コード交換に失敗した（期限切れ・使用済み・プロバイダー側の拒否）。 */
  exchange_failed:
    "ログインを完了できませんでした。リンクの有効期限が切れているか、すでに使用されています。",
  /** `/auth/confirm` の `token_hash` / `type` が欠けている、または未知の種別。 */
  invalid_link: "メールのリンクが正しくありません。もう一度お試しください。",
  /** `verifyOtp()` が失敗した（期限切れ・使用済みリンク）。 */
  verification_failed:
    "リンクを確認できませんでした。有効期限が切れているか、すでに使用されています。もう一度メールを送信してください。",
  /** 実装仕様書 5.1節: `users.status` が active 以外。 */
  account_inactive:
    "アカウントが現在利用できない状態です。処理が完了するまでお待ちいただくか、サポートへお問い合わせください。",
} as const;

export type AuthErrorCode = keyof typeof AUTH_ERROR_MESSAGES;

const AUTH_ERROR_CODES = Object.keys(AUTH_ERROR_MESSAGES) as readonly AuthErrorCode[];

/** 既知のエラーコードなら文言を返す。未知・型違いは `null`（＝何も表示しない）。 */
export function authErrorMessage(value: unknown): string | null {
  return typeof value === "string" && (AUTH_ERROR_CODES as readonly string[]).includes(value)
    ? AUTH_ERROR_MESSAGES[value as AuthErrorCode]
    : null;
}
