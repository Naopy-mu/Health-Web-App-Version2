import { describe, expect, it } from "vitest";

import {
  buildSignInPath,
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
