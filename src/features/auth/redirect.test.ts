import { describe, expect, it } from "vitest";

import {
  buildSignInPath,
  buildSignInPathWithError,
  DEFAULT_AUTH_REDIRECT_PATH,
  isSafeNextPath,
  sanitizeNextPath,
} from "./redirect";

/**
 * 実装仕様書 5.1節（オープンリダイレクト対策）:
 * > ログイン後の遷移先 `next` はアプリ内の相対パスのみ許可し、`//`、
 * > バックスラッシュ、NUL、外部オリジンを含む値は既定の `/auth/session` へ丸める。
 */
describe("sanitizeNextPath（実装仕様書 5.1節 オープンリダイレクト対策）", () => {
  it("アプリ内の相対パスはそのまま通す", () => {
    const allowed = [
      "/",
      "/records",
      "/measurements?range=30d",
      "/workouts/session/8f1f4b1c-0b0f-4b39-9c1e-2a4a4b4d5e6f",
      "/reports#summary",
      "/meals?q=%E9%9B%91%E7%82%8A", // パーセントエンコードされた日本語
    ];

    for (const value of allowed) {
      expect(sanitizeNextPath(value), value).toBe(value);
      expect(isSafeNextPath(value), value).toBe(true);
    }
  });

  it("プロトコル相対URL（`//`）を /auth/session へ丸める", () => {
    for (const value of ["//evil.example", "//evil.example/records", "///evil.example"]) {
      expect(sanitizeNextPath(value), value).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("バックスラッシュを含む値を /auth/session へ丸める", () => {
    for (const value of [
      "/\\evil.example",
      "\\\\evil.example",
      "/records\\..\\..",
      "/\\/evil.example",
    ]) {
      expect(sanitizeNextPath(value), value).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("NUL・制御文字を含む値を /auth/session へ丸める", () => {
    for (const value of [
      "/records\u0000",
      "\u0000/records",
      "/rec\u0000ords",
      "/\t/evil.example",
      "/records\n",
      "/records\r\n",
      "/records\u007f",
      "/\u001funsafe",
    ]) {
      expect(sanitizeNextPath(value), JSON.stringify(value)).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("外部オリジン・スキームを持つ値を /auth/session へ丸める", () => {
    for (const value of [
      "https://evil.example",
      "http://evil.example/records",
      "HTTPS://evil.example",
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "mailto:someone@example.com",
      "//user:pass@evil.example",
    ]) {
      expect(sanitizeNextPath(value), value).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("パーセントエンコードで `//` やバックスラッシュへ化ける値を丸める", () => {
    for (const value of [
      "/%2f%2fevil.example",
      "/%5cevil.example",
      "/%00",
      "/%2F%2Fevil.example",
    ]) {
      expect(sanitizeNextPath(value), value).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  /**
   * Codexレビュー指摘7（回帰防止）。エンコードを重ねた値でオープンリダイレクトへ
   * 化けないことを明示的に固定する。
   *
   * `sanitizeNextPath` の保証は「元の値」と「1段デコードした値」の両方が
   * アプリ内パスの形であること。ブラウザは `Location` のパスを再デコードして
   * 解決し直さないため、実際に危険なのはこの2段階までで、
   * 二重以上にエンコードされた値は**単なるアプリ内パス**として扱われる
   * （`/%252f%252fevil.example` は app.example 上のパスであって外部ではない）。
   */
  it("1段デコードで `//`・バックスラッシュへ化ける値を丸める", () => {
    for (const value of [
      "/%2f%2fevil.example",
      "/%2F%2Fevil.example",
      "/%5C%5Cevil.example",
      "/%5c/evil.example",
    ]) {
      expect(sanitizeNextPath(value), value).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("二重・三重エンコードされた値は外部オリジンへ解決しない", () => {
    for (const value of [
      // 二重エンコード（`%252f` はデコード1段で `%2f`、2段でようやく `/`）。
      "/%252f%252fevil.example",
      "/%252F%252Fevil.example",
      "/%255C%255Cevil.example",
      // 三重エンコード。
      "/%25252f%25252fevil.example",
      "/%25255c%25255cevil.example",
    ]) {
      const sanitized = sanitizeNextPath(value);

      // 元の値と1段デコード後の両方が、アプリ内パスとして解決する。
      expect(new URL(sanitized, "https://app.example").origin, value).toBe("https://app.example");
      expect(
        new URL(decodeURIComponent(sanitized), "https://app.example").origin,
        `${value}（1段デコード）`,
      ).toBe("https://app.example");
      expect(sanitized.startsWith("//"), value).toBe(false);
    }
  });

  it("多重エンコードされたスキーム・制御文字も外部へ出さない", () => {
    for (const value of [
      "/%2568ttps://evil.example",
      "/%256a%2561vascript:alert(1)",
      "/%2500",
      "/%25252e%25252e%25252fevil.example",
    ]) {
      const sanitized = sanitizeNextPath(value);
      expect(sanitized.startsWith("/"), value).toBe(true);
      expect(sanitized.startsWith("//"), value).toBe(false);
      expect(new URL(sanitized, "https://app.example").origin, value).toBe("https://app.example");
    }
  });

  it("エンコードされた `next` をURLへ載せて読み戻しても外部オリジンにならない", () => {
    for (const value of [
      "//evil.example",
      "/%2f%2fevil.example",
      "/%252f%252fevil.example",
      "https://evil.example",
    ]) {
      // 実際の経路（`buildSignInPath` → `URLSearchParams` → 受け側で再検証）を再現する。
      const signInPath = buildSignInPath(value);
      const parsed = new URL(signInPath, "https://app.example");
      const roundTripped = sanitizeNextPath(parsed.searchParams.get("next"));

      expect(new URL(roundTripped, "https://app.example").origin, value).toBe(
        "https://app.example",
      );
      expect(roundTripped.startsWith("//"), value).toBe(false);
    }
  });

  it("壊れたパーセントエスケープを丸める", () => {
    expect(sanitizeNextPath("/%")).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    expect(sanitizeNextPath("/%zz")).toBe(DEFAULT_AUTH_REDIRECT_PATH);
  });

  it("相対パス・空文字・型違い・過大長を丸める", () => {
    for (const value of [
      "",
      "records",
      "../records",
      "./records",
      null,
      undefined,
      42,
      {},
      ["/records"],
      `/${"a".repeat(2000)}`,
    ]) {
      expect(sanitizeNextPath(value), JSON.stringify(value)).toBe(DEFAULT_AUTH_REDIRECT_PATH);
    }
  });

  it("既定値そのものは安全な値として通る", () => {
    expect(sanitizeNextPath(DEFAULT_AUTH_REDIRECT_PATH)).toBe(DEFAULT_AUTH_REDIRECT_PATH);
  });
});

describe("buildSignInPath", () => {
  it("検証済みの next を載せたログインURLを組み立てる", () => {
    expect(buildSignInPath("/measurements?range=30d")).toBe(
      "/auth?next=%2Fmeasurements%3Frange%3D30d",
    );
  });

  it("不正な next は既定値へ丸めてから載せる", () => {
    expect(buildSignInPath("https://evil.example")).toBe("/auth?next=%2Fauth%2Fsession");
    expect(buildSignInPath("//evil.example")).toBe("/auth?next=%2Fauth%2Fsession");
  });

  it("組み立てたURLを解決しても外部オリジンにならない", () => {
    const resolved = new URL(buildSignInPath("//evil.example"), "https://app.example");
    expect(resolved.origin).toBe("https://app.example");
  });
});

describe("buildSignInPathWithError（実装仕様書 3.3節 / 5.1節）", () => {
  it("理由コードだけを載せ、next は載せない", () => {
    expect(buildSignInPathWithError("account_inactive")).toBe("/auth?error=account_inactive");
  });

  it("組み立てたURLを解決しても外部オリジンにならない", () => {
    const resolved = new URL(buildSignInPathWithError("account_inactive"), "https://app.example");
    expect(resolved.origin).toBe("https://app.example");
    expect(resolved.pathname).toBe("/auth");
  });
});
