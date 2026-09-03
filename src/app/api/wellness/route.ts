/**
 * `/api/wellness` — 睡眠・水分・体調の取得・保存・削除（実装仕様書 5.5節 / 7章）。
 *
 * 実装仕様書 7章の表:
 * > `/api/wellness` GET / POST 睡眠・水分・体調・目標・種別
 *
 * 記録の削除は身体測定（`/api/measurements`）と同じく DELETE で受ける。
 * 種別（飲み物・症状）には DELETE を用意せず、`archived` による無効化のみ許す
 * （過去の記録を守るため。実装仕様書 5.3節の方針を 5.5節へ適用）。
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
 * リクエスト／レスポンスの形は `src/features/wellness/schema.ts`、
 * 詳細は `docs/api/wellness.md`。
 */

import type { NextRequest } from "next/server";

import {
  deleteWellnessRequestSchema,
  saveWellnessRequestSchema,
  wellnessListQuerySchema,
  type HydrationGoal,
  type SleepGoal,
  type WellnessContext,
} from "@/features/wellness/schema";

import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { parseQueryParams, parseRequestBody } from "@/server/api/validation";
import {
  deleteWellnessRow,
  listConditionEntries,
  listHydrationEntries,
  listHydrationGoals,
  listSleepEntries,
  listSleepGoals,
  loadCatalogs,
  saveBeverageType,
  saveConditionEntry,
  saveHydrationEntry,
  saveHydrationGoal,
  saveSleepEntry,
  saveSleepGoal,
  saveSymptomType,
  seedDefaults,
} from "@/server/wellness/repository";

/**
 * 「現在有効な目標」は終了日の無い目標（所有者ごとに1件。migration の
 * 部分一意インデックスが保証する）。画面上部の目標表示に使う。
 */
function buildContext(
  sleepGoals: readonly SleepGoal[],
  hydrationGoals: readonly HydrationGoal[],
): WellnessContext {
  return {
    activeSleepGoal: sleepGoals.find((goal) => goal.endDate === null) ?? null,
    activeHydrationGoal: hydrationGoals.find((goal) => goal.endDate === null) ?? null,
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  // GET はボディを持たないため Content-Type の要求は課さない（実装仕様書 7章）。
  const guard = guardMutationRequest(request, { requireJsonBody: false });
  if (!guard.ok) {
    return guard.response;
  }

  const query = parseQueryParams(wellnessListQuerySchema, new URL(request.url).searchParams);
  if (!query.ok) {
    return query.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { supabase, id: ownerId } = auth.user;

  const catalog = await loadCatalogs(supabase, ownerId);
  if (!catalog.ok) {
    return catalog.response;
  }

  const sleepGoals = await listSleepGoals(supabase, ownerId);
  if (!sleepGoals.ok) {
    return sleepGoals.response;
  }

  const hydrationGoals = await listHydrationGoals(supabase, ownerId);
  if (!hydrationGoals.ok) {
    return hydrationGoals.response;
  }

  const common = {
    beverageTypes: catalog.value.beverages.all,
    symptomTypes: catalog.value.symptoms.all,
    sleepGoals: sleepGoals.value,
    hydrationGoals: hydrationGoals.value,
    context: buildContext(sleepGoals.value, hydrationGoals.value),
  };

  const page = (nextCursor: string | null) => ({
    limit: query.value.limit,
    order: query.value.order,
    nextCursor,
  });

  if (query.value.resource === "hydration") {
    const list = await listHydrationEntries(supabase, ownerId, query.value, catalog.value);
    if (!list.ok) {
      return list.response;
    }
    return jsonData({
      resource: "hydration" as const,
      entries: list.value.entries,
      ...common,
      page: page(list.value.nextCursor),
    });
  }

  if (query.value.resource === "condition") {
    const list = await listConditionEntries(supabase, ownerId, query.value, catalog.value);
    if (!list.ok) {
      return list.response;
    }
    return jsonData({
      resource: "condition" as const,
      entries: list.value.entries,
      ...common,
      page: page(list.value.nextCursor),
    });
  }

  const list = await listSleepEntries(supabase, ownerId, query.value);
  if (!list.ok) {
    return list.response;
  }
  return jsonData({
    resource: "sleep" as const,
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

  const parsed = parseRequestBody(saveWellnessRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const { supabase, id: ownerId } = auth.user;
  const input = parsed.value;

  // 既定投入は冪等（何度呼んでも増えない）。冪等キーを取らない。
  if (input.resource === "seed_defaults") {
    const seeded = await seedDefaults(supabase);
    if (!seeded.ok) {
      return seeded.response;
    }
    return jsonData({
      resource: "seed_defaults" as const,
      beverageTypes: seeded.value.beverageTypes,
      symptomTypes: seeded.value.symptomTypes,
      outcome: "seeded" as const,
    });
  }

  // 睡眠と目標は種別カタログを必要としない。無駄な往復を避けて分岐する。
  if (input.resource === "sleep") {
    const saved = await saveSleepEntry(supabase, ownerId, input.entry, input.clientMutationId);
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "sleep" as const, entry: saved.value.entry, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "sleep_goal") {
    const saved = await saveSleepGoal(supabase, ownerId, input.goal, input.clientMutationId);
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "sleep_goal" as const, goal: saved.value.goal, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "hydration_goal") {
    const saved = await saveHydrationGoal(supabase, ownerId, input.goal, input.clientMutationId);
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      {
        resource: "hydration_goal" as const,
        goal: saved.value.goal,
        outcome: saved.value.outcome,
      },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  const catalog = await loadCatalogs(supabase, ownerId);
  if (!catalog.ok) {
    return catalog.response;
  }

  if (input.resource === "hydration") {
    const saved = await saveHydrationEntry(
      supabase,
      ownerId,
      input.entry,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "hydration" as const, entry: saved.value.entry, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "condition") {
    const saved = await saveConditionEntry(
      supabase,
      ownerId,
      input.entry,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "condition" as const, entry: saved.value.entry, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  if (input.resource === "beverage_type") {
    const saved = await saveBeverageType(
      supabase,
      ownerId,
      input.type,
      input.clientMutationId,
      catalog.value,
    );
    if (!saved.ok) {
      return saved.response;
    }
    return jsonData(
      { resource: "beverage_type" as const, type: saved.value.type, outcome: saved.value.outcome },
      saved.value.outcome === "created" ? 201 : 200,
    );
  }

  const saved = await saveSymptomType(
    supabase,
    ownerId,
    input.type,
    input.clientMutationId,
    catalog.value,
  );
  if (!saved.ok) {
    return saved.response;
  }
  return jsonData(
    { resource: "symptom_type" as const, type: saved.value.type, outcome: saved.value.outcome },
    saved.value.outcome === "created" ? 201 : 200,
  );
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

  const parsed = parseRequestBody(deleteWellnessRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const deleted = await deleteWellnessRow(
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
