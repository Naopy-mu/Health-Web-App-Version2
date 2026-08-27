// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { getTrustedAppOrigin, resolveAppOrigin, resolveAppOriginFromHeaders } from "./app-origin";

/**
 * 実装仕様書 7章 / 9.2節: 状態変更APIは same-origin を検証する。
 * 比較対象の「アプリのオリジン」を、攻撃者が送り込めるヘッダーで
 * 定義させてはならない（`X-Forwarded-Host` / `X-Forwarded-Proto`）。
 */

const APP_ORIGIN = "https://app.example";

const makeRequest = (url: string, headers: Record<string, string> = {}) =>
  new Request(url, { headers });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getTrustedAppOrigin（same-origin検査の比較対象）", () => {
  it("NEXT_PUBLIC_APP_URL のオリジンを返す", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", `${APP_ORIGIN}/some/path?x=1`);
    expect(getTrustedAppOrigin()).toBe(APP_ORIGIN);
  });

  it("未設定なら null を返す（呼び出し側がフェイルクローズする）", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(getTrustedAppOrigin()).toBeNull();
  });

  it("http/https 以外のスキームは信頼しない", () => {
    for (const value of ["javascript:alert(1)", "ftp://app.example", "not a url"]) {
      vi.stubEnv("NEXT_PUBLIC_APP_URL", value);
      expect(getTrustedAppOrigin(), value).toBeNull();
    }
  });

  it("X-Forwarded-* があってもリクエストからは何も採らない", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    // 引数を取らない＝ヘッダーの影響を受けようがない、という設計をここで固定する。
    expect(getTrustedAppOrigin()).toBeNull();
  });
});

describe("resolveAppOrigin（リダイレクト先の絶対URL用）", () => {
  it("NEXT_PUBLIC_APP_URL が設定されていればそれを使う", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    const origin = resolveAppOrigin(
      makeRequest("https://internal.vercel.app/auth/callback", {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
    );
    expect(origin).toBe(APP_ORIGIN);
  });

  it("未設定でも X-Forwarded-Host を採用しない（リクエストURL自身のオリジン）", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    const origin = resolveAppOrigin(
      makeRequest("https://app.example/auth/callback", {
        "x-forwarded-host": "evil.example",
        "x-forwarded-proto": "https",
      }),
    );
    expect(origin).toBe(APP_ORIGIN);
  });
});

describe("resolveAppOriginFromHeaders（Server Action からのメールリンク用）", () => {
  const headersOf = (values: Record<string, string>) => new Headers(values);

  it("NEXT_PUBLIC_APP_URL を最優先する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    expect(resolveAppOriginFromHeaders(headersOf({ host: "evil.example" }))).toBe(APP_ORIGIN);
  });

  it("未設定なら Host を使い、X-Forwarded-Host は無視する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(
      resolveAppOriginFromHeaders(
        headersOf({ host: "app.example", "x-forwarded-host": "evil.example" }),
      ),
    ).toBe(APP_ORIGIN);
  });

  it("X-Forwarded-Proto ではなくホスト名からスキームを決める", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(
      resolveAppOriginFromHeaders(
        headersOf({ host: "localhost:3000", "x-forwarded-proto": "https" }),
      ),
    ).toBe("http://localhost:3000");
    expect(
      resolveAppOriginFromHeaders(headersOf({ host: "app.example", "x-forwarded-proto": "http" })),
    ).toBe(APP_ORIGIN);
  });

  it("Host が無い・壊れている場合は開発用の既定値へ落とす", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(resolveAppOriginFromHeaders(headersOf({}))).toBe("http://localhost:3000");
    expect(resolveAppOriginFromHeaders({ get: () => "  " })).toBe("http://localhost:3000");
    expect(resolveAppOriginFromHeaders({ get: () => "in valid host" })).toBe(
      "http://localhost:3000",
    );
  });
});
