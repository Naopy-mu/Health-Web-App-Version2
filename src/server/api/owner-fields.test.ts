// @vitest-environment node
import { describe, expect, it } from "vitest";

import { API_ERROR_CODES } from "./errors";
import { containsOwnerField, rejectOwnerFields, REJECTED_OWNER_FIELDS } from "./owner-fields";

/**
 * 実装仕様書 3.2節:
 * > 所有者IDは必ず検証済みサーバーセッションから導出し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。
 */

const OWNER = "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d";

describe("所有者フィールドの検出", () => {
  it.each([...REJECTED_OWNER_FIELDS])("トップレベルの %s を検出する", (field) => {
    expect(containsOwnerField({ [field]: OWNER })).toBe(true);
  });

  it("ネストしたオブジェクト・配列の中も見る", () => {
    expect(containsOwnerField({ measurement: { ownerId: OWNER } })).toBe(true);
    expect(containsOwnerField({ items: [{ ok: 1 }, { user_id: OWNER }] })).toBe(true);
    expect(containsOwnerField({ a: { b: { c: { owner: OWNER } } } })).toBe(true);
  });

  it("値が null や undefined でもキーの存在で検出する", () => {
    expect(containsOwnerField({ owner_id: null })).toBe(true);
    expect(containsOwnerField({ owner_id: undefined })).toBe(true);
  });

  it("行の主キー `id` は所有者フィールドではない（更新・削除に必要）", () => {
    expect(containsOwnerField({ id: OWNER })).toBe(false);
    expect(containsOwnerField({ measurement: { id: OWNER, expectedRowVersion: 1 } })).toBe(false);
  });

  it("普通のボディは通す", () => {
    expect(containsOwnerField({ measurement: { typeId: OWNER, value: 62 } })).toBe(false);
    expect(containsOwnerField(null)).toBe(false);
    expect(containsOwnerField("owner_id")).toBe(false);
    expect(containsOwnerField([1, 2, 3])).toBe(false);
  });

  it("深すぎるネストで走査が止まっても落ちない", () => {
    let deep: Record<string, unknown> = { owner_id: OWNER };
    for (let index = 0; index < 50; index += 1) {
      deep = { nested: deep };
    }
    expect(() => containsOwnerField(deep)).not.toThrow();
  });
});

describe("rejectOwnerFields", () => {
  it("所有者フィールドを含むボディを 400 INVALID_REQUEST で弾く", async () => {
    const result = rejectOwnerFields({ ownerId: OWNER });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.response.status).toBe(400);
    expect(result.response.headers.get("Cache-Control")).toBe("no-store");

    const body = (await result.response.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe(API_ERROR_CODES.INVALID_REQUEST);
    // 実装仕様書 9.2節: 受け取った値そのものを文言へ含めない。
    expect(body.error.message).not.toContain(OWNER);
  });

  it("含まないボディは通す", () => {
    expect(rejectOwnerFields({ measurement: { value: 62 } }).ok).toBe(true);
  });
});
