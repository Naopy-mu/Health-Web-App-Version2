import "server-only";

/**
 * API 層の所有者導出と利用者状態の確認（実装仕様書 3.2節 / 3.3節 / 5.1節）。
 *
 * > 所有者IDは**必ず検証済みサーバーセッションから導出**し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。
 *
 * > 利用者状態（`users.status`）が `active` 以外（`suspended` /
 * > `health_data_erasure_pending` / `deletion_pending`）の場合、有効なJWTが
 * > 残っていても全APIが HTTP 403（`ACCOUNT_INACTIVE`）を返す。
 *
 * 状態判定は Phase 1 で作成した `public.is_active_user()`（実装仕様書 6.5節）を
 * RPC として呼び、DB側の単一の真実に委ねる。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { createSupabaseServerClient } from "@/lib/supabase/server";

import { accountInactive, accountServiceUnavailable, authenticationRequired } from "./errors";

/** 検証済みセッションから導出した所有者。 */
export type ActiveUser = {
  /** 実装仕様書 6.2節: `users.id` = `owner_id` = `auth.users.id`。 */
  readonly id: string;
  /** 呼び出し元のJWTで動く、RLS適用済みのクライアント。 */
  readonly supabase: SupabaseClient;
};

export type ActiveUserResult =
  | { readonly ok: true; readonly user: ActiveUser }
  | { readonly ok: false; readonly response: Response };

type ServerClientFactory = () => Promise<SupabaseClient | null>;

/**
 * 認証・利用者状態を確認して所有者を返す。失敗時は実装仕様書 7章の形式で
 * エラー応答を返す（503 → 401 → 403 の順に判定する）。
 *
 * `options.createClient` はテスト用の注入口。本番は既定の
 * `createSupabaseServerClient` を使う。
 */
export async function requireActiveUser(
  options: { createClient?: ServerClientFactory } = {},
): Promise<ActiveUserResult> {
  const createClient = options.createClient ?? createSupabaseServerClient;
  const supabase = await createClient();

  // 実装仕様書 3.3節: Supabase未設定時、アカウントAPIは 503 を返す。
  if (!supabase) {
    return { ok: false, response: accountServiceUnavailable() };
  }

  // `getSession()` ではなくAuthサーバーへ問い合わせる `getUser()` を使う。
  // Cookieの中身は改竄されうるため、署名検証済みの利用者だけを信用する。
  const { data, error } = await supabase.auth.getUser();
  const user = data?.user ?? null;

  if (error || !user) {
    return { ok: false, response: authenticationRequired() };
  }

  // 実装仕様書 5.1節 / 6.5節: active 以外は 403 ACCOUNT_INACTIVE。
  const { data: isActive, error: statusError } = await supabase.rpc("is_active_user");

  // 判定できない場合もフェイルクローズで 403 にする。
  if (statusError || isActive !== true) {
    return { ok: false, response: accountInactive() };
  }

  return { ok: true, user: { id: user.id, supabase } };
}
