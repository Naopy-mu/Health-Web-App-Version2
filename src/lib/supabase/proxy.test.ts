// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import { isProtectedPath, protectedRoutePrefixes, updateSupabaseSession } from "./proxy";

/**
 * 実装仕様書 3.3節:
 * > 保護ルート（`/records` `/measurements` `/workouts` `/meals` `/pantry`
 * > `/calendar` `/reports` `/settings` `/onboarding` `/auth/session` など）は、
 * > プロキシ（`src/lib/supabase/proxy.ts` の `protectedRoutePrefixes`）で
 * > セッションと利用者状態を確認する。
 */

const APP_ORIGIN = "https://app.example";

const configureSupabase = () => {
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://project.supabase.co");
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "sb_publishable_test");
};

const makeRequest = (path: string) => new NextRequest(new URL(path, APP_ORIGIN));

const anonymousClient = () => ({ getUser: async () => ({ data: { user: null } }) });
const signedInClient =
  (id = "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d") =>
  () => ({
    getUser: async () => ({ data: { user: { id } } }),
  });

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("isProtectedPath（実装仕様書 3.3節）", () => {
  it("実装仕様書 3.3節が名指しする保護ルートを網羅する", () => {
    for (const path of [
      "/records",
      "/measurements",
      "/workouts",
      "/meals",
      "/pantry",
      "/calendar",
      "/reports",
      "/settings",
      "/onboarding",
      "/auth/session",
    ]) {
      expect(protectedRoutePrefixes).toContain(path);
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it("prefix配下のサブパスも保護する", () => {
    for (const path of [
      "/workouts/session/8f1f4b1c-0b0f-4b39-9c1e-2a4a4b4d5e6f",
      "/settings/account",
      "/meals/scan",
      "/calendar/integrations/google",
    ]) {
      expect(isProtectedPath(path), path).toBe(true);
    }
  });

  it("prefixに前方一致するだけの別ルートは保護しない", () => {
    for (const path of ["/mealsomething", "/recordsx", "/settingsabc"]) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });

  it("公開ルートは保護しない", () => {
    for (const path of [
      "/",
      "/demo",
      "/auth",
      "/auth/callback",
      "/auth/confirm",
      "/auth/forgot-password",
      "/auth/update-password",
      "/offline",
      "/api/health",
    ]) {
      expect(isProtectedPath(path), path).toBe(false);
    }
  });
});

describe("updateSupabaseSession（未認証時のログインへのリダイレクト）", () => {
  it("未認証で保護ルートへアクセスすると /auth へリダイレクトする", async () => {
    configureSupabase();
    const response = await updateSupabaseSession(makeRequest("/measurements"), {
      createClient: anonymousClient,
    });

    expect(response.status).toBe(307);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe(APP_ORIGIN);
    expect(location.pathname).toBe("/auth");
    expect(location.searchParams.get("next")).toBe("/measurements");
  });

  it("元のパスとクエリを next として持ち回る", async () => {
    configureSupabase();
    const response = await updateSupabaseSession(makeRequest("/measurements?range=30d"), {
      createClient: anonymousClient,
    });

    const location = new URL(response.headers.get("location") ?? "");
    expect(location.searchParams.get("next")).toBe("/measurements?range=30d");
  });

  it("すべての保護ルートprefixが未認証アクセスをログインへ丸める", async () => {
    configureSupabase();

    for (const prefix of protectedRoutePrefixes) {
      const response = await updateSupabaseSession(makeRequest(prefix), {
        createClient: anonymousClient,
      });

      expect(response.status, prefix).toBe(307);
      expect(new URL(response.headers.get("location") ?? "").pathname, prefix).toBe("/auth");
    }
  });

  it("認証済みなら保護ルートを通す", async () => {
    configureSupabase();
    const response = await updateSupabaseSession(makeRequest("/measurements"), {
      createClient: signedInClient(),
    });

    expect(response.status).toBe(200);
    expect(response.headers.get("location")).toBeNull();
  });

  it("公開ルートは未認証でも通す", async () => {
    configureSupabase();

    for (const path of ["/", "/demo", "/auth", "/auth/forgot-password"]) {
      const response = await updateSupabaseSession(makeRequest(path), {
        createClient: anonymousClient,
      });
      expect(response.status, path).toBe(200);
    }
  });

  it("セッション確認に失敗した場合は未認証として扱う（フェイルクローズ）", async () => {
    configureSupabase();
    const response = await updateSupabaseSession(makeRequest("/records"), {
      createClient: () => ({
        getUser: async () => {
          throw new Error("network unreachable");
        },
      }),
    });

    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location") ?? "").pathname).toBe("/auth");
  });

  it("Supabase未設定なら保護ルートをログインへ丸め、公開ルートは通す（実装仕様書 3.3節）", async () => {
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "");
    vi.stubEnv("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY", "");

    const protectedResponse = await updateSupabaseSession(makeRequest("/onboarding"));
    expect(protectedResponse.status).toBe(307);
    expect(new URL(protectedResponse.headers.get("location") ?? "").pathname).toBe("/auth");

    const publicResponse = await updateSupabaseSession(makeRequest("/demo"));
    expect(publicResponse.status).toBe(200);
  });

  it("next には外部オリジンが載らない（実装仕様書 5.1節）", async () => {
    configureSupabase();
    // パスは常に `/` 始まりなので、`next` は必ずアプリ内パスへ丸められる。
    const response = await updateSupabaseSession(
      makeRequest("/records?redirect=https://evil.example"),
      { createClient: anonymousClient },
    );

    const location = new URL(response.headers.get("location") ?? "");
    const next = location.searchParams.get("next") ?? "";
    expect(next.startsWith("/")).toBe(true);
    expect(next.startsWith("//")).toBe(false);
    expect(new URL(next, APP_ORIGIN).origin).toBe(APP_ORIGIN);
  });
});
