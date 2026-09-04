/**
 * 睡眠・水分・体調フロントエンド用の API クライアント。
 *
 * `docs/api/wellness.md` で確定した契約だけを前提にし、相対 URL で
 * `fetch` する（実装仕様書 7章の same-origin 検証に合わせる）。
 */

import {
  apiErrorResponseSchema,
  deleteWellnessResponseSchema,
  saveWellnessResponseSchema,
  wellnessListResponseSchema,
  type ApiErrorResponse,
  type DeleteWellnessRequest,
  type SaveWellnessRequest,
  type SaveWellnessResponse,
  type WellnessListQuery,
  type WellnessListResponse,
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

export async function listWellness(
  query: WellnessListQuery,
): Promise<ApiResult<WellnessListResponse["data"]>> {
  const q = buildQueryString({
    resource: query.resource,
    id: query.id,
    from: query.from,
    to: query.to,
    order: query.order,
    limit: query.limit,
    cursor: query.cursor,
    sleepKind: query.sleepKind,
    beverageTypeId: query.beverageTypeId,
  });
  return apiGet(`/api/wellness${q}`, (json) => wellnessListResponseSchema.parse(json).data);
}

export async function saveWellness(
  request: SaveWellnessRequest,
): Promise<ApiResult<SaveWellnessResponse["data"]>> {
  return apiPost("/api/wellness", request, (json) => saveWellnessResponseSchema.parse(json).data);
}

export async function deleteWellness(
  request: DeleteWellnessRequest,
): Promise<ApiResult<{ resource: string; deletedId: string }>> {
  return apiDelete(
    "/api/wellness",
    request,
    (json) => deleteWellnessResponseSchema.parse(json).data,
  );
}
