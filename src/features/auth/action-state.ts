/**
 * 認証フォームの Server Action 戻り値（実装仕様書 5.1節 / 11章）。
 *
 * クライアントコンポーネントからも読み込むため、サーバー専用の依存を
 * 持ち込まないこと。メッセージには入力値を含めない（実装仕様書 9.2節）。
 */

export type AuthActionState = {
  readonly status: "idle" | "error" | "success";
  /** 画面上部の `status-banner` に出す文言。 */
  readonly message?: string;
  /** フィールド名 → メッセージ。`form` はフォーム全体のエラー。 */
  readonly fieldErrors?: Record<string, string[]>;
};

export const IDLE_AUTH_ACTION_STATE: AuthActionState = { status: "idle" };

export const authActionError = (
  message: string,
  fieldErrors?: Record<string, string[]>,
): AuthActionState => ({ status: "error", message, fieldErrors });

export const authActionSuccess = (message: string): AuthActionState => ({
  status: "success",
  message,
});
