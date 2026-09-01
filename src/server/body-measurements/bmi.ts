import "server-only";

/**
 * BMI の算出（実装仕様書 5.3節）。
 *
 * > 計算: BMI（`体重kg / (身長m)^2` を小数1桁）
 *
 * 身長は**確定プロフィール**から取る。実装仕様書 5.2節:
 *
 * > 候補は編集可能で、`confirmed: true` を伴う確認操作の後にのみ保存する。
 * > 認証時は `save_my_confirmed_profile(profile jsonb)` RPCで、
 * > `users.timezone`・`user_profiles.settings.confirmed_profile`・体重目標を
 * > 同一トランザクションで保存する。
 *
 * したがって参照先は `public.user_profiles.settings -> 'confirmed_profile' -> 'heightCm'`。
 * **未確認のプロフィールからは読まない**（確認していない値でBMIを出さない）。
 * 身長が未設定・範囲外なら BMI は `null` になる。
 */

import type { SupabaseClient } from "@supabase/supabase-js";

import { calculateBmi } from "@/features/body-measurements/units";

import { invalidRequest } from "../api/errors";
import type { GuardResult } from "../api/guards";

/** 確定プロフィールの JSON パス（実装仕様書 5.2節）。 */
export const CONFIRMED_PROFILE_KEY = "confirmed_profile";
export const CONFIRMED_PROFILE_HEIGHT_KEY = "heightCm";

/** 実装仕様書 5.2節「身長30〜300cm」。範囲外は未設定として扱う。 */
export const HEIGHT_CM_MIN = 30;
export const HEIGHT_CM_MAX = 300;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** `user_profiles.settings` から確定済みの身長(cm)を取り出す。無ければ `null`。 */
export function readHeightCmFromSettings(settings: unknown): number | null {
  if (!isPlainObject(settings)) {
    return null;
  }

  const confirmed = settings[CONFIRMED_PROFILE_KEY];
  if (!isPlainObject(confirmed)) {
    return null;
  }

  const height = confirmed[CONFIRMED_PROFILE_HEIGHT_KEY];
  if (typeof height !== "number" || !Number.isFinite(height)) {
    return null;
  }

  if (height < HEIGHT_CM_MIN || height > HEIGHT_CM_MAX) {
    return null;
  }

  return height;
}

/**
 * 所有者の確定プロフィールから身長(cm)を読む。
 *
 * プロフィール行は `on_auth_user_created`（実装仕様書 6.2節）が必ず作るが、
 * 確定前は `settings` が空オブジェクトなので `null` を返す。
 */
export async function readConfirmedHeightCm(
  supabase: SupabaseClient,
  ownerId: string,
): Promise<GuardResult<number | null>> {
  const { data, error } = await supabase
    .from("user_profiles")
    .select("settings")
    .eq("owner_id", ownerId)
    .maybeSingle();

  if (error) {
    return { ok: false, response: invalidRequest("プロフィールを取得できませんでした。") };
  }
  if (data === null) {
    return { ok: true, value: null };
  }

  return { ok: true, value: readHeightCmFromSettings((data as { settings: unknown }).settings) };
}

/** 実装仕様書 5.3節の BMI。身長・体重のどちらかが欠ければ `null`。 */
export function deriveBmi(
  weightKilograms: number | null,
  heightCentimeters: number | null,
): number | null {
  if (weightKilograms === null || heightCentimeters === null) {
    return null;
  }
  return calculateBmi(weightKilograms, heightCentimeters);
}
