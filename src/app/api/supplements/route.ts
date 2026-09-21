/**
 * `/api/supplements` — サプリメントの商品・予定・服用・在庫（実装仕様書 5.6節 / 7章）。
 *
 * 実装仕様書 7章の表:
 * > `/api/supplements` GET / POST 商品・予定・ロット・服用
 *
 * 予定と在庫ロットの削除は身体測定・睡眠と同じく DELETE で受ける。
 * 商品には DELETE を用意せず `archived` で無効化し、服用記録は削除ではなく
 * 取消（`resource: "void_intake"`）で扱う（実装仕様書 5.6節）。
 *
 * 共通境界の適用順（実装仕様書 7章 / 9.2節）:
 *   1. same-origin 検証（GET も含む。健康データを他オリジンから読ませない）
 *   2. `Content-Type: application/json` の要求（状態変更のみ）
 *   3. リクエストボディ64KiB上限（宣言値と実バイト数の双方）
 *   4. Zod `.strict()` 検証（所有者IDの持ち込み拒否を含む）
 *   5. Supabase未設定 → 503 / 未認証 → 401 / 非active → 403
 *   6. 所有者スコープの読み書き（UIDは検証済みセッション由来）
 *
 * 検証をDBに到達させる前に済ませ、応答は常に `Cache-Control: no-store`。
 * リクエスト／レスポンスの形は `src/features/supplements/schema.ts`、
 * 詳細は `docs/api/supplements.md`。
 */

import type { NextRequest } from "next/server";

import {
  deleteSupplementRequestSchema,
  saveSupplementRequestSchema,
  supplementListQuerySchema,
} from "@/features/supplements/schema";

import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { parseQueryParams, parseRequestBody } from "@/server/api/validation";
import {
  deleteSupplementRow,
  listIntakes,
  listLots,
  listMovements,
  listSchedules,
  loadCatalog,
  loadSummary,
  recordIntake,
  saveLot,
  saveProduct,
  saveSchedule,
  voidIntake,
} from "@/server/supplements/repository";

export async function GET(request: NextRequest): Promise<Response> {
  // GET はボディを持たないため Content-Type の要求は課さない（実装仕様書 7章）。
  const guard = guardMutationRequest(request, { requireJsonBody: false });
  if (!guard.ok) {
    return guard.response;
  }

  const query = parseQueryParams(supplementListQuerySchema, new URL(request.url).searchParams);
  if (!query.ok) {
    return query.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { supabase, id: ownerId } = auth.user;

  const catalog = await loadCatalog(supabase, ownerId);
  if (!catalog.ok) {
    return catalog.response;
  }

  const summary = await loadSummary(supabase);
  if (!summary.ok) {
    return summary.response;
  }

  // 商品は**どの応答にも全件入る**（記録・予定・ロットのラベル解決に要るため）。
  // 409 のあとの商品の対象特定もここから `id` で引けばよく、追加の取得は要らない
  // （docs/api/supplements.md 1.8節）。
  const common = {
    products: catalog.value.all,
    summary: summary.value,
  };

  const page = (nextCursor: string | null) => ({
    limit: query.value.limit,
    order: query.value.order,
    nextCursor,
  });

  // `id` を指定した取得は主キーの1件取得（docs/api/supplements.md 1.8節）。
  // 一覧の `limit` にも日時・商品の絞り込みにも依存しないので、409 のあとに
  // 対象行を必ず特定できる。0件は「本当に存在しない」を意味する。
  if (query.value.resource === "schedule") {
    const list = await listSchedules(supabase, ownerId, query.value, catalog.value);
    if (!list.ok) {
      return list.response;
    }
    return jsonData({
      resource: "schedule" as const,
      entries: list.value.entries,
      ...common,
      page: page(list.value.nextCursor),
    });
  }

  if (query.value.resource === "lot") {
    const list = await listLots(supabase, ownerId, query.value, catalog.value);
    if (!list.ok) {
      return list.response;
    }
    return jsonData({
      resource: "lot" as const,
      entries: list.value.entries,
      ...common,
      page: page(list.value.nextCursor),
    });
  }

  if (query.value.resource === "movement") {
    const list = await listMovements(supabase, ownerId, query.value, catalog.value);
    if (!list.ok) {
      return list.response;
    }
    return jsonData({
      resource: "movement" as const,
      entries: list.value.entries,
      ...common,
      page: page(list.value.nextCursor),
    });
  }

  const list = await listIntakes(supabase, ownerId, query.value, catalog.value);
  if (!list.ok) {
    return list.response;
  }
  return jsonData({
    resource: "intake" as const,
    entries: list.value.entries,
    ...common,
    page: page(list.value.nextCursor),
  });
}

export async function POST(request: NextRequest): Promise<Response> {
  const guard = guardMutationRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  const parsed = parseRequestBody(saveSupplementRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { supabase, id: ownerId } = auth.user;
  const input = parsed.value;

  // どのリソースも商品カタログを必要とする（所有者検査・ラベル・低在庫判定）。
  const catalog = await loadCatalog(supabase, ownerId);
  if (!catalog.ok) {
    return catalog.response;
  }

  if (input.resource === "product") {
    const saved = await saveProduct(
      supabase,
      ownerId,
      input.product,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "product" as const, product: saved.value.product, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "schedule") {
    const saved = await saveSchedule(
      supabase,
      ownerId,
      input.schedule,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      {
        resource: "schedule" as const,
        schedule: saved.value.schedule,
        outcome: saved.value.outcome,
      },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "lot") {
    const saved = await saveLot(
      supabase,
      ownerId,
      input.lot,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      {
        resource: "lot" as const,
        lot: saved.value.lot,
        stock: saved.value.stock,
        outcome: saved.value.outcome,
      },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "intake") {
    const saved = await recordIntake(
      supabase,
      ownerId,
      input.intake,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      {
        resource: "intake" as const,
        intake: saved.value.intake,
        stock: saved.value.stock,
        outcome: saved.value.outcome,
      },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  const voided = await voidIntake(
    supabase,
    ownerId,
    input.void,
    input.clientMutationId,
    catalog.value,
  );
  if (!voided.ok) {
    return voided.response;
  }
  return jsonData({
    resource: "void_intake" as const,
    intake: voided.value.intake,
    stock: voided.value.stock,
    outcome: voided.value.outcome,
  });
}

export async function DELETE(request: NextRequest): Promise<Response> {
  const guard = guardMutationRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  const parsed = parseRequestBody(deleteSupplementRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const deleted = await deleteSupplementRow(
    auth.user.supabase,
    auth.user.id,
    parsed.value.resource,
    parsed.value.id,
    parsed.value.expectedRowVersion,
  );
  if (!deleted.ok) {
    return deleted.response;
  }

  return jsonData({ resource: parsed.value.resource, deletedId: deleted.value.deletedId });
}
