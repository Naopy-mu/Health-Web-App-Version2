import "server-only";

/**
 * プロキシ（ミドルウェア）用 Supabase クライアントと保護ルートの判定
 * （実装仕様書 2.1節 / 3.3節）。
 *
 * > 保護ルート（`/records` `/measurements` `/workouts` `/meals` `/pantry`
 * > `/calendar` `/reports` `/settings` `/onboarding` `/auth/session` など）は、
 * > プロキシ（`src/lib/supabase/proxy.ts` の `protectedRoutePrefixes`）で
 * > セッションと利用者状態を確認する。
 *
 * ミドルウェアはあくまで**入口の絞り込み**であり、最終的な権限判定はRLSと
 * 各Route Handlerの `requireActiveUser()` が行う（実装仕様書 9.2節）。
 */

import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { buildSignInPath } from "@/features/auth/redirect";

import { getSupabaseClientConfig } from "./config";

/**
 * 実装仕様書 3.3節の保護ルートprefix。
 * 画面の追加時（実装仕様書 4章の表）にここも更新すること。
 */
export const protectedRoutePrefixes = [
  "/assistant",
  "/auth/session",
  "/calendar",
  "/condition",
  "/groceries",
  "/habits",
  "/hydration",
  "/measurements",
  "/meals",
  "/notifications",
  "/onboarding",
  "/pantry",
  "/records",
  "/reports",
  "/settings",
  "/sleep",
  "/supplements",
  "/workouts",
] as const;

/**
 * `pathname` が保護ルートに該当するか。
 * prefix 完全一致、または `prefix + "/"` で始まる場合のみ該当とする
 * （`/mealsomething` のような別ルートを巻き込まないため）。
 */
export function isProtectedPath(pathname: string): boolean {
  return protectedRoutePrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}

/** ログイン後に戻すための `next`（パス＋クエリ）を組み立てる。 */
function buildNextTarget(url: URL): string {
  return `${url.pathname}${url.search}`;
}

type SupabaseClientFactory = (request: NextRequest, response: NextResponse) => AuthenticationProbe;

/** ミドルウェアが必要とする最小の認証インターフェース。 */
type AuthenticationProbe = {
  getUser: () => Promise<{ data: { user: { id: string } | null } }>;
};

const defaultClientFactory: SupabaseClientFactory = (request, response) => {
  const config = getSupabaseClientConfig();
  if (!config) {
    throw new Error("Supabase is not configured");
  }

  const client = createServerClient(config.url, config.publishableKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet, headers) => {
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
        // 実装仕様書 9.2節 / `@supabase/ssr` の要求。認証Cookieを載せた応答は
        // CDN・リバースプロキシにキャッシュさせない。
        for (const [key, headerValue] of Object.entries(headers)) {
          response.headers.set(key, headerValue);
        }
      },
    },
  });

  return { getUser: () => client.auth.getUser() };
};

/**
 * セッションCookieを更新しつつ、保護ルートへの未認証アクセスをログインへ丸める。
 *
 * - Supabase未設定時（実装仕様書 3.3節）は保護ルートを `/auth` へ送る。
 *   画面側でデモモードへの導線を示す。
 * - 戻り先の `next` は `sanitizeNextPath` を通してから載せる（実装仕様書 5.1節）。
 */
export async function updateSupabaseSession(
  request: NextRequest,
  options: { createClient?: SupabaseClientFactory } = {},
): Promise<NextResponse> {
  const response = NextResponse.next({ request });
  const url = new URL(request.url);
  const protectedPath = isProtectedPath(url.pathname);

  const config = getSupabaseClientConfig();
  if (!config) {
    // 未設定では誰も認証されえない。保護ルートはログインへ丸める。
    return protectedPath
      ? NextResponse.redirect(new URL(buildSignInPath(buildNextTarget(url)), url))
      : response;
  }

  const createClient = options.createClient ?? defaultClientFactory;
  const supabase = createClient(request, response);

  // `@supabase/ssr` の要求どおり、応答を組み立てる前にセッションを解決して
  // Cookie更新を `setAll` から書き戻させる。
  let userId: string | null = null;
  try {
    const { data } = await supabase.getUser();
    userId = data.user?.id ?? null;
  } catch {
    // ネットワーク障害等でセッションを確認できない場合は未認証として扱う
    // （フェイルクローズ）。
    userId = null;
  }

  if (protectedPath && !userId) {
    return NextResponse.redirect(new URL(buildSignInPath(buildNextTarget(url)), url));
  }

  return response;
}
