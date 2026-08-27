/**
 * `GET /api/account/export` — アカウントデータ出力（実装仕様書 5.1節 / 7章）。
 *
 * 共通境界の適用順:
 *   1. same-origin 検証（実装仕様書 7章）
 *   2. Supabase未設定 → 503 / 未認証 → 401 / 非active → 403（実装仕様書 3.3節・5.1節）
 *   3. 直近の再認証（実装仕様書 5.1節）
 *   4. 所有者スコープの読み出し（UIDは検証済みセッション由来。ボディの所有者IDは使わない）
 *
 * TODO(Phase 3以降): 出力対象を全機能テーブルへ広げ、1テーブル25,000行／
 * 合計100,000行／ページサイズ500行の上限とページングを実装する
 * （`src/server/account/export.ts` の定数を使用）。
 */

import type { NextRequest } from "next/server";

import { exportFormatSchema } from "@/features/auth/schema";

import {
  ACCOUNT_EXPORT_TABLES,
  exportFileName,
  toMultiTableCsv,
  type AccountExportPayload,
} from "@/server/account/export";
import { invalidRequest, NO_STORE_HEADERS } from "@/server/api/errors";
import { guardMutationRequest } from "@/server/api/guards";
import { requireRecentReauthentication } from "@/server/api/reauthentication";
import { requireActiveUser } from "@/server/api/session";

export async function GET(request: NextRequest): Promise<Response> {
  // GET なのでボディのContent-Type要求は課さない（実装仕様書 7章は状態変更時の要求）。
  // same-origin 検証は実装仕様書 5.1節が出力にも要求している。
  const guard = guardMutationRequest(request, { requireJsonBody: false });
  if (!guard.ok) {
    return guard.response;
  }

  const parsedFormat = exportFormatSchema.safeParse(
    new URL(request.url).searchParams.get("format") ?? "json",
  );
  if (!parsedFormat.success) {
    return invalidRequest("format は json または csv を指定してください。");
  }
  const format = parsedFormat.data;

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const reauthentication = await requireRecentReauthentication(auth.user.supabase);
  if (!reauthentication.ok) {
    return reauthentication.response;
  }

  const tables: Record<string, readonly Record<string, unknown>[]> = {};
  for (const table of ACCOUNT_EXPORT_TABLES) {
    // 所有者の絞り込みは検証済みセッションのUIDから導出する（実装仕様書 3.2節）。
    // RLS が最終防衛線として同じ条件を再度課す（実装仕様書 6.5節）。
    const { data, error } = await auth.user.supabase
      .from(table)
      .select("*")
      .eq("owner_id", auth.user.id);

    if (error) {
      return invalidRequest("データを出力できませんでした。");
    }

    tables[table] = data ?? [];
  }

  const now = new Date();
  const headers = new Headers(NO_STORE_HEADERS);
  headers.set("Content-Disposition", `attachment; filename="${exportFileName(format, now)}"`);

  if (format === "csv") {
    headers.set("Content-Type", "text/csv; charset=utf-8");
    return new Response(toMultiTableCsv(tables), { status: 200, headers });
  }

  const payload: AccountExportPayload = {
    exportedAt: now.toISOString(),
    schemaVersion: 1,
    tables,
  };

  headers.set("Content-Type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(payload), { status: 200, headers });
}
