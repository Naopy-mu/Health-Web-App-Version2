/**
 * `DELETE /api/account/data` — 健康データのみ削除（実装仕様書 5.1節 / 7章）。
 *
 * Phase 2 では**共通境界・ボディ検証・認証・再認証チェックまで**を実装した骨格を置く。
 * ボディは `parseAccountDeleteRequest()` の `.strict()` 検証（所有者IDの持ち込み拒否を含む）
 * を通過した場合にのみ 501 へ到達する（実装仕様書 3.2節 / 9.2節）。
 * 削除対象の機能テーブルがまだ存在しないため、本体は 501 を返す。
 *
 * TODO(Phase 3以降、機能テーブルが揃ってから本実装する): 実装仕様書 5.1節の順序で
 *   1. identity を `health_data_erasure_pending` へ遷移させ新規書き込みを止める
 *      （`is_active_user()` が false になり、全RLSポリシーから排除される）
 *   2. Google接続の revoke（実装仕様書 5.11節）
 *   3. Storage実体の削除（実装仕様書 6.6節）
 *   4. 健康データ削除RPC（`service_role` 限定。実装仕様書 9.2節）
 *   5. `user_profiles` の初期化と identity を `active` へ戻す
 * を実行する。中断時は pending のまま安全に再試行できること。
 * 状態遷移と削除RPCの実行には `src/lib/supabase/admin.ts` の service_role
 * クライアントを使う。
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

  // 64KiB上限の実バイト数検査（実装仕様書 7章）。
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
    "健康データ削除は、対象となる機能テーブルの追加後に提供します（後続フェーズ）。",
  );
}
