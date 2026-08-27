// @vitest-environment node
import { describe, expect, it } from "vitest";

import { API_ERROR_CODES } from "../api/errors";
import {
  accountDeleteRequestSchema,
  parseAccountDeleteRequest,
  REJECTED_OWNER_BODY_FIELDS,
} from "./delete-request";

/**
 * 実装仕様書 3.2節:
 * > 所有者IDは必ず検証済みサーバーセッションから導出し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。
 *
 * 実装仕様書 9.2節:
 * > 全入力をZodで検証し（`.strict()` で未知フィールドを拒否）……
 */

const readErrorBody = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

describe("parseAccountDeleteRequest（削除系APIのボディ検証）", () => {
  it("空ボディ（undefined / null）と空オブジェクトを受け付ける", () => {
    for (const body of [undefined, null, {}]) {
      const result = parseAccountDeleteRequest(body);
      expect(result.ok, JSON.stringify(body)).toBe(true);
      if (!result.ok) continue;
      expect(result.value).toStrictEqual({});
    }
  });

  it("所有者関連フィールドを拒否する（実装仕様書 3.2節）", async () => {
    for (const field of REJECTED_OWNER_BODY_FIELDS) {
      const result = parseAccountDeleteRequest({
        [field]: "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d",
      });

      expect(result.ok, field).toBe(false);
      if (result.ok) continue;
      expect(result.response.status, field).toBe(400);
      expect(result.response.headers.get("Cache-Control"), field).toBe("no-store");

      const body = await readErrorBody(result.response);
      expect(body.error.code, field).toBe(API_ERROR_CODES.INVALID_REQUEST);
      // 実装仕様書 9.2節: 受け取った値そのものを応答へ載せない。
      expect(body.error.message).not.toContain("6c4f8a1e");
    }
  });

  it("値が null / undefined でも所有者フィールドの存在自体を拒否する", () => {
    expect(parseAccountDeleteRequest({ owner_id: null }).ok).toBe(false);
    expect(parseAccountDeleteRequest({ user_id: undefined }).ok).toBe(false);
  });

  it("未知フィールドを拒否する（実装仕様書 9.2節 .strict()）", async () => {
    const result = parseAccountDeleteRequest({ confirm: true, reason: "テスト" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect((await readErrorBody(result.response)).error.code).toBe(API_ERROR_CODES.INVALID_REQUEST);
  });

  it("JSONオブジェクト以外を拒否する", async () => {
    for (const body of [[], ["owner_id"], "owner_id", 42, true]) {
      const result = parseAccountDeleteRequest(body);
      expect(result.ok, JSON.stringify(body)).toBe(false);
      if (result.ok) continue;
      expect(result.response.status, JSON.stringify(body)).toBe(400);
    }
  });

  it("スキーマは strict のまま（未知フィールドが通らない）", () => {
    expect(accountDeleteRequestSchema.safeParse({}).success).toBe(true);
    expect(accountDeleteRequestSchema.safeParse({ anything: 1 }).success).toBe(false);
  });
});
