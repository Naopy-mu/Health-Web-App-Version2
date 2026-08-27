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
