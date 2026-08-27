/**
 * Next.js プロキシ（実装仕様書 3.3節）。
 *
 * > 保護ルート ... は、プロキシ（`src/lib/supabase/proxy.ts` の
 * > `protectedRoutePrefixes`）でセッションと利用者状態を確認する。
 *
 * Next.js 16 では従来の `middleware` 規約が `proxy` へ置き換わっている。
 * 実際の判定は `src/lib/supabase/proxy.ts` に集約し、ここは入口だけを持つ。
 */

import type { NextRequest } from "next/server";

import { updateSupabaseSession } from "@/lib/supabase/proxy";

export async function proxy(request: NextRequest) {
  return updateSupabaseSession(request);
}

export const config = {
  matcher: [
    /**
     * 静的アセットとPWAの配布物を除く全ルート。
     * Route Handler（`/api/*`、`/auth/callback` 等）も通し、Cookieの
     * トークン更新が失われないようにする。
     */
    "/((?!_next/static|_next/image|favicon.ico|sw.js|manifest.webmanifest|.*\.(?:svg|png|jpg|jpeg|gif|webp|ico|avif|txt|xml)$).*)",
  ],
};
