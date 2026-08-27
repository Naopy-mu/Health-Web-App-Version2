// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * メール系認証フローの着地先（実装仕様書 4章の画面表 / 5.1節）。
 *
 * | ルート           | 役割                              |
 * |------------------|-----------------------------------|
 * | `/auth/callback` | OAuth / Magic Link のコード交換   |
 * | `/auth/confirm`  | メール確認                        |
 *
 * Codexレビュー指摘1の回帰テスト。以前はサインアップ・Magic Link・
 * パスワード再設定のすべてを `/auth/confirm` へ送っており、
 * Magic Link だけ画面表と食い違っていた。
 */

const headersMock = vi.hoisted(() => ({ value: new Headers({ host: "app.example" }) }));

vi.mock("next/headers", () => ({
  headers: async () => headersMock.value,
}));

/** Supabase Auth に渡る引数のうち、このテストが確認する部分だけを型にする。 */
type EmailRedirectOptions = { options?: { emailRedirectTo?: string } };
type OAuthOptions = { options?: { redirectTo?: string } };

const supabaseMock = vi.hoisted(() => ({
  signUp: vi.fn<(credentials: EmailRedirectOptions) => Promise<{ error: null }>>(async () => ({
    error: null,
  })),
  signInWithOtp: vi.fn<(credentials: EmailRedirectOptions) => Promise<{ error: null }>>(
    async () => ({ error: null }),
  ),
  signInWithOAuth: vi.fn<
    (credentials: OAuthOptions) => Promise<{ data: { url: string | null }; error: Error }>
  >(async () => ({ data: { url: null }, error: new Error("blocked") })),
  resetPasswordForEmail: vi.fn<
    (email: string, options: { redirectTo: string }) => Promise<{ error: null }>
  >(async () => ({ error: null })),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => ({ auth: supabaseMock }),
}));

const { sendMagicLinkAction, sendPasswordResetAction, signInWithGoogleAction, signUpAction } =
  await import("./actions");
const { IDLE_AUTH_ACTION_STATE } = await import("./action-state");

const formDataOf = (values: Record<string, string>) => {
  const formData = new FormData();
  for (const [key, value] of Object.entries(values)) {
    formData.set(key, value);
  }
  return formData;
};

/** 直近の呼び出しに渡された `emailRedirectTo` / `redirectTo` を取り出す。 */
const redirectTargetOf = (call: unknown): URL => {
  const options = (call as { options?: { emailRedirectTo?: string; redirectTo?: string } }).options;
  const raw = options?.emailRedirectTo ?? options?.redirectTo;
  if (!raw) {
    throw new Error("redirect target was not passed to Supabase");
  }
  return new URL(raw);
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("メールリンクの着地先（実装仕様書 4章の画面表 / 5.1節）", () => {
  it("サインアップ確認は /auth/confirm（token_hash + type のOTP検証）", async () => {
    const state = await signUpAction(
      IDLE_AUTH_ACTION_STATE,
      formDataOf({
        email: "user@example.com",
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
        next: "/measurements",
      }),
    );

    expect(state.status).toBe("success");
    expect(supabaseMock.signUp).toHaveBeenCalledTimes(1);

    const target = redirectTargetOf(supabaseMock.signUp.mock.calls[0]?.[0]);
    expect(target.origin).toBe("https://app.example");
    expect(target.pathname).toBe("/auth/confirm");
    expect(target.searchParams.get("next")).toBe("/measurements");
  });

  it("Magic Link は /auth/callback（PKCEのコード交換）", async () => {
    const state = await sendMagicLinkAction(
      IDLE_AUTH_ACTION_STATE,
      formDataOf({ email: "user@example.com", next: "/records" }),
    );

    expect(state.status).toBe("success");
    expect(supabaseMock.signInWithOtp).toHaveBeenCalledTimes(1);

    const target = redirectTargetOf(supabaseMock.signInWithOtp.mock.calls[0]?.[0]);
    expect(target.pathname).toBe("/auth/callback");
    expect(target.searchParams.get("next")).toBe("/records");
  });

  it("パスワード再設定は /auth/confirm へ送り、next で /auth/update-password を指す", async () => {
    const state = await sendPasswordResetAction(
      IDLE_AUTH_ACTION_STATE,
      formDataOf({ email: "user@example.com" }),
    );

    expect(state.status).toBe("success");
    expect(supabaseMock.resetPasswordForEmail).toHaveBeenCalledTimes(1);

    const options = supabaseMock.resetPasswordForEmail.mock.calls[0]?.[1];
    const target = new URL(options?.redirectTo ?? "");
    expect(target.pathname).toBe("/auth/confirm");
    expect(target.searchParams.get("next")).toBe("/auth/update-password");
  });

  it("Googleログインは /auth/callback", async () => {
    await signInWithGoogleAction(IDLE_AUTH_ACTION_STATE, formDataOf({ next: "/calendar" }));

    expect(supabaseMock.signInWithOAuth).toHaveBeenCalledTimes(1);
    const target = redirectTargetOf(supabaseMock.signInWithOAuth.mock.calls[0]?.[0]);
    expect(target.pathname).toBe("/auth/callback");
    expect(target.searchParams.get("next")).toBe("/calendar");
  });

  it("メールリンクの着地先URLには必ず `next` が付く（テンプレートの前提）", async () => {
    // `supabase/templates/*.html` は `{{ .RedirectTo }}&token_hash=...` と連結するため、
    // RedirectTo が必ずクエリを持つことに依存している。
    await signUpAction(
      IDLE_AUTH_ACTION_STATE,
      formDataOf({
        email: "user@example.com",
        password: "correct horse battery",
        confirmPassword: "correct horse battery",
      }),
    );
    await sendMagicLinkAction(IDLE_AUTH_ACTION_STATE, formDataOf({ email: "user@example.com" }));

    for (const call of [
      supabaseMock.signUp.mock.calls[0]?.[0],
      supabaseMock.signInWithOtp.mock.calls[0]?.[0],
    ]) {
      const target = redirectTargetOf(call);
      expect(target.search.startsWith("?")).toBe(true);
      expect(target.searchParams.get("next")).toBe("/auth/session");
    }
  });

  it("不正な next は /auth/session へ丸めてからメールリンクへ載せる（実装仕様書 5.1節）", async () => {
    await sendMagicLinkAction(
      IDLE_AUTH_ACTION_STATE,
      formDataOf({ email: "user@example.com", next: "//evil.example" }),
    );

    const target = redirectTargetOf(supabaseMock.signInWithOtp.mock.calls[0]?.[0]);
    expect(target.origin).toBe("https://app.example");
    expect(target.searchParams.get("next")).toBe("/auth/session");
  });

  it("NEXT_PUBLIC_APP_URL 未設定でも X-Forwarded-Host は採用しない", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    headersMock.value = new Headers({
      host: "app.example",
      "x-forwarded-host": "evil.example",
      "x-forwarded-proto": "https",
    });

    await sendMagicLinkAction(IDLE_AUTH_ACTION_STATE, formDataOf({ email: "user@example.com" }));

    const target = redirectTargetOf(supabaseMock.signInWithOtp.mock.calls[0]?.[0]);
    expect(target.origin).toBe("https://app.example");

    headersMock.value = new Headers({ host: "app.example" });
  });
});
