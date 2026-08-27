import "server-only";

/**
 * 直近の再認証の確認（実装仕様書 5.1節）。
 *
 * > エクスポートとアカウント削除は**直近の再認証**を要求する。
 *
 * 判定材料は Supabase Auth の AMR（Authentication Methods References）。
 * JWT には認証方式とその成立時刻が入っており、
 * `supabase.auth.mfa.getAuthenticatorAssuranceLevel()` から取得できる。
 * 最後に認証が成立した時刻が既定の猶予時間内であれば「直近の再認証あり」と扱う。
 *
 * 猶予時間を過ぎている場合、利用者はもう一度ログイン（または Magic Link で
 * 再認証）してから操作をやり直す。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { reauthenticationRequired } from "./errors";

/** 再認証とみなす猶予時間（秒）。5分。 */
export const REAUTHENTICATION_MAX_AGE_SECONDS = 300;

/** AMRエントリは詳細形式（時刻付き）と RFC 8176 の文字列形式がありうる。 */
type AuthenticationMethodEntry = { method?: string; timestamp?: number } | string;

/**
 * AMRから最後に認証が成立したUNIX秒を求める。
 * 時刻を持たない文字列形式しか無い場合は `null`（＝判定不能）。
 */
export function latestAuthenticationTimestamp(
  methods: readonly AuthenticationMethodEntry[] | null | undefined,
): number | null {
  if (!methods || methods.length === 0) {
    return null;
  }

  let latest: number | null = null;
  for (const entry of methods) {
    if (typeof entry === "string") {
      continue;
    }
    const timestamp = entry.timestamp;
    if (typeof timestamp === "number" && Number.isFinite(timestamp)) {
      latest = latest === null ? timestamp : Math.max(latest, timestamp);
    }
  }

  return latest;
}

/**
 * `timestamp` が `now` から見て猶予時間内か。
 * 未来に極端に進んだ時刻（時計ずれ・改竄）は「直近ではない」と扱う。
 */
export function isRecentAuthentication(
  timestamp: number | null,
  nowSeconds: number,
  maxAgeSeconds: number = REAUTHENTICATION_MAX_AGE_SECONDS,
): boolean {
  if (timestamp === null) {
    return false;
  }

  const age = nowSeconds - timestamp;
  return age >= -maxAgeSeconds && age <= maxAgeSeconds;
}

export type ReauthenticationResult =
  { readonly ok: true } | { readonly ok: false; readonly response: Response };

/**
 * 直近の再認証が無ければ 403（`REAUTHENTICATION_REQUIRED`）を返す。
 * 判定不能（AMRが取れない・時刻が無い）の場合もフェイルクローズで拒否する。
 */
export async function requireRecentReauthentication(
  supabase: SupabaseClient,
  options: { nowSeconds?: number; maxAgeSeconds?: number } = {},
): Promise<ReauthenticationResult> {
  const nowSeconds = options.nowSeconds ?? Math.floor(Date.now() / 1000);

  let methods: readonly AuthenticationMethodEntry[] | null = null;
  try {
    const { data, error } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel();
    if (error) {
      return { ok: false, response: reauthenticationRequired() };
    }
    methods = data?.currentAuthenticationMethods ?? null;
  } catch {
    return { ok: false, response: reauthenticationRequired() };
  }

  const timestamp = latestAuthenticationTimestamp(methods);
  if (!isRecentAuthentication(timestamp, nowSeconds, options.maxAgeSeconds)) {
    return { ok: false, response: reauthenticationRequired() };
  }

  return { ok: true };
}
