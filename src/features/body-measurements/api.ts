/**
 * 身体測定フロントエンド用の API クライアント。
 *
 * `docs/api/measurements.md` で確定した契約だけを前提にし、相対 URL で
 * `fetch` する（実装仕様書 7章の same-origin 検証に合わせる）。
 */

import {
  apiErrorResponseSchema,
  archiveMeasurementTypeResponseSchema,
  deleteResponseSchema,
  measurementGoalListResponseSchema,
  measurementListResponseSchema,
  measurementTypeResponseSchema,
  saveMeasurementGoalResponseSchema,
  saveMeasurementResponseSchema,
  type ApiErrorResponse,
  type ArchiveMeasurementTypeRequest,
  type ArchiveMeasurementTypeResponse,
  type DeleteMeasurementGoalRequest,
  type DeleteMeasurementRequest,
  type DeleteResponse,
  type MeasurementGoalListQuery,
  type MeasurementGoalListResponse,
  type MeasurementListQuery,
  type MeasurementListResponse,
  type MeasurementTypeRequest,
  type MeasurementTypeResponse,
  type SaveMeasurementGoalRequest,
  type SaveMeasurementGoalResponse,
  type SaveMeasurementRequest,
  type SaveMeasurementResponse,
} from "./schema";

export type ApiError = ApiErrorResponse["error"];

type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError; status: number };

const NETWORK_ERROR: ApiError = {
  code: "NETWORK_ERROR",
  message: "通信に失敗しました。オフラインの可能性があります。",
};

function buildQueryString(query: Record<string, string | number | undefined>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) {
      continue;
    }
    params.set(key, String(value));
  }
  const serialized = params.toString();
  return serialized ? `?${serialized}` : "";
}

async function parseError(response: Response): Promise<ApiError> {
  try {
    const json = (await response.json()) as unknown;
    const parsed = apiErrorResponseSchema.parse(json);
    return parsed.error;
  } catch {
    return { code: "UNKNOWN_ERROR", message: `HTTP ${response.status}` };
  }
}

async function apiGet<T>(url: string, parser: (data: unknown) => T): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "GET",
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      return { ok: false, error: await parseError(response), status: response.status };
    }
    const json = (await response.json()) as unknown;
    return { ok: true, data: parser(json) };
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
}

async function apiPost<T>(
  url: string,
  body: unknown,
  parser: (data: unknown) => T,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, error: await parseError(response), status: response.status };
    }
    const json = (await response.json()) as unknown;
    return { ok: true, data: parser(json) };
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
}

async function apiPatch<T>(
  url: string,
  body: unknown,
  parser: (data: unknown) => T,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, error: await parseError(response), status: response.status };
    }
    const json = (await response.json()) as unknown;
    return { ok: true, data: parser(json) };
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
}

async function apiDelete<T>(
  url: string,
  body: unknown,
  parser: (data: unknown) => T,
): Promise<ApiResult<T>> {
  try {
    const response = await fetch(url, {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      return { ok: false, error: await parseError(response), status: response.status };
    }
    const json = (await response.json()) as unknown;
    return { ok: true, data: parser(json) };
  } catch {
    return { ok: false, error: NETWORK_ERROR, status: 0 };
  }
}

export async function listMeasurements(
  query: MeasurementListQuery,
): Promise<ApiResult<MeasurementListResponse["data"]>> {
  const q = buildQueryString({
    typeId: query.typeId,
    measurementKey: query.measurementKey,
    from: query.from,
    to: query.to,
    order: query.order,
    limit: query.limit,
    cursor: query.cursor,
  });
  return apiGet(`/api/measurements${q}`, (json) => measurementListResponseSchema.parse(json).data);
}

export async function saveMeasurement(
  request: SaveMeasurementRequest,
): Promise<ApiResult<SaveMeasurementResponse["data"]>> {
  return apiPost(
    "/api/measurements",
    request,
    (json) => saveMeasurementResponseSchema.parse(json).data,
  );
}

export async function deleteMeasurement(
  request: DeleteMeasurementRequest,
): Promise<ApiResult<DeleteResponse["data"]>> {
  return apiDelete("/api/measurements", request, (json) => deleteResponseSchema.parse(json).data);
}

export async function seedDefaultTypes(): Promise<ApiResult<MeasurementTypeResponse["data"]>> {
  return apiPost(
    "/api/measurements/types",
    { action: "seed_defaults" },
    (json) => measurementTypeResponseSchema.parse(json).data,
  );
}

export async function createMeasurementType(
  request: Extract<MeasurementTypeRequest, { action: "create" }>,
): Promise<ApiResult<MeasurementTypeResponse["data"]>> {
  return apiPost(
    "/api/measurements/types",
    request,
    (json) => measurementTypeResponseSchema.parse(json).data,
  );
}

export async function archiveMeasurementType(
  id: string,
  request: ArchiveMeasurementTypeRequest,
): Promise<ApiResult<ArchiveMeasurementTypeResponse["data"]>> {
  return apiPatch(
    `/api/measurements/types/${id}`,
    request,
    (json) => archiveMeasurementTypeResponseSchema.parse(json).data,
  );
}

export async function listGoals(
  query: MeasurementGoalListQuery,
): Promise<ApiResult<MeasurementGoalListResponse["data"]>> {
  const q = buildQueryString({
    typeId: query.typeId,
    includeAchieved: query.includeAchieved ? "true" : "false",
  });
  return apiGet(
    `/api/measurements/goals${q}`,
    (json) => measurementGoalListResponseSchema.parse(json).data,
  );
}

export async function saveGoal(
  request: SaveMeasurementGoalRequest,
): Promise<ApiResult<SaveMeasurementGoalResponse["data"]>> {
  return apiPost(
    "/api/measurements/goals",
    request,
    (json) => saveMeasurementGoalResponseSchema.parse(json).data,
  );
}

export async function deleteGoal(
  request: DeleteMeasurementGoalRequest,
): Promise<ApiResult<DeleteResponse["data"]>> {
  return apiDelete(
    "/api/measurements/goals",
    request,
    (json) => deleteResponseSchema.parse(json).data,
  );
}
