import "server-only";

/**
 * サーバー用 Supabase クライアント（実装仕様書 2.1節）。
 * Server Component / Route Handler / Server Action から使う。
 *
 * セッションはCookieに保持し、`getAll` / `setAll` の双方を実装する
 * （`@supabase/ssr` の要求。片方だけだとトークン更新が失われる）。
 * Server Component からはCookieを書けないため、書き込み失敗は握りつぶし、
 * セッション更新は `proxy.ts` のミドルウェアが担う。
 */

import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

import { getSupabaseClientConfig } from "./config";

/**
 * Supabase未設定時は `null` を返す。アカウント関連APIは 503
 * （`ACCOUNT_SERVICE_UNAVAILABLE`）を返すこと（実装仕様書 3.3節）。
 */
export async function createSupabaseServerClient(): Promise<SupabaseClient | null> {
  const config = getSupabaseClientConfig();
  if (!config) {
    return null;
  }

  const cookieStore = await cookies();

  return createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (cookiesToSet) => {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Server Component からは Cookie を書けない。ミドルウェア
          // （src/middleware.ts → proxy.ts）がセッションを更新する。
        }
      },
    },
  });
}
