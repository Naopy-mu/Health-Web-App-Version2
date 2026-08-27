"use server";

/**
 * 認証の Server Action（実装仕様書 5.1節）。
 *
 * Server Action を使うのは、セッションCookieの発行をサーバー側に閉じ込め、
 * publishable key 以外の値をクライアントへ出さないため（実装仕様書 9.2節）。
 * Next.js の Server Action は同一オリジン検査を内蔵しており、
 * CSPの `form-action 'self'`（実装仕様書 9.1節）と併せて外部からの投稿を防ぐ。
 *
 * エラー文言は「メールアドレスかパスワードが正しくありません」のように
 * アカウントの存在有無を漏らさない粒度に揃える。
 */

import { headers } from "next/headers";
import { redirect } from "next/navigation";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { authActionError, authActionSuccess, type AuthActionState } from "./action-state";
import {
  AUTH_CALLBACK_PATH,
  AUTH_CONFIRM_PATH,
  GOOGLE_SIGN_IN_SCOPES,
  UPDATE_PASSWORD_PATH,
} from "./constants";
import { DEFAULT_AUTH_REDIRECT_PATH, sanitizeNextPath } from "./redirect";
import {
  emailOnlySchema,
  signInSchema,
  signUpSchema,
  toFieldErrors,
  updatePasswordSchema,
} from "./schema";

const SERVICE_UNAVAILABLE_MESSAGE =
  "アカウント機能は現在利用できません。デモモードをご利用ください。";

const GENERIC_FAILURE_MESSAGE = "処理できませんでした。時間をおいてお試しください。";

/** Server Action からアプリのオリジンを求める（絶対URLのリダイレクト先に使う）。 */
async function resolveOrigin(): Promise<string> {
  const configured = process.env.NEXT_PUBLIC_APP_URL?.trim();
  if (configured) {
    try {
      return new URL(configured).origin;
    } catch {
      // 設定が壊れている場合はリクエストヘッダーへフォールバックする。
    }
  }

  const headerList = await headers();
  const host = headerList.get("x-forwarded-host") ?? headerList.get("host");
  const proto = headerList.get("x-forwarded-proto") ?? "https";
  return host ? `${proto}://${host}` : "http://localhost:3000";
}

/** `next` を検証したうえでコールバックの絶対URLを組み立てる（実装仕様書 5.1節）。 */
async function buildCallbackUrl(path: string, next: string): Promise<string> {
  const origin = await resolveOrigin();
  const url = new URL(path, origin);
  url.searchParams.set("next", sanitizeNextPath(next));
  return url.toString();
}

const readNext = (formData: FormData): string => sanitizeNextPath(formData.get("next"));

/** メール+パスワードでログインする。 */
export async function signInWithPasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
  });

  if (!parsed.success) {
    return authActionError("入力内容を確認してください。", toFieldErrors(parsed.error));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return authActionError("メールアドレスまたはパスワードが正しくありません。");
  }

  redirect(readNext(formData));
}

/** メール+パスワードで登録する。メール確認は `/auth/confirm` が処理する。 */
export async function signUpAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = signUpSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return authActionError("入力内容を確認してください。", toFieldErrors(parsed.error));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  const { error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      emailRedirectTo: await buildCallbackUrl(AUTH_CONFIRM_PATH, readNext(formData)),
    },
  });

  if (error) {
    return authActionError(GENERIC_FAILURE_MESSAGE);
  }

  // アカウントの存在有無を漏らさないため、既存メールでも同じ文言を返す。
  return authActionSuccess("確認メールを送信しました。メール内のリンクを開いてください。");
}

/** Magic Link を送信する。 */
export async function sendMagicLinkAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return authActionError("入力内容を確認してください。", toFieldErrors(parsed.error));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  const { error } = await supabase.auth.signInWithOtp({
    email: parsed.data.email,
    options: {
      emailRedirectTo: await buildCallbackUrl(AUTH_CONFIRM_PATH, readNext(formData)),
    },
  });

  if (error) {
    return authActionError(GENERIC_FAILURE_MESSAGE);
  }

  return authActionSuccess("ログイン用リンクを送信しました。メールをご確認ください。");
}

/**
 * Googleログインを開始する（実装仕様書 5.1節）。
 * 要求するのは認証に必要な最小スコープのみ。Calendar連携の同意とは分離する。
 */
export async function signInWithGoogleAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: "google",
    options: {
      redirectTo: await buildCallbackUrl(AUTH_CALLBACK_PATH, readNext(formData)),
      scopes: GOOGLE_SIGN_IN_SCOPES,
    },
  });

  if (error || !data?.url) {
    return authActionError(GENERIC_FAILURE_MESSAGE);
  }

  redirect(data.url);
}

/** パスワード再設定メールを送信する。 */
export async function sendPasswordResetAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = emailOnlySchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return authActionError("入力内容を確認してください。", toFieldErrors(parsed.error));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    redirectTo: await buildCallbackUrl(AUTH_CONFIRM_PATH, UPDATE_PASSWORD_PATH),
  });

  // 登録の有無を漏らさないため、結果によらず同じ文言を返す。
  return authActionSuccess("登録済みのメールアドレスであれば、再設定用のリンクを送信しました。");
}

/** 再設定リンク後に新しいパスワードを設定する。 */
export async function updatePasswordAction(
  _previousState: AuthActionState,
  formData: FormData,
): Promise<AuthActionState> {
  const parsed = updatePasswordSchema.safeParse({
    password: formData.get("password"),
    confirmPassword: formData.get("confirmPassword"),
  });

  if (!parsed.success) {
    return authActionError("入力内容を確認してください。", toFieldErrors(parsed.error));
  }

  const supabase = await createSupabaseServerClient();
  if (!supabase) {
    return authActionError(SERVICE_UNAVAILABLE_MESSAGE);
  }

  const { data: userData } = await supabase.auth.getUser();
  if (!userData?.user) {
    return authActionError("再設定用リンクの有効期限が切れています。もう一度お試しください。");
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });
  if (error) {
    return authActionError(GENERIC_FAILURE_MESSAGE);
  }

  redirect(DEFAULT_AUTH_REDIRECT_PATH);
}

/** ログアウトする。 */
export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  if (supabase) {
    await supabase.auth.signOut();
  }

  redirect("/auth");
}
