// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import { API_ERROR_CODES } from "./errors";
import {
  exceedsDeclaredBodyLimit,
  guardMutationRequest,
  isJsonContentType,
  isSameOriginRequest,
  MAX_REQUEST_BODY_BYTES,
  readJsonBody,
} from "./guards";

/**
 * 実装仕様書 7章:
 * > すべてのRoute Handlerは、状態変更時に same-origin検証 と
 * > `Content-Type: application/json` の要求、リクエストボディ64KiB上限、
 * > `Cache-Control: no-store` の応答ヘッダーを適用する。
 */

const APP_ORIGIN = "https://app.example";

const makeRequest = (init: {
  method?: string;
  headers?: Record<string, string>;
  body?: BodyInit;
}) =>
  new Request(`${APP_ORIGIN}/api/account/data`, {
    method: init.method ?? "POST",
    headers: init.headers,
    body: init.body,
  });

const readErrorBody = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("same-origin 検証（実装仕様書 7章）", () => {
  it("Origin がアプリのオリジンと一致すれば通す", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    expect(isSameOriginRequest(makeRequest({ headers: { origin: APP_ORIGIN } }))).toBe(true);
  });

  it("別オリジンの Origin を拒否する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    for (const origin of [
      "https://evil.example",
      "http://app.example",
      "https://app.example.evil.example",
      "null",
    ]) {
      expect(isSameOriginRequest(makeRequest({ headers: { origin } })), origin).toBe(false);
    }
  });

  it("Origin が無い場合は Sec-Fetch-Site: same-origin を要求する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    expect(isSameOriginRequest(makeRequest({ headers: { "sec-fetch-site": "same-origin" } }))).toBe(
      true,
    );
    expect(isSameOriginRequest(makeRequest({ headers: { "sec-fetch-site": "cross-site" } }))).toBe(
      false,
    );
    expect(isSameOriginRequest(makeRequest({ headers: { "sec-fetch-site": "none" } }))).toBe(false);
  });

  it("Origin も Sec-Fetch-Site も無いリクエストを拒否する（フェイルクローズ）", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    expect(isSameOriginRequest(makeRequest({}))).toBe(false);
  });

  it("NEXT_PUBLIC_APP_URL 未設定ならリクエストURL自身のオリジンと比較する", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    expect(isSameOriginRequest(makeRequest({ headers: { origin: APP_ORIGIN } }))).toBe(true);
    expect(isSameOriginRequest(makeRequest({ headers: { origin: "https://evil.example" } }))).toBe(
      false,
    );
  });

  it("guardMutationRequest は別オリジンへ 403 SAME_ORIGIN_REQUIRED を返す", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    const result = guardMutationRequest(
      makeRequest({
        headers: { origin: "https://evil.example", "content-type": "application/json" },
      }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.SAME_ORIGIN_REQUIRED,
    );
  });
});

describe("Content-Type 検証（実装仕様書 7章）", () => {
  it("application/json（charset付きを含む）を受け付ける", () => {
    for (const contentType of [
      "application/json",
      "application/json; charset=utf-8",
      "APPLICATION/JSON",
      " application/json ",
    ]) {
      expect(
        isJsonContentType(makeRequest({ headers: { "content-type": contentType } })),
        contentType,
      ).toBe(true);
    }
  });

  it("JSON以外を拒否する", () => {
    for (const contentType of [
      "text/plain",
      "application/x-www-form-urlencoded",
      "multipart/form-data; boundary=x",
      "application/json-patch+json",
    ]) {
      expect(
        isJsonContentType(makeRequest({ headers: { "content-type": contentType } })),
        contentType,
      ).toBe(false);
    }
  });

  it("Content-Type が無い状態変更リクエストへ 415 JSON_REQUIRED を返す", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    const result = guardMutationRequest(makeRequest({ headers: { origin: APP_ORIGIN } }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(415);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(API_ERROR_CODES.JSON_REQUIRED);
  });

  it("requireJsonBody: false（GETの出力など）では Content-Type を要求しない", () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
    const result = guardMutationRequest(makeRequest({ headers: { origin: APP_ORIGIN } }), {
      requireJsonBody: false,
    });
    expect(result.ok).toBe(true);
  });
});

describe("リクエストボディ 64KiB 上限（実装仕様書 7章）", () => {
  it("上限は 65536 バイト", () => {
    expect(MAX_REQUEST_BODY_BYTES).toBe(65_536);
  });

  it("Content-Length が上限を超えると宣言だけで拒否する", () => {
    expect(
      exceedsDeclaredBodyLimit(
        makeRequest({ headers: { "content-length": String(MAX_REQUEST_BODY_BYTES + 1) } }),
      ),
    ).toBe(true);
    expect(
      exceedsDeclaredBodyLimit(
        makeRequest({ headers: { "content-length": String(MAX_REQUEST_BODY_BYTES) } }),
      ),
    ).toBe(false);
  });

  it("上限ちょうどのボディは読み取れる", async () => {
    // {"v":"..."} の形で全体がちょうど 64KiB になるように詰める。
    const overhead = '{"v":""}'.length;
    const payload = { v: "a".repeat(MAX_REQUEST_BODY_BYTES - overhead) };
    const body = JSON.stringify(payload);
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_REQUEST_BODY_BYTES);

    const result = await readJsonBody(
      makeRequest({ headers: { "content-type": "application/json" }, body }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toStrictEqual(payload);
  });

  it("上限を1バイト超えるボディへ 413 PAYLOAD_TOO_LARGE を返す", async () => {
    const overhead = '{"v":""}'.length;
    const body = JSON.stringify({ v: "a".repeat(MAX_REQUEST_BODY_BYTES - overhead + 1) });
    expect(new TextEncoder().encode(body).byteLength).toBe(MAX_REQUEST_BODY_BYTES + 1);

    const result = await readJsonBody(
      makeRequest({ headers: { "content-type": "application/json" }, body }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");
    expect((await readErrorBody(result.response)).error.code).toBe(
      API_ERROR_CODES.PAYLOAD_TOO_LARGE,
    );
  });

  it("Content-Length を偽装しても実バイト数で拒否する", async () => {
    const request = new Request(`${APP_ORIGIN}/api/account/data`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ v: "a".repeat(MAX_REQUEST_BODY_BYTES) }),
    });
    // Content-Length は fetch API 側が実体から決めるため、宣言前判定は通過する。
    expect(exceedsDeclaredBodyLimit(request)).toBe(false);

    const result = await readJsonBody(request);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
  });

  it("マルチバイト文字はバイト数で数える", async () => {
    // 「あ」は UTF-8 で3バイト。文字数では上限内でもバイト数では超える。
    const characterCount = Math.ceil(MAX_REQUEST_BODY_BYTES / 3);
    const body = JSON.stringify({ v: "あ".repeat(characterCount) });

    const result = await readJsonBody(
      makeRequest({ headers: { "content-type": "application/json" }, body }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(413);
  });

  it("JSONとして解釈できないボディへ 400 INVALID_REQUEST を返す", async () => {
    const result = await readJsonBody(
      makeRequest({ headers: { "content-type": "application/json" }, body: "{not json" }),
    );

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect((await readErrorBody(result.response)).error.code).toBe(API_ERROR_CODES.INVALID_REQUEST);
  });

  it("空ボディは undefined として通す", async () => {
    const result = await readJsonBody(makeRequest({ method: "DELETE" }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toBeUndefined();
  });
});
