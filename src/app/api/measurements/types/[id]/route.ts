/**
 * `PATCH /api/measurements/types/{id}` — 測定種別のアーカイブ／解除（実装仕様書 5.3節 / 7章）。
 *
 * > カスタム種別は**アーカイブ（`archived_at`）による無効化**のみを許可し、
 * > 削除（DELETE）は提供しない（既存の測定記録・目標を保護するため）。
 * > 既定種別はアーカイブも不可とする。アーカイブ済み種別に対する新規の
 * > 測定記録・目標登録は拒否する。
 *
 * 種別を消さずに無効化するため、過去の測定記録・目標はそのまま残る。
 * アーカイブ済み種別への新規登録は `/api/measurements` と
 * `/api/measurements/goals` が 400 `MEASUREMENT_TYPE_ARCHIVED` で拒否する。
 *
 * 共通境界の適用順は `/api/measurements` と同じ（実装仕様書 7章）。
 */

import type { NextRequest } from "next/server";

import { archiveMeasurementTypeRequestSchema } from "@/features/body-measurements/schema";

import { invalidRequest, measurementTypeNotFound } from "@/server/api/errors";
import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { parseRequestBody } from "@/server/body-measurements/request";
import { archiveType, loadTypeCatalog } from "@/server/body-measurements/repository";

/** 実装仕様書 6.2節: IDは UUID。パスパラメータもDBへ渡す前に形を確かめる。 */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function PATCH(
  request: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<Response> {
  const guard = guardMutationRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  const { id } = await context.params;
  if (!UUID_PATTERN.test(id)) {
    return invalidRequest("測定種別IDの形式が正しくありません。");
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  const parsed = parseRequestBody(archiveMeasurementTypeRequestSchema, body.value);
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

  const type = catalog.value.byId.get(id);
  if (type === undefined) {
    return measurementTypeNotFound();
  }
  // 実装仕様書 5.3節「既定種別はアーカイブも不可とする」。
  // DB の CHECK 制約（`body_measurement_types_default_not_archived`）とトリガーも
  // 同じ形を拒否する。ここでは利用者に伝わる文言で先に返す。
  if (type.isDefault) {
    return invalidRequest("既定の測定種別はアーカイブできません。");
  }

  const updated = await archiveType(
    auth.user.supabase,
    auth.user.id,
    id,
    parsed.value.archived,
    parsed.value.expectedRowVersion,
    parsed.value.clientMutationId,
  );
  if (!updated.ok) {
    return updated.response;
  }

  return jsonData({ type: updated.value.type, outcome: updated.value.outcome });
}
