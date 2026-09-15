import { describe, expect, it } from "vitest";

import {
  isExpiringSoon,
  isLowStock,
  normalizeSupplementName,
  planFefoConsumption,
  sortLotsByFefo,
  sumRemainingByProduct,
  SUPPLEMENT_CATEGORIES,
  SUPPLEMENT_FORMS,
  SUPPLEMENT_UNITS,
} from "./units";

/**
 * サプリメントの列挙値と在庫計算（実装仕様書 5.6節）。
 *
 * DB 側の定義域との一致は `tests/db/supplements.test.ts`、
 * FEFO の実際の消費は `tests/db/supplements-fefo.test.ts` が実データで見る。
 * ここでは**フロントが画面で使う計算**だけを閉じた形で確かめる。
 */

const lot = (
  id: string,
  overrides: Partial<{
    expiresOn: string | null;
    openedOn: string | null;
    purchasedOn: string | null;
    createdAt: string;
    remainingQuantity: number;
  }> = {},
) => ({
  id,
  expiresOn: overrides.expiresOn ?? null,
  openedOn: overrides.openedOn ?? null,
  purchasedOn: overrides.purchasedOn ?? null,
  createdAt: overrides.createdAt ?? "2026-01-01T00:00:00.000Z",
  remainingQuantity: overrides.remainingQuantity ?? 10,
});

describe("列挙値（実装仕様書 5.6節）", () => {
  it("カテゴリ8種・剤形7種・単位11種を持つ", () => {
    expect(SUPPLEMENT_CATEGORIES).toHaveLength(8);
    expect(SUPPLEMENT_FORMS).toHaveLength(7);
    expect(SUPPLEMENT_UNITS).toHaveLength(11);
  });

  it("重複が無い", () => {
    for (const values of [SUPPLEMENT_CATEGORIES, SUPPLEMENT_FORMS, SUPPLEMENT_UNITS]) {
      expect(new Set(values).size).toBe(values.length);
    }
  });
});

describe("名称の正規化（実装仕様書 5.6節）", () => {
  it.each([
    ["Ｖｉｔａｍｉｎ　Ｃ", "vitamin c"],
    ["  FISH   OIL  ", "fish oil"],
    ["ﾏﾙﾁﾋﾞﾀﾐﾝ", "マルチビタミン"],
    ["マルチビタミン", "マルチビタミン"],
    ["Vitamin\tC", "vitamin c"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeSupplementName(input)).toBe(expected);
  });

  it("違う書き方の同じ商品名は同じキーになる（重複判定の前提）", () => {
    expect(normalizeSupplementName("Ｖｉｔａｍｉｎ　Ｃ")).toBe(
      normalizeSupplementName("vitamin c"),
    );
    expect(normalizeSupplementName("ﾏﾙﾁﾋﾞﾀﾐﾝ")).toBe(normalizeSupplementName("マルチビタミン"));
  });
});

describe("残量の集計と低在庫判定（実装仕様書 5.6節）", () => {
  it("商品ごとに残量を合計する", () => {
    const totals = sumRemainingByProduct([
      { productId: "a", remainingQuantity: 3, expiresOn: null },
      { productId: "a", remainingQuantity: 4.5, expiresOn: null },
      { productId: "b", remainingQuantity: 10, expiresOn: null },
    ]);

    expect(totals.get("a")).toBe(7.5);
    expect(totals.get("b")).toBe(10);
    expect(totals.get("c")).toBeUndefined();
  });

  it("しきい値以下なら低在庫。しきい値未設定の商品は判定しない", () => {
    expect(isLowStock(5, 10)).toBe(true);
    expect(isLowStock(10, 10)).toBe(true);
    expect(isLowStock(11, 10)).toBe(false);
    expect(isLowStock(0, null)).toBe(false);
  });
});

describe("期限接近の判定（実装仕様書 5.6節）", () => {
  it("既定の30日以内なら接近扱い", () => {
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: "2026-10-10" }, "2026-09-15")).toBe(
      true,
    );
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: "2026-11-30" }, "2026-09-15")).toBe(
      false,
    );
  });

  it("既に期限切れのロットも接近に含める（画面で強調すべき対象）", () => {
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: "2026-08-01" }, "2026-09-15")).toBe(
      true,
    );
  });

  it("残量 0 と期限未設定は数えない", () => {
    expect(isExpiringSoon({ remainingQuantity: 0, expiresOn: "2026-09-16" }, "2026-09-15")).toBe(
      false,
    );
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: null }, "2026-09-15")).toBe(false);
  });

  it("判定幅は指定できる", () => {
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: "2026-09-20" }, "2026-09-15", 3)).toBe(
      false,
    );
    expect(isExpiringSoon({ remainingQuantity: 5, expiresOn: "2026-09-17" }, "2026-09-15", 3)).toBe(
      true,
    );
  });
});

describe("FEFO の並び順（サーバーの ORDER BY と同じ）", () => {
  it("使用期限が近い順（未設定は最後）", () => {
    const sorted = sortLotsByFefo([
      lot("none"),
      lot("late", { expiresOn: "2027-06-30" }),
      lot("early", { expiresOn: "2026-12-31" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toStrictEqual(["early", "late", "none"]);
  });

  it("期限が同じなら開封済みを先に（未開封は最後）", () => {
    const sorted = sortLotsByFefo([
      lot("sealed", { expiresOn: "2027-03-31" }),
      lot("opened", { expiresOn: "2027-03-31", openedOn: "2026-08-01" }),
    ]);
    expect(sorted.map((entry) => entry.id)).toStrictEqual(["opened", "sealed"]);
  });

  it("期限も開封状態も同じなら購入が古い順、最後は登録順", () => {
    const byPurchase = sortLotsByFefo([
      lot("newer", { expiresOn: "2027-03-31", purchasedOn: "2026-05-01" }),
      lot("older", { expiresOn: "2027-03-31", purchasedOn: "2026-01-01" }),
    ]);
    expect(byPurchase.map((entry) => entry.id)).toStrictEqual(["older", "newer"]);

    const byCreatedAt = sortLotsByFefo([
      lot("second", { expiresOn: "2027-03-31", createdAt: "2026-02-01T00:00:00.000Z" }),
      lot("first", { expiresOn: "2027-03-31", createdAt: "2026-01-01T00:00:00.000Z" }),
    ]);
    expect(byCreatedAt.map((entry) => entry.id)).toStrictEqual(["first", "second"]);
  });

  it("元の配列を壊さない", () => {
    const lots = [lot("b", { expiresOn: "2027-06-30" }), lot("a", { expiresOn: "2026-12-31" })];
    sortLotsByFefo(lots);
    expect(lots.map((entry) => entry.id)).toStrictEqual(["b", "a"]);
  });
});

describe("FEFO 消費の見積もり（画面のプレビュー）", () => {
  it("期限が近いロットから順に割り当てる", () => {
    const plan = planFefoConsumption(
      [
        lot("late", { expiresOn: "2027-06-30", remainingQuantity: 10 }),
        lot("early", { expiresOn: "2026-12-31", remainingQuantity: 3 }),
      ],
      5,
    );

    expect(plan.shortfall).toBe(0);
    expect(plan.steps).toStrictEqual([
      { lotId: "early", quantity: 3 },
      { lotId: "late", quantity: 2 },
    ]);
  });

  it("残量 0 のロットは飛ばす", () => {
    const plan = planFefoConsumption(
      [
        lot("empty", { expiresOn: "2026-10-31", remainingQuantity: 0 }),
        lot("stocked", { expiresOn: "2027-01-31", remainingQuantity: 4 }),
      ],
      2,
    );
    expect(plan.steps).toStrictEqual([{ lotId: "stocked", quantity: 2 }]);
  });

  it("在庫が足りなければ不足分を返す（サーバーは 409 で拒否する）", () => {
    const plan = planFefoConsumption(
      [lot("only", { expiresOn: "2027-01-31", remainingQuantity: 2 })],
      5,
    );
    expect(plan.steps).toStrictEqual([{ lotId: "only", quantity: 2 }]);
    expect(plan.shortfall).toBe(3);
  });

  it("在庫が1件も無ければ全量が不足になる", () => {
    expect(planFefoConsumption([], 3)).toStrictEqual({ steps: [], shortfall: 3 });
  });

  it("消費量 0 は何も割り当てず不足も出さない", () => {
    expect(planFefoConsumption([lot("any", { remainingQuantity: 5 })], 0)).toStrictEqual({
      steps: [],
      shortfall: 0,
    });
  });
});
