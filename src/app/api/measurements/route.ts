/**
 * `/api/measurements` — 身体測定の取得・保存・削除（実装仕様書 5.3節 / 7章）。
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
 * リクエスト／レスポンスの形は `src/features/body-measurements/schema.ts`、
 * 詳細は `docs/api/measurements.md`。
 */

import type { NextRequest } from "next/server";

import {
  deleteMeasurementRequestSchema,
  measurementListQuerySchema,
  saveMeasurementRequestSchema,
  type MeasurementContext,
} from "@/features/body-measurements/schema";
import { WEIGHT_MEASUREMENT_KEY } from "@/features/body-measurements/defaults";

import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { deriveBmi, readConfirmedHeightCm } from "@/server/body-measurements/bmi";
import { ensureOwnedPhotoReference } from "@/server/body-measurements/photo-reference";
import { parseQueryParams, parseRequestBody } from "@/server/body-measurements/request";
import {
  deleteMeasurement,
  listMeasurements,
  loadTypeCatalog,
  readLatestWeightKilograms,
  saveMeasurement,
  type TypeCatalog,
} from "@/server/body-measurements/repository";

import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * 実装仕様書 5.3節の BMI 用の文脈。身長は確定プロフィール、体重は
 * 既定種別 `weight` の最新記録（kg 正規化済み）から取る。
 */
async function buildContext(
  supabase: SupabaseClient,
  ownerId: string,
  catalog: TypeCatalog,
): Promise<MeasurementContext> {
  const height = await readConfirmedHeightCm(supabase, ownerId);
  const heightCm = height.ok ? height.value : null;

  const weightType = catalog.byKey.get(WEIGHT_MEASUREMENT_KEY);
  if (weightType === undefined) {
    return { heightCm, latestWeightKg: null, latestWeightMeasuredAt: null, bmi: null };
  }

  const latest = await readLatestWeightKilograms(supabase, ownerId, weightType.id);
  const weight = latest.ok ? latest.value : null;

  return {
    heightCm,
    latestWeightKg: weight?.weightKg ?? null,
    latestWeightMeasuredAt: weight?.measuredAt ?? null,
    bmi: deriveBmi(weight?.weightKg ?? null, heightCm),
  };
}

export async function GET(request: NextRequest): Promise<Response> {
  // GET はボディを持たないため Content-Type の要求は課さない（実装仕様書 7章）。
  const guard = guardMutationRequest(request, { requireJsonBody: false });
  if (!guard.ok) {
    return guard.response;
  }

  const query = parseQueryParams(measurementListQuerySchema, new URL(request.url).searchParams);
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

  const page = await listMeasurements(auth.user.supabase, auth.user.id, query.value, catalog.value);
  if (!page.ok) {
    return page.response;
  }

  const context = await buildContext(auth.user.supabase, auth.user.id, catalog.value);

  return jsonData({
    measurements: page.value.measurements,
    types: catalog.value.all,
    context,
    page: {
      limit: query.value.limit,
      order: query.value.order,
      nextCursor: page.value.nextCursor,
    },
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

  const parsed = parseRequestBody(saveMeasurementRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  // 実装仕様書 5.3節 / 6.6節: `storage://` 参照は自分のパスだけ。
  const photo = ensureOwnedPhotoReference(parsed.value.measurement.photoReference, auth.user.id);
  if (!photo.ok) {
    return photo.response;
  }

  const catalog = await loadTypeCatalog(auth.user.supabase, auth.user.id);
  if (!catalog.ok) {
    return catalog.response;
  }

  const saved = await saveMeasurement(
    auth.user.supabase,
    auth.user.id,
    parsed.value.measurement,
    parsed.value.clientMutationId,
    catalog.value,
  );
  if (!saved.ok) {
    return saved.response;
  }

  // 実装仕様書 5.3節: 体重の記録には、確定プロフィールの身長から BMI を添える。
  const type = catalog.value.byId.get(saved.value.measurement.typeId);
  let derivedBmi: number | null = null;
  if (type?.unitConstraint === "mass" && saved.value.measurement.normalizedValue !== null) {
    const height = await readConfirmedHeightCm(auth.user.supabase, auth.user.id);
    derivedBmi = deriveBmi(
      saved.value.measurement.normalizedValue,
      height.ok ? height.value : null,
    );
  }

  return jsonData(
    { measurement: saved.value.measurement, outcome: saved.value.outcome, derivedBmi },
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

  const parsed = parseRequestBody(deleteMeasurementRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  const deleted = await deleteMeasurement(
    auth.user.supabase,
    auth.user.id,
    parsed.value.measurementId,
    parsed.value.expectedRowVersion,
  );
  if (!deleted.ok) {
    return deleted.response;
  }

  return jsonData(deleted.value);
}
