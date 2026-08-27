/**
 * `POST /api/measurements/types` — 測定種別の追加・既定投入（実装仕様書 5.3節 / 7章）。
 *
 * > 測定種別と測定目標は `/api/measurements/types`、`/api/measurements/goals` で
 * > 管理し、既定種別は `seed_default_body_measurement_types` RPCで投入する。
 *
 * `action` で分岐する。
 *   - `seed_defaults`: 既定10種別を冪等に投入する（何度呼んでも同じ結果）
 *   - `create`: カスタム種別を1件追加する
 *
 * 種別の**一覧取得は `GET /api/measurements` の `data.types`** で返す
 * （画面の初期表示で記録と種別を1往復にまとめるため）。
 * 種別の削除は用意しない。無効化は `archived_at` の更新で行う
 * （既定種別はDB側でアーカイブ不可）。
 */

import type { NextRequest } from "next/server";

import { measurementTypeRequestSchema } from "@/features/body-measurements/schema";

import { guardMutationRequest, readJsonBody } from "@/server/api/guards";
import { jsonData } from "@/server/api/responses";
import { requireActiveUser } from "@/server/api/session";
import { parseRequestBody } from "@/server/body-measurements/request";
import { createType, seedDefaultTypes } from "@/server/body-measurements/repository";

export async function POST(request: NextRequest): Promise<Response> {
  const guard = guardMutationRequest(request);
  if (!guard.ok) {
    return guard.response;
  }

  const body = await readJsonBody(request);
  if (!body.ok) {
    return body.response;
  }

  const parsed = parseRequestBody(measurementTypeRequestSchema, body.value);
  if (!parsed.ok) {
    return parsed.response;
  }

  const auth = await requireActiveUser();
  if (!auth.ok) {
    return auth.response;
  }

  if (parsed.value.action === "seed_defaults") {
    const seeded = await seedDefaultTypes(auth.user.supabase);
    if (!seeded.ok) {
      return seeded.response;
    }
    return jsonData({ types: seeded.value, outcome: "seeded" });
  }

  const created = await createType(
    auth.user.supabase,
    auth.user.id,
    parsed.value.type,
    parsed.value.clientMutationId,
  );
  if (!created.ok) {
    return created.response;
  }

  return jsonData(
    { types: [created.value.type], outcome: created.value.outcome },
    created.value.outcome === "created" ? 201 : 200,
  );
}
