/**
 * 認証入力のスキーマ（実装仕様書 5.1節 / 9.2節）。
 *
 * - パスワードは8文字以上256文字以内、確認用パスワードとの一致を必須とする。
 * - 実装仕様書 9.2節に従い、オブジェクトは `.strict()` で未知フィールドを拒否する。
 *
 * サーバー／クライアント双方から読み込むため、このモジュールに秘密値や
 * サーバー専用の依存を持ち込まないこと。
 */

import { z } from "zod";

/** 実装仕様書 5.1節「パスワードは8文字以上256文字以内」。 */
export const PASSWORD_MIN_LENGTH = 8;
export const PASSWORD_MAX_LENGTH = 256;

/** RFC 5321 の実務上の上限。 */
const EMAIL_MAX_LENGTH = 254;

export const emailSchema = z
  .email({ message: "メールアドレスの形式が正しくありません。" })
  .max(EMAIL_MAX_LENGTH, { message: "メールアドレスが長すぎます。" });

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH, {
    message: `パスワードは${PASSWORD_MIN_LENGTH}文字以上で入力してください。`,
  })
  .max(PASSWORD_MAX_LENGTH, {
    message: `パスワードは${PASSWORD_MAX_LENGTH}文字以内で入力してください。`,
  });

const PASSWORD_MISMATCH = {
  path: ["confirmPassword"],
  message: "確認用パスワードが一致しません。",
};

/** メール+パスワードのログイン。既存のパスワードは長さ制約を課さない。 */
export const signInSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1, { message: "パスワードを入力してください。" }),
  })
  .strict();

/** メール+パスワードのサインアップ。確認用パスワードとの一致を必須とする。 */
export const signUpSchema = z
  .object({
    email: emailSchema,
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .strict()
  .refine((value) => value.password === value.confirmPassword, PASSWORD_MISMATCH);

/** Magic Link 送信・パスワード再設定要求はメールアドレスのみ。 */
export const emailOnlySchema = z.object({ email: emailSchema }).strict();

/** 再設定リンク後の新しいパスワード設定。 */
export const updatePasswordSchema = z
  .object({
    password: passwordSchema,
    confirmPassword: z.string(),
  })
  .strict()
  .refine((value) => value.password === value.confirmPassword, PASSWORD_MISMATCH);

export type SignInInput = z.infer<typeof signInSchema>;
export type SignUpInput = z.infer<typeof signUpSchema>;
export type EmailOnlyInput = z.infer<typeof emailOnlySchema>;
export type UpdatePasswordInput = z.infer<typeof updatePasswordSchema>;

/** 実装仕様書 5.1節: `/auth/confirm` が受け付けるメール確認の種別。 */
export const emailOtpTypeSchema = z.enum([
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
]);

export type ConfirmEmailOtpType = z.infer<typeof emailOtpTypeSchema>;

/** 実装仕様書 5.1節: データ出力の形式。 */
export const exportFormatSchema = z.enum(["json", "csv"]);

export type ExportFormat = z.infer<typeof exportFormatSchema>;

/**
 * Zod のエラーをフォームのフィールド別メッセージへ落とす。
 * 値そのものはメッセージへ含めない（実装仕様書 9.2節: 秘密値をログ・出力しない）。
 */
export function toFieldErrors(error: z.ZodError): Record<string, string[]> {
  const fieldErrors: Record<string, string[]> = {};

  for (const issue of error.issues) {
    const key = issue.path.length > 0 ? issue.path.join(".") : "form";
    (fieldErrors[key] ??= []).push(issue.message);
  }

  return fieldErrors;
}
