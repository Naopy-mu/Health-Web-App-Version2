"use client";

/**
 * ブラウザ用 Supabase クライアント（実装仕様書 2.1節）。
 *
 * 公開設定（URL / publishable key）のみを使う。RLSは必須のままなので、
 * このクライアントから他利用者のデータへは到達できない（実装仕様書 6.5節）。
 * サービスロール鍵はこの経路に一切載せない（実装仕様書 9.2節）。
 */

import { createBrowserClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseClientConfig } from "./config";

/**
 * Supabase未設定時は `null` を返す。呼び出し側はデモモードへの導線を示すこと
 * （実装仕様書 3.3節）。
 */
export function createSupabaseBrowserClient(): SupabaseClient | null {
  const config = getSupabaseClientConfig();
  if (!config) {
    return null;
  }

  return createBrowserClient(config.url, config.publishableKey);
}
