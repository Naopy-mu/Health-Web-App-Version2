import { describe, expect, it } from "vitest";

import {
  emailOtpTypeSchema,
  exportFormatSchema,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  signUpSchema,
  toFieldErrors,
  updatePasswordSchema,
} from "./schema";

/**
 * 実装仕様書 5.1節:
 * > パスワードは8文字以上256文字以内、確認用パスワードとの一致を必須とする。
 */
describe("パスワード要件（実装仕様書 5.1節）", () => {
  const email = "user@example.com";

  it("下限・上限は 8 / 256 文字", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(PASSWORD_MAX_LENGTH).toBe(256);
  });

  it("境界ちょうどの長さを受け付ける", () => {
    for (const length of [PASSWORD_MIN_LENGTH, PASSWORD_MAX_LENGTH]) {
      const password = "a".repeat(length);
      expect(
        signUpSchema.safeParse({ email, password, confirmPassword: password }).success,
        String(length),
      ).toBe(true);
    }
  });

  it("境界の外側を拒否する", () => {
    for (const length of [0, 1, PASSWORD_MIN_LENGTH - 1, PASSWORD_MAX_LENGTH + 1]) {
      const password = "a".repeat(length);
      expect(
        signUpSchema.safeParse({ email, password, confirmPassword: password }).success,
        String(length),
      ).toBe(false);
    }
  });

  it("確認用パスワードが一致しなければ拒否し、confirmPassword へエラーを付ける", () => {
    const parsed = signUpSchema.safeParse({
      email,
      password: "correct-horse",
      confirmPassword: "correct-hors",
    });

    expect(parsed.success).toBe(false);
    if (parsed.success) return;
    expect(toFieldErrors(parsed.error)).toHaveProperty("confirmPassword");
  });

  it("未知のフィールドを拒否する（実装仕様書 9.2節 `.strict()`）", () => {
    const password = "correct-horse";
    expect(
      signUpSchema.safeParse({
        email,
        password,
        confirmPassword: password,
        // 所有者IDをボディから渡す経路を作らない（実装仕様書 3.2節）。
        owner_id: "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d",
      }).success,
    ).toBe(false);
  });

  it("メールアドレスの形式を検証する", () => {
    const password = "correct-horse";
    for (const value of ["not-an-email", "", "user@", "@example.com", `${"a".repeat(250)}@x.com`]) {
      expect(
        signUpSchema.safeParse({ email: value, password, confirmPassword: password }).success,
        value,
      ).toBe(false);
    }
  });

  it("パスワード更新も同じ長さ・一致の要件を課す", () => {
    const tooShort = "a".repeat(PASSWORD_MIN_LENGTH - 1);
    expect(
      updatePasswordSchema.safeParse({ password: tooShort, confirmPassword: tooShort }).success,
    ).toBe(false);

    const valid = "a".repeat(PASSWORD_MIN_LENGTH);
    expect(
      updatePasswordSchema.safeParse({ password: valid, confirmPassword: valid }).success,
    ).toBe(true);
    expect(
      updatePasswordSchema.safeParse({ password: valid, confirmPassword: `${valid}x` }).success,
    ).toBe(false);
  });
});

describe("`/auth/confirm` の種別（実装仕様書 5.1節）", () => {
  it("メール確認の種別のみを受け付ける", () => {
    for (const value of ["signup", "invite", "magiclink", "recovery", "email_change", "email"]) {
      expect(emailOtpTypeSchema.safeParse(value).success, value).toBe(true);
    }

    for (const value of ["sms", "phone_change", "", null, "SIGNUP"]) {
      expect(emailOtpTypeSchema.safeParse(value).success, String(value)).toBe(false);
    }
  });
});

describe("データ出力の形式（実装仕様書 5.1節）", () => {
  it("json / csv のみを受け付ける", () => {
    expect(exportFormatSchema.safeParse("json").success).toBe(true);
    expect(exportFormatSchema.safeParse("csv").success).toBe(true);
    expect(exportFormatSchema.safeParse("xlsx").success).toBe(false);
  });
});
