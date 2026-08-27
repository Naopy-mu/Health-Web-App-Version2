// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/auth/callback` の分岐（実装仕様書 4章の画面表 / 5.1節）。
 *
 * 実地検証（docs/known-issues.md P2-5）の回帰テスト。
 * GoTrue は宛先が未登録・メール未確認のとき、Magic Link の要求であっても
 * `confirmation`（サインアップ確認）テンプレートを選ぶ。そのリンクは
 * `{{ .RedirectTo }}`（= `/auth/callback?next=…`）へ `&token_hash=…&type=signup`
 * を足した形で届くため、`code` が無くても `token_hash` があれば OTP 検証へ回す。
 * ここを `missing_code` で弾くと、サインアップ済みで未確認の利用者が
 * どのメールからもログインできなくなる。
 */

const APP_ORIGIN = "https://app.example";

/** Supabase Auth のうち、このテストが確認する呼び出しだけを型にする。 */
type AuthError = { message: string } | null;

const authMock = vi.hoisted(() => ({
  exchangeCodeForSession: vi.fn<(code: string) => Promise<{ error: AuthError }>>(async () => ({
    error: null,
  })),
  verifyOtp: vi.fn<(args: { type: string; token_hash: string }) => Promise<{ error: AuthError }>>(
    async () => ({ error: null }),
  ),
}));

const clientMock = vi.hoisted(() => ({ configured: true }));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () => (clientMock.configured ? { auth: authMock } : null),
}));

const { GET } = await import("./route");

const requestFor = (query: string) =>
  new NextRequest(new URL(`/auth/callback${query}`, APP_ORIGIN));

/** リダイレクト先を `Location` から取り出す。 */
const locationOf = (response: Response) => new URL(response.headers.get("location") ?? "");

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
  clientMock.configured = true;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
  authMock.exchangeCodeForSession.mockResolvedValue({ error: null });
  authMock.verifyOtp.mockResolvedValue({ error: null });
});

describe("PKCE の code 交換（Magic Link / OAuth の既定経路）", () => {
  it("code を交換して検証済みの next へ送る", async () => {
    const response = await GET(requestFor("?code=abc&next=%2Fmeasurements"));

    expect(authMock.exchangeCodeForSession).toHaveBeenCalledWith("abc");
    expect(locationOf(response).pathname).toBe("/measurements");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("交換に失敗したら /auth?error=exchange_failed", async () => {
    authMock.exchangeCodeForSession.mockResolvedValueOnce({ error: { message: "expired" } });
    const location = locationOf(await GET(requestFor("?code=abc")));

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("exchange_failed");
  });

  it("プロバイダーに拒否されたら /auth?error=exchange_failed（値そのものは載せない）", async () => {
    const location = locationOf(
      await GET(requestFor("?error=access_denied&error_description=user%20denied")),
    );

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("exchange_failed");
    expect(location.search).not.toContain("denied");
  });

  it("code も token_hash も無ければ /auth?error=missing_code", async () => {
    const location = locationOf(await GET(requestFor("")));

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("missing_code");
    expect(authMock.verifyOtp).not.toHaveBeenCalled();
  });
});

describe("token_hash 形式のリンク（未登録・メール未確認の宛先へ届く confirmation テンプレート）", () => {
  it("code が無くても token_hash があれば OTP を検証して next へ送る", async () => {
    const response = await GET(requestFor("?next=%2Fmeasurements&token_hash=pkce_abc&type=signup"));

    expect(authMock.verifyOtp).toHaveBeenCalledWith({ type: "signup", token_hash: "pkce_abc" });
    expect(authMock.exchangeCodeForSession).not.toHaveBeenCalled();
    expect(locationOf(response).pathname).toBe("/measurements");
  });

  it("期限切れ・使用済みなら /auth?error=verification_failed", async () => {
    authMock.verifyOtp.mockResolvedValueOnce({ error: { message: "expired" } });
    const location = locationOf(await GET(requestFor("?token_hash=pkce_abc&type=signup")));

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("verification_failed");
  });

  it("未知の type なら /auth?error=invalid_link", async () => {
    const location = locationOf(await GET(requestFor("?token_hash=pkce_abc&type=bogus")));

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("invalid_link");
    expect(authMock.verifyOtp).not.toHaveBeenCalled();
  });

  it("recovery は next によらず /auth/update-password へ着地する", async () => {
    const location = locationOf(
      await GET(requestFor("?next=%2Fmeasurements&token_hash=pkce_abc&type=recovery")),
    );

    expect(location.pathname).toBe("/auth/update-password");
  });

  it("外部オリジンへ出る next は /auth/session へ丸める（実装仕様書 5.1節）", async () => {
    const location = locationOf(
      await GET(
        requestFor(`?next=${encodeURIComponent("//evil.example")}&token_hash=pkce_abc&type=signup`),
      ),
    );

    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/auth/session");
  });

  it("Supabase未設定なら /auth?error=service_unavailable（実装仕様書 3.3節）", async () => {
    clientMock.configured = false;
    const location = locationOf(await GET(requestFor("?token_hash=pkce_abc&type=signup")));

    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("error")).toBe("service_unavailable");
  });
});
