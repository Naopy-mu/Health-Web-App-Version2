"use client";

/**
 * 認証フォーム（実装仕様書 4章 / 5.1節 / 11章）。
 *
 * 送信は Server Action（`actions.ts`）に委ね、このファイルでは Supabase を
 * 直接呼ばない。クライアントバンドルに載るのは公開設定のみ（実装仕様書 9.2節）。
 *
 * アクセシビリティ（実装仕様書 11章）:
 * - 全入力に `<label>` を紐付ける。
 * - エラーは `aria-invalid` + `aria-describedby` で入力へ関連付ける。
 * - 状態メッセージは `role="status"` / `role="alert"` のライブリージョンで伝える。
 * - 送信中はボタンを `disabled` にして状態を文言でも示す。
 */

import { useActionState, useId } from "react";

import styles from "./auth.module.css";
import { IDLE_AUTH_ACTION_STATE, type AuthActionState } from "./action-state";
import {
  sendMagicLinkAction,
  sendPasswordResetAction,
  signInWithGoogleAction,
  signInWithPasswordAction,
  signOutAction,
  signUpAction,
  updatePasswordAction,
} from "./actions";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "./schema";

type AuthAction = (state: AuthActionState, formData: FormData) => Promise<AuthActionState>;

function StatusBanner({ state }: { state: AuthActionState }) {
  if (state.status === "idle" || !state.message) {
    return null;
  }

  return (
    <p
      className={styles.banner}
      role={state.status === "error" ? "alert" : "status"}
      aria-live={state.status === "error" ? "assertive" : "polite"}
    >
      {state.message}
    </p>
  );
}

function FieldErrors({ id, messages }: { id: string; messages: string[] | undefined }) {
  if (!messages || messages.length === 0) {
    return null;
  }

  return (
    <p className={styles.fieldError} id={id}>
      {messages.join(" ")}
    </p>
  );
}

type TextFieldProps = {
  name: string;
  label: string;
  type: "email" | "password";
  autoComplete: string;
  required?: boolean;
  hint?: string;
  errors?: string[];
  minLength?: number;
  maxLength?: number;
};

function TextField({
  name,
  label,
  type,
  autoComplete,
  required = true,
  hint,
  errors,
  minLength,
  maxLength,
}: TextFieldProps) {
  const inputId = useId();
  const hintId = `${inputId}-hint`;
  const errorId = `${inputId}-error`;
  const hasError = Boolean(errors && errors.length > 0);
  const describedBy = [hint ? hintId : null, hasError ? errorId : null].filter(Boolean).join(" ");

  return (
    <div className={styles.field}>
      <label className={styles.label} htmlFor={inputId}>
        {label}
      </label>
      <input
        className={styles.input}
        id={inputId}
        name={name}
        type={type}
        autoComplete={autoComplete}
        required={required}
        minLength={minLength}
        maxLength={maxLength}
        aria-invalid={hasError || undefined}
        aria-describedby={describedBy === "" ? undefined : describedBy}
      />
      {hint ? (
        <span className={styles.hint} id={hintId}>
          {hint}
        </span>
      ) : null}
      <FieldErrors id={errorId} messages={errors} />
    </div>
  );
}

const PASSWORD_HINT = `${PASSWORD_MIN_LENGTH}文字以上${PASSWORD_MAX_LENGTH}文字以内で入力してください。`;

function SubmitButton({ pending, label }: { pending: boolean; label: string }) {
  return (
    <button className={styles.button} type="submit" disabled={pending}>
      {pending ? "送信中…" : label}
    </button>
  );
}

/** `next` を hidden で持ち回る。値はサーバー側で必ず再検証する（実装仕様書 5.1節）。 */
function NextField({ next }: { next: string }) {
  return <input type="hidden" name="next" value={next} />;
}

function useAuthAction(action: AuthAction) {
  return useActionState(action, IDLE_AUTH_ACTION_STATE);
}

export function SignInForm({ next }: { next: string }) {
  const [state, formAction, pending] = useAuthAction(signInWithPasswordAction);

  return (
    <section className={styles.card} aria-labelledby="sign-in-heading">
      <h2 className={styles.cardTitle} id="sign-in-heading">
        メールアドレスでログイン
      </h2>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <NextField next={next} />
        <TextField
          name="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          errors={state.fieldErrors?.email}
        />
        <TextField
          name="password"
          label="パスワード"
          type="password"
          autoComplete="current-password"
          errors={state.fieldErrors?.password}
        />
        <SubmitButton pending={pending} label="ログイン" />
      </form>
    </section>
  );
}

export function SignUpForm({ next }: { next: string }) {
  const [state, formAction, pending] = useAuthAction(signUpAction);

  return (
    <section className={styles.card} aria-labelledby="sign-up-heading">
      <h2 className={styles.cardTitle} id="sign-up-heading">
        新規登録
      </h2>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <NextField next={next} />
        <TextField
          name="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          errors={state.fieldErrors?.email}
        />
        <TextField
          name="password"
          label="パスワード"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          errors={state.fieldErrors?.password}
        />
        <TextField
          name="confirmPassword"
          label="パスワード（確認）"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          errors={state.fieldErrors?.confirmPassword}
        />
        <SubmitButton pending={pending} label="登録する" />
      </form>
    </section>
  );
}

export function MagicLinkForm({ next }: { next: string }) {
  const [state, formAction, pending] = useAuthAction(sendMagicLinkAction);

  return (
    <section className={styles.card} aria-labelledby="magic-link-heading">
      <h2 className={styles.cardTitle} id="magic-link-heading">
        Magic Link でログイン
      </h2>
      <p className={styles.hint}>パスワードなしで、メールに届くリンクからログインします。</p>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <NextField next={next} />
        <TextField
          name="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          errors={state.fieldErrors?.email}
        />
        <SubmitButton pending={pending} label="ログイン用リンクを送る" />
      </form>
    </section>
  );
}

export function GoogleSignInForm({ next }: { next: string }) {
  const [state, formAction, pending] = useAuthAction(signInWithGoogleAction);

  return (
    <section className={styles.card} aria-labelledby="google-heading">
      <h2 className={styles.cardTitle} id="google-heading">
        Googleでログイン
      </h2>
      <p className={styles.hint}>
        ログインに必要な最小限の権限（メールアドレスとプロフィール）のみを要求します。
        カレンダーへのアクセス許可は求めません。Google Calendar連携は、必要になった時点で
        カレンダー設定から個別に同意します。
      </p>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <NextField next={next} />
        <SubmitButton pending={pending} label="Googleでログイン" />
      </form>
    </section>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction, pending] = useAuthAction(sendPasswordResetAction);

  return (
    <section className={styles.card} aria-labelledby="forgot-heading">
      <h2 className={styles.cardTitle} id="forgot-heading">
        パスワード再設定メールの送信
      </h2>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <TextField
          name="email"
          label="メールアドレス"
          type="email"
          autoComplete="email"
          errors={state.fieldErrors?.email}
        />
        <SubmitButton pending={pending} label="再設定用リンクを送る" />
      </form>
    </section>
  );
}

export function UpdatePasswordForm() {
  const [state, formAction, pending] = useAuthAction(updatePasswordAction);

  return (
    <section className={styles.card} aria-labelledby="update-password-heading">
      <h2 className={styles.cardTitle} id="update-password-heading">
        新しいパスワードの設定
      </h2>
      <StatusBanner state={state} />
      <form className={styles.form} action={formAction}>
        <TextField
          name="password"
          label="新しいパスワード"
          type="password"
          autoComplete="new-password"
          hint={PASSWORD_HINT}
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          errors={state.fieldErrors?.password}
        />
        <TextField
          name="confirmPassword"
          label="新しいパスワード（確認）"
          type="password"
          autoComplete="new-password"
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
          errors={state.fieldErrors?.confirmPassword}
        />
        <SubmitButton pending={pending} label="パスワードを更新する" />
      </form>
    </section>
  );
}

export function SignOutForm() {
  return (
    <form className={styles.form} action={signOutAction}>
      <button className={styles.button} type="submit">
        ログアウト
      </button>
    </form>
  );
}
