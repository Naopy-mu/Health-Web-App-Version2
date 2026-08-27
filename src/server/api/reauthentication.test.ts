// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { API_ERROR_CODES } from "./errors";
import {
  isRecentAuthentication,
  latestAuthenticationTimestamp,
  REAUTHENTICATION_MAX_AGE_SECONDS,
  requireRecentReauthentication,
} from "./reauthentication";

/**
 * 実装仕様書 5.1節:
 * > エクスポートとアカウント削除は**直近の再認証**を要求する。
 */

const NOW_SECONDS = 1_800_000_000;

type AuthenticationMethods =
  ({ method?: string; timestamp?: number } | string)[] | null | undefined;

function createFakeClient(options: {
  methods?: AuthenticationMethods;
  error?: { message: string };
  throws?: boolean;
}) {
  return {
    auth: {
      mfa: {
        getAuthenticatorAssuranceLevel: vi.fn(async () => {
          if (options.throws) {
            throw new Error("network unreachable");
          }
          return {
            data: options.error
              ? null
              : {
                  currentLevel: "aal1",
                  nextLevel: "aal1",
                  currentAuthenticationMethods: options.methods ?? [],
                },
            error: options.error ?? null,
          };
        }),
      },
    },
  } as unknown as SupabaseClient;
}

const readErrorBody = async (response: Response) =>
  (await response.json()) as { error: { code: string } };

describe("latestAuthenticationTimestamp", () => {
  it("最も新しい認証時刻を返す", () => {
    expect(
      latestAuthenticationTimestamp([
        { method: "password", timestamp: NOW_SECONDS - 900 },
        { method: "otp", timestamp: NOW_SECONDS - 30 },
      ]),
    ).toBe(NOW_SECONDS - 30);
  });

  it("時刻を持たない RFC 8176 形式のみなら判定不能とする", () => {
    expect(latestAuthenticationTimestamp(["password", "otp"])).toBeNull();
  });

  it("空・未指定は判定不能とする", () => {
    expect(latestAuthenticationTimestamp([])).toBeNull();
    expect(latestAuthenticationTimestamp(null)).toBeNull();
    expect(latestAuthenticationTimestamp(undefined)).toBeNull();
  });
});

describe("isRecentAuthentication", () => {
  it("猶予時間は5分", () => {
    expect(REAUTHENTICATION_MAX_AGE_SECONDS).toBe(300);
  });

  it("猶予時間内なら直近の再認証とみなす", () => {
    expect(isRecentAuthentication(NOW_SECONDS, NOW_SECONDS)).toBe(true);
    expect(
      isRecentAuthentication(NOW_SECONDS - REAUTHENTICATION_MAX_AGE_SECONDS, NOW_SECONDS),
    ).toBe(true);
  });

  it("猶予時間を過ぎていれば直近ではない", () => {
    expect(
      isRecentAuthentication(NOW_SECONDS - REAUTHENTICATION_MAX_AGE_SECONDS - 1, NOW_SECONDS),
    ).toBe(false);
  });

  it("極端に未来の時刻（時計ずれ・改竄）も直近ではない", () => {
    expect(
      isRecentAuthentication(NOW_SECONDS + REAUTHENTICATION_MAX_AGE_SECONDS + 1, NOW_SECONDS),
    ).toBe(false);
  });

  it("判定不能なら直近ではない", () => {
    expect(isRecentAuthentication(null, NOW_SECONDS)).toBe(false);
  });
});

describe("requireRecentReauthentication（実装仕様書 5.1節）", () => {
  it("直近の再認証があれば通す", async () => {
    const client = createFakeClient({
      methods: [{ method: "password", timestamp: NOW_SECONDS - 10 }],
    });
    const result = await requireRecentReauthentication(client, { nowSeconds: NOW_SECONDS });
    expect(result.ok).toBe(true);
  });

  it("古い認証しか無ければ 403 REAUTHENTICATION_REQUIRED を返す", async () => {
    const client = createFakeClient({
      methods: [{ method: "password", timestamp: NOW_SECONDS - 3600 }],
    });
    const result = await requireRecentReauthentication(client, { nowSeconds: NOW_SECONDS });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.REAUTHENTICATION_REQUIRED,
    );
  });

  it("AMRが取得できない場合もフェイルクローズで拒否する", async () => {
    for (const client of [
      createFakeClient({ error: { message: "not authenticated" } }),
      createFakeClient({ throws: true }),
      createFakeClient({ methods: [] }),
      createFakeClient({ methods: ["password"] }),
    ]) {
      const result = await requireRecentReauthentication(client, { nowSeconds: NOW_SECONDS });
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.response.status).toBe(403);
    }
  });
});
