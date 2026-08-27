// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

/**
 * メールリンクの `token_hash` 検証（実装仕様書 4章の画面表 / 5.1節）。
 *
 * 実地検証（docs/known-issues.md P2-5）の回帰テスト。GoTrue は宛先が未登録・
 * メール未確認のとき、Magic Link の要求であっても `confirmation`
 * （サインアップ確認）テンプレートを選ぶ。そのリンクは `{{ .RedirectTo }}`
 * （= `/auth/callback?next=…`）へ `token_hash` を足した形になるため、
 * `/auth/callback` も `token_hash` 形式を扱えなければならない。
 */

const { hasEmailOtpToken, verifyEmailOtpLink } = await import("./email-otp");

type VerifyOtpArgs = { type: string; token_hash: string };
type AuthError = { message: string } | null;

/** `verifyOtp` の呼び出しを記録するだけの最小スタブ。 */
const clientStub = (error: AuthError) => {
  const verifyOtp = vi.fn<(args: VerifyOtpArgs) => Promise<{ error: AuthError }>>(async () => ({
    error,
  }));
  return {
    verifyOtp,
    createClient: async () =>
      ({ auth: { verifyOtp } }) as unknown as Awaited<
        ReturnType<typeof import("@/lib/supabase/server").createSupabaseServerClient>
      >,
  };
};

const paramsOf = (query: string) => new URLSearchParams(query);

describe("hasEmailOtpToken", () => {
  it("token_hash があるときだけ true", () => {
    expect(hasEmailOtpToken(paramsOf("token_hash=abc&type=signup"))).toBe(true);
    expect(hasEmailOtpToken(paramsOf("code=abc"))).toBe(false);
    expect(hasEmailOtpToken(paramsOf(""))).toBe(false);
  });
});

describe("verifyEmailOtpLink", () => {
  it("token_hash が無ければ invalid（Supabaseを呼ばない）", async () => {
    const { verifyOtp, createClient } = clientStub(null);
    const result = await verifyEmailOtpLink(paramsOf("type=signup"), { createClient });

    expect(result).toEqual({ status: "invalid" });
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("未知の type は invalid（Supabaseを呼ばない）", async () => {
    const { verifyOtp, createClient } = clientStub(null);
    const result = await verifyEmailOtpLink(paramsOf("token_hash=abc&type=bogus"), {
      createClient,
    });

    expect(result).toEqual({ status: "invalid" });
    expect(verifyOtp).not.toHaveBeenCalled();
  });

  it("Supabase未設定なら unavailable（実装仕様書 3.3節）", async () => {
    const result = await verifyEmailOtpLink(paramsOf("token_hash=abc&type=signup"), {
      createClient: async () => null,
    });

    expect(result).toEqual({ status: "unavailable" });
  });

  it("verifyOtp が失敗したら failed（期限切れ・使用済み）", async () => {
    const { createClient } = clientStub({ message: "Token has expired or is invalid" });
    const result = await verifyEmailOtpLink(paramsOf("token_hash=abc&type=signup"), {
      createClient,
    });

    expect(result).toEqual({ status: "failed" });
  });

  it("signup は検証済みの next へ着地する", async () => {
    const { verifyOtp, createClient } = clientStub(null);
    const result = await verifyEmailOtpLink(
      paramsOf("token_hash=abc&type=signup&next=%2Fmeasurements"),
      { createClient },
    );

    expect(result).toEqual({ status: "verified", next: "/measurements" });
    expect(verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "abc" });
  });

  it("外部オリジンへ出る next は /auth/session へ丸める（実装仕様書 5.1節）", async () => {
    const { createClient } = clientStub(null);
    const result = await verifyEmailOtpLink(
      paramsOf(`token_hash=abc&type=signup&next=${encodeURIComponent("//evil.example")}`),
      { createClient },
    );

    expect(result).toEqual({ status: "verified", next: "/auth/session" });
  });

  it("recovery は next の指定によらず /auth/update-password へ着地する", async () => {
    const { createClient } = clientStub(null);
    const result = await verifyEmailOtpLink(
      paramsOf("token_hash=abc&type=recovery&next=%2Fmeasurements"),
      { createClient },
    );

    expect(result).toEqual({ status: "verified", next: "/auth/update-password" });
  });
});
