/**
 * `DELETE /api/account` — アカウント削除（実装仕様書 5.1節 / 7章）。
 *
 * Phase 2 では**共通境界・ボディ検証・認証・再認証チェックまで**を実装した骨格を置く。
 * ボディは `parseAccountDeleteRequest()` の `.strict()` 検証（所有者IDの持ち込み拒否を含む）
 * を通過した場合にのみ 501 へ到達する（実装仕様書 3.2節 / 9.2節）。
 * 削除対象の機能テーブル・Google連携・Storage実体がまだ無いため、本体は 501 を返す。
 *
 * TODO(Phase 3以降、機能テーブルが揃ってから本実装する): 実装仕様書 5.1節の順序で
 *   1. identity を `deletion_pending` へ遷移させる
 *   2. Google接続の revoke（実装仕様書 5.11節）
 *   3. Storage実体の削除（実装仕様書 6.6節）
 *   4. Auth Admin API による `auth.users` の削除
 *      → `public.users` への CASCADE で所有者スコープの全行が消える（実装仕様書 6.2節）
 *   5. セッション破棄
 * を実行する。中断時は pending のまま安全に再試行できること。
 * 2〜4 は `src/lib/supabase/admin.ts` の service_role クライアントで行い、
 * この経路以外から呼び出せないようにする（実装仕様書 9.2節）。
 */

import type { NextRequest } from "next/server";

import { parseAccountDeleteRequest } from "@/server/account/delete-request";
import { notImplemented } from "@/server/api/errors";
import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { requireRecentReauthentication } from "@/server/api/reauthentication";
import { requireActiveUser } from "@/server/api/session";

export async function DELETE(request: NextRequest): Promise<Response> {
  const guard = guardMutationRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  // 実装仕様書 3.2節 / 9.2節: 所有者IDの持ち込みを拒否し、`.strict()` を通す。
  // 本体が 501 の段階でも、検証を素通りして 501 へ到達させない。
  const parsedBody = parseAccountDeleteRequest(body.value);
  if (!parsedBody.ok) {
    return parsedBody.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const reauthentication = await requireRecentReauthentication(auth.user.supabase);
  if (!reauthentication.ok) {
    return reauthentication.response;
  }

  return notImplemented(
    "アカウント削除は、対象となる機能テーブル・連携・Storageの追加後に提供します（後続フェーズ）。",
  );
}
