import "server-only";

/**
 * サービスロール相当の鍵を使うサーバー専用クライアント（実装仕様書 9.2節）。
 *
 * このモジュールは `import "server-only"` によりクライアントバンドルへの
 * 混入を禁止する。`SUPABASE_SECRET_KEY` は `NEXT_PUBLIC_` を持たないため、
 * 参照した時点でクライアントコンポーネントから使えばビルドが失敗する。
 *
 * 用途はRLSを迂回する必要がある操作に限る（利用者状態の遷移、Auth Admin API
 * によるユーザー削除、破壊的な削除RPCなど。実装仕様書 5.1節・6.5節）。
 * 通常の所有者スコープの読み書きには `server.ts` のクライアントを使うこと。
 */

import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { getSupabaseClientConfig } from "./config";

/**
 * URL または秘密鍵が未設定なら `null`。呼び出し側は 503
 * （`ACCOUNT_SERVICE_UNAVAILABLE`）を返すこと（実装仕様書 3.3節）。
 */
export function createSupabaseAdminClient(): SupabaseClient | null {
  const config = getSupabaseClientConfig();
  const secretKey = process.env.SUPABASE_SECRET_KEY?.trim();

  if (!config || !secretKey) {
    return null;
  }

  return createClient(config.url, secretKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });
}
