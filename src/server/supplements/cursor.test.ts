// @vitest-environment node
import { describe, expect, it } from "vitest";

import { decodeSupplementCursor, encodeSupplementCursor, keysetFilter } from "./cursor";

const ID = "3e2d3c4b-5a69-4788-9900-aabbccddeeff";
const AT = "2026-09-15T07:30:00.000Z";

describe("サプリメント一覧のカーソル", () => {
  it("往復して同じ値へ戻る", () => {
    const encoded = encodeSupplementCursor({ timestamp: AT, id: ID });
    expect(decodeSupplementCursor(encoded)).toStrictEqual({ timestamp: AT, id: ID });
  });

  it("URLに安全な文字だけを使う（base64url）", () => {
    const encoded = encodeSupplementCursor({ timestamp: AT, id: ID });
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it("所有者IDや健康データを含まない（実装仕様書 9.2節）", () => {
    const encoded = encodeSupplementCursor({ timestamp: AT, id: ID });
    const decoded = Buffer.from(encoded, "base64url").toString("utf8");
    expect(decoded).toBe(`${AT}|${ID}`);
  });

  // 署名は付けていないため、これは改竄の検出ではなく形式の検証。
  // 実際のクエリには owner_id 条件が必ず付くので、値を作り替えても他人の行は読めない。
  it("形式に合わない値は null（日時とUUIDの2要素であることだけを検証する）", () => {
    for (const raw of [
      "not-a-cursor",
      Buffer.from("only-one-part").toString("base64url"),
      Buffer.from(`${AT}|not-a-uuid`).toString("base64url"),
      Buffer.from(`not-a-date|${ID}`).toString("base64url"),
      Buffer.from(`${AT}|${ID}|extra`).toString("base64url"),
    ]) {
      expect(decodeSupplementCursor(raw), raw).toBeNull();
    }
  });

  it("オフセット付きの日時は Z 付きへ正規化される", () => {
    const encoded = Buffer.from(`2026-09-15T16:30:00+09:00|${ID}`).toString("base64url");
    expect(decodeSupplementCursor(encoded)?.timestamp).toBe(AT);
  });
});

describe("サプリメント一覧のキーセット条件", () => {
  it("降順は「より古い」または「同時刻でIDが小さい」", () => {
    expect(keysetFilter({ timestamp: AT, id: ID }, "recorded_at", "desc")).toBe(
      `recorded_at.lt.${AT},and(recorded_at.eq.${AT},id.lt.${ID})`,
    );
  });

  it("昇順は比較の向きが逆になる", () => {
    expect(keysetFilter({ timestamp: AT, id: ID }, "created_at", "asc")).toBe(
      `created_at.gt.${AT},and(created_at.eq.${AT},id.gt.${ID})`,
    );
  });
});
