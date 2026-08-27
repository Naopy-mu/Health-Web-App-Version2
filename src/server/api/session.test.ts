// @vitest-environment node
import type { SupabaseClient } from "@supabase/supabase-js";
import { describe, expect, it, vi } from "vitest";

import { API_ERROR_CODES } from "./errors";
import { requireActiveUser } from "./session";

/**
 * 実装仕様書 3.3節:
 * > Supabase未設定時は、アカウントAPIは HTTP 503（`ACCOUNT_SERVICE_UNAVAILABLE`）を返す。
 *
 * 実装仕様書 5.1節:
 * > 利用者状態（`users.status`）が `active` 以外の場合、有効なJWTが残っていても
 * > 全APIが HTTP 403（`ACCOUNT_INACTIVE`）を返す。
 */

type FakeClientOptions = {
  user?: { id: string } | null;
  userError?: { message: string } | null;
  isActive?: boolean | null;
  rpcError?: { message: string } | null;
};

const USER_ID = "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d";

function createFakeSupabaseClient(options: FakeClientOptions) {
  const rpc = vi.fn(async (functionName: string) => {
    expect(functionName).toBe("is_active_user");
    return { data: options.isActive ?? null, error: options.rpcError ?? null };
  });

  const client = {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: options.user ?? null },
        error: options.userError ?? null,
      })),
    },
    rpc,
  };

  return { client: client as unknown as SupabaseClient, rpc };
}

const readErrorBody = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

describe("requireActiveUser（実装仕様書 3.3節 / 5.1節）", () => {
  it("Supabase未設定なら 503 ACCOUNT_SERVICE_UNAVAILABLE を返す", async () => {
    const result = await requireActiveUser({ createClient: async () => null });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(503);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.ACCOUNT_SERVICE_UNAVAILABLE,
    );
  });

  it("未設定の判定は利用者状態より先に行う（Authへ問い合わせない）", async () => {
    const createClient = vi.fn(async () => null);
    await requireActiveUser({ createClient });
    expect(createClient).toHaveBeenCalledOnce();
  });

  it("検証済みセッションが無ければ 401 AUTHENTICATION_REQUIRED を返す", async () => {
    const { client, rpc } = createFakeSupabaseClient({ user: null });
    const result = await requireActiveUser({ createClient: async () => client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.AUTHENTICATION_REQUIRED,
    );
    // 未認証なら利用者状態は問い合わせない。
    expect(rpc).not.toHaveBeenCalled();
  });

  it("Authがエラーを返せば 401 を返す", async () => {
    const { client } = createFakeSupabaseClient({
      user: { id: USER_ID },
      userError: { message: "invalid claim" },
    });
    const result = await requireActiveUser({ createClient: async () => client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(401);
  });

  it("JWTが有効でも is_active_user() が false なら 403 ACCOUNT_INACTIVE を返す", async () => {
    const { client, rpc } = createFakeSupabaseClient({
      user: { id: USER_ID },
      isActive: false,
    });
    const result = await requireActiveUser({ createClient: async () => client });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.ACCOUNT_INACTIVE,
    );
    expect(rpc).toHaveBeenCalledWith("is_active_user");
  });

  it("状態を判定できない場合もフェイルクローズで 403 を返す", async () => {
    for (const options of [
      { user: { id: USER_ID }, rpcError: { message: "permission denied" } },
      { user: { id: USER_ID }, isActive: null },
    ] satisfies FakeClientOptions[]) {
      const { client } = createFakeSupabaseClient(options);
      const result = await requireActiveUser({ createClient: async () => client });

      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.response.status).toBe(403);
    }
  });

  it("active な利用者は検証済みセッション由来のUIDとともに通す", async () => {
    const { client } = createFakeSupabaseClient({ user: { id: USER_ID }, isActive: true });
    const result = await requireActiveUser({ createClient: async () => client });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // 実装仕様書 3.2節: 所有者IDは必ず検証済みサーバーセッションから導出する。
    expect(result.user.id).toBe(USER_ID);
    expect(result.user.supabase).toBe(client);
  });
});
