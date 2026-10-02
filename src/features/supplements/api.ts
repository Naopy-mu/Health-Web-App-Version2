/**
 * サプリメントフロントエンド用の API クライアント。
 *
 * `docs/api/supplements.md` で確定した契約だけを前提にし、相対 URL で
 * `fetch` する（実装仕様書 7章の same-origin 検証に合わせる）。
 */

import {
  apiErrorResponseSchema,
  deleteSupplementResponseSchema,
  saveSupplementResponseSchema,
  supplementListResponseSchema,
  type ApiErrorResponse,
  type DeleteSupplementRequest,
  type SaveSupplementRequest,
  type SaveSupplementResponse,
  type SupplementListQuery,
  type SupplementListResponse,
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

export async function listSupplements(
  query: SupplementListQuery,
): Promise<ApiResult<SupplementListResponse["data"]>> {
  const q = buildQueryString({
    resource: query.resource,
    id: query.id,
    from: query.from,
    to: query.to,
    order: query.order,
    limit: query.limit,
    cursor: query.cursor,
    productId: query.productId,
    status: query.status,
  });
  return apiGet(`/api/supplements${q}`, (json) => supplementListResponseSchema.parse(json).data);
}

export async function saveSupplement(
  request: SaveSupplementRequest,
): Promise<ApiResult<SaveSupplementResponse["data"]>> {
  return apiPost(
    "/api/supplements",
    request,
    (json) => saveSupplementResponseSchema.parse(json).data,
  );
}

export async function deleteSupplement(
  request: DeleteSupplementRequest,
): Promise<ApiResult<{ resource: string; deletedId: string }>> {
  return apiDelete(
    "/api/supplements",
    request,
    (json) => deleteSupplementResponseSchema.parse(json).data,
  );
}
