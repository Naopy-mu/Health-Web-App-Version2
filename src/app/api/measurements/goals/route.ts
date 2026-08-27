/**
 * `/api/measurements/goals` — 測定目標の取得・保存・削除（実装仕様書 5.3節 / 7章）。
 *
 * グラフの目標線（実装仕様書 5.3節「表示: 推移グラフ、目標線、移動平均などの
 * トレンド、CSV出力」）の元になるデータ。
 *
 * 未達成（`achievedAt = null`）の目標は測定種別ごとに1件までで、
 * DB の部分一意インデックスが最終防衛線になる。2件目を作ろうとすると
 * 409（`MEASUREMENT_GOAL_CONFLICT`）を返す。既存の目標を更新するか、
 * `achievedAt` を設定して締めてから新しい目標を作る。
 *
 * 共通境界の適用順は `/api/measurements` と同じ（実装仕様書 7章）。
 */

import type { NextRequest } from "next/server";

import {
  deleteMeasurementGoalRequestSchema,
  measurementGoalListQuerySchema,
  saveMeasurementGoalRequestSchema,
} from "@/features/body-measurements/schema";

import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { parseQueryParams, parseRequestBody } from "@/server/body-measurements/request";
import {
  deleteGoal,
  listGoals,
  loadTypeCatalog,
  saveGoal,
} from "@/server/body-measurements/repository";

export async function GET(request: NextRequest): Promise<Response> {
  const guard = guardMutationRequest(request, { requireJsonBody: false });
  if (!guard.ok) {
    return guard.response;
  }

  const query = parseQueryParams(measurementGoalListQuerySchema, new URL(request.url).searchParams);
  if (!query.ok) {
    return query.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const catalog = await loadTypeCatalog(auth.user.supabase, auth.user.id);
  if (!catalog.ok) {
    return catalog.response;
  }

  const goals = await listGoals(auth.user.supabase, auth.user.id, query.value, catalog.value);
  if (!goals.ok) {
    return goals.response;
  }

  return jsonData({ goals: goals.value });
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

  const parsed = parseRequestBody(saveMeasurementGoalRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const catalog = await loadTypeCatalog(auth.user.supabase, auth.user.id);
  if (!catalog.ok) {
    return catalog.response;
  }

  const saved = await saveGoal(
    auth.user.supabase,
    auth.user.id,
    parsed.value.goal,
    parsed.value.clientMutationId,
    catalog.value,
  );
  if (!saved.ok) {
    return saved.response;
  }

  return jsonData(
    { goal: saved.value.goal, outcome: saved.value.outcome },
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

  const parsed = parseRequestBody(deleteMeasurementGoalRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const deleted = await deleteGoal(
    auth.user.supabase,
    auth.user.id,
    parsed.value.goalId,
    parsed.value.expectedRowVersion,
  );
  if (!deleted.ok) {
    return deleted.response;
  }

  return jsonData(deleted.value);
}
