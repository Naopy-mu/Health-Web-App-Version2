import { describe, expect, it } from "vitest";

import { buildSupplementRefetchQuery, interpretSupplementRefetch } from "./conflict";
import {
  deleteSupplementRequestSchema,
  saveSupplementRequestSchema,
  supplementIntakeInputSchema,
  supplementListQuerySchema,
  supplementLotInputSchema,
  supplementProductInputSchema,
  supplementScheduleInputSchema,
} from "./schema";

/**
 * `/api/supplements` の契約（実装仕様書 5.6節 / 7章 / 9.2節）。
 *
 * > 全入力をZodで検証し（`.strict()` で未知フィールドを拒否）、DB制約とRLSを
 * > 最終防衛線とする。（実装仕様書 9.2節）
 *
 * ここでは**スキーマ単体**の判定だけを見る。実際の API 応答は
 * `src/app/api/supplements/route.test.ts`、DB の制約は
 * `tests/db/supplements*.test.ts`。
 */

const validProduct = {
  productKey: "vitamin_c",
  name: "ビタミンC",
  category: "vitamin" as const,
  form: "tablet" as const,
  defaultUnit: "tablet" as const,
};

const PRODUCT_ID = "11111111-1111-4111-8111-111111111111";
const ROW_ID = "22222222-2222-4222-8222-222222222222";

describe("商品の入力（実装仕様書 5.6節）", () => {
  it("作成では productKey が必須、更新では送れない", () => {
    expect(supplementProductInputSchema.safeParse(validProduct).success).toBe(true);

    const missingKey = supplementProductInputSchema.safeParse({
      ...validProduct,
      productKey: undefined,
    });
    expect(missingKey.success).toBe(false);

    const updateWithKey = supplementProductInputSchema.safeParse({
      ...validProduct,
      id: ROW_ID,
      expectedRowVersion: 1,
    });
    expect(updateWithKey.success).toBe(false);

    const update = supplementProductInputSchema.safeParse({
      id: ROW_ID,
      expectedRowVersion: 1,
      name: "ビタミンC",
      category: "vitamin",
      form: "tablet",
      defaultUnit: "tablet",
    });
    expect(update.success).toBe(true);
  });

  it("更新には expectedRowVersion が必須（実装仕様書 6.4節）", () => {
    const withoutVersion = supplementProductInputSchema.safeParse({
      id: ROW_ID,
      name: "ビタミンC",
      category: "vitamin",
      form: "tablet",
      defaultUnit: "tablet",
    });
    expect(withoutVersion.success).toBe(false);

    const strayVersion = supplementProductInputSchema.safeParse({
      ...validProduct,
      expectedRowVersion: 1,
    });
    expect(strayVersion.success).toBe(false);
  });

  it("項目キーは英小文字・数字・アンダースコアで2〜50文字", () => {
    for (const productKey of ["A", "1abc", "ab-cd", "x", "a".repeat(51)]) {
      expect(
        supplementProductInputSchema.safeParse({ ...validProduct, productKey }).success,
        productKey,
      ).toBe(false);
    }
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, productKey: "a1" }).success,
    ).toBe(true);
  });

  it("URL は https のみ（実装仕様書 5.6節）", () => {
    for (const url of ["http://example.com", "javascript:alert(1)", "example.com", "https://a b"]) {
      expect(supplementProductInputSchema.safeParse({ ...validProduct, url }).success, url).toBe(
        false,
      );
    }
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, url: "https://example.com/x" })
        .success,
    ).toBe(true);
    // 明示的な null（URL を外す）は通る。
    expect(supplementProductInputSchema.safeParse({ ...validProduct, url: null }).success).toBe(
      true,
    );
  });

  it("数量は小数第4位まで、上限を超えると拒否", () => {
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, defaultAmount: 1.00005 }).success,
    ).toBe(false);
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, defaultAmount: 0 }).success,
    ).toBe(false);
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, defaultAmount: 100001 }).success,
    ).toBe(false);
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, defaultAmount: 1.5 }).success,
    ).toBe(true);
    // 低在庫しきい値は 0 を許す（「無くなったら知らせる」設定）。
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, lowStockThreshold: 0 }).success,
    ).toBe(true);
  });

  it("未知フィールドは拒否（.strict()）", () => {
    expect(
      supplementProductInputSchema.safeParse({ ...validProduct, unknownField: 1 }).success,
    ).toBe(false);
  });
});

describe("摂取予定の入力（実装仕様書 5.6節）", () => {
  const base = {
    productId: PRODUCT_ID,
    startDate: "2026-09-01",
    amount: 1,
    unit: "tablet" as const,
  };

  it("週次は曜日が必須、それ以外は曜日を送れない", () => {
    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "weekly",
        timeOfDay: "08:00",
      }).success,
    ).toBe(false);

    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "weekly",
        timeOfDay: "08:00",
        weekdays: [1, 3, 5],
      }).success,
    ).toBe(true);

    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "daily",
        timeOfDay: "08:00",
        weekdays: [1],
      }).success,
    ).toBe(false);
  });

  it("曜日は 0〜6・重複なし・1件以上", () => {
    for (const weekdays of [[], [7], [-1], [1, 1]]) {
      expect(
        supplementScheduleInputSchema.safeParse({
          ...base,
          scheduleKind: "weekly",
          timeOfDay: "08:00",
          weekdays,
        }).success,
        JSON.stringify(weekdays),
      ).toBe(false);
    }
  });

  it("必要時は時刻を送れず、それ以外は時刻が必須", () => {
    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "as_needed",
        timeOfDay: "08:00",
      }).success,
    ).toBe(false);

    expect(
      supplementScheduleInputSchema.safeParse({ ...base, scheduleKind: "as_needed" }).success,
    ).toBe(true);

    expect(
      supplementScheduleInputSchema.safeParse({ ...base, scheduleKind: "daily" }).success,
    ).toBe(false);
  });

  it("時刻は HH:MM（24時間表記）", () => {
    for (const timeOfDay of ["8:00", "24:00", "08:60", "08:00:00", "0800"]) {
      expect(
        supplementScheduleInputSchema.safeParse({ ...base, scheduleKind: "daily", timeOfDay })
          .success,
        timeOfDay,
      ).toBe(false);
    }
    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "daily",
        timeOfDay: "23:59",
      }).success,
    ).toBe(true);
  });

  it("終了日は開始日以降、単発は同じ日のみ（実装仕様書 5.6節）", () => {
    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "daily",
        timeOfDay: "08:00",
        endDate: "2026-08-31",
      }).success,
    ).toBe(false);

    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "once",
        timeOfDay: "08:00",
        endDate: "2026-09-02",
      }).success,
    ).toBe(false);

    expect(
      supplementScheduleInputSchema.safeParse({
        ...base,
        scheduleKind: "once",
        timeOfDay: "08:00",
        endDate: "2026-09-01",
      }).success,
    ).toBe(true);
  });
});

describe("在庫ロットの入力（実装仕様書 5.6節）", () => {
  const base = { productId: PRODUCT_ID, quantity: 60 };

  it("残量は数量以下でなければならない", () => {
    expect(supplementLotInputSchema.safeParse({ ...base, remainingQuantity: 61 }).success).toBe(
      false,
    );
    expect(supplementLotInputSchema.safeParse({ ...base, remainingQuantity: 60 }).success).toBe(
      true,
    );
    // 使い切ったロット（残量 0）は正当。
    expect(supplementLotInputSchema.safeParse({ ...base, remainingQuantity: 0 }).success).toBe(
      true,
    );
  });

  it("開封日・使用期限は購入日以降", () => {
    expect(
      supplementLotInputSchema.safeParse({
        ...base,
        purchasedOn: "2026-09-10",
        openedOn: "2026-09-01",
      }).success,
    ).toBe(false);
    expect(
      supplementLotInputSchema.safeParse({
        ...base,
        purchasedOn: "2026-09-10",
        expiresOn: "2026-09-01",
      }).success,
    ).toBe(false);
    expect(
      supplementLotInputSchema.safeParse({
        ...base,
        purchasedOn: "2026-09-01",
        openedOn: "2026-09-10",
        expiresOn: "2027-09-01",
      }).success,
    ).toBe(true);
  });

  it("数量は 0 より大きい", () => {
    expect(supplementLotInputSchema.safeParse({ ...base, quantity: 0 }).success).toBe(false);
  });
});

describe("服用の入力（実装仕様書 5.6節）", () => {
  const base = {
    productId: PRODUCT_ID,
    idempotencyKey: "intake-20260915-0900",
    recordedAt: "2026-09-15T09:00:00Z",
  };

  it("冪等キーは 8〜200文字（実装仕様書 5.6節）", () => {
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, idempotencyKey: "1234567" }).success,
    ).toBe(false);
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, idempotencyKey: "12345678" }).success,
    ).toBe(true);
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, idempotencyKey: "x".repeat(200) }).success,
    ).toBe(true);
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, idempotencyKey: "x".repeat(201) }).success,
    ).toBe(false);
  });

  it("冪等キーは省略できない", () => {
    expect(
      supplementIntakeInputSchema.safeParse({
        productId: PRODUCT_ID,
        recordedAt: "2026-09-15T09:00:00Z",
      }).success,
    ).toBe(false);
  });

  it("status に voided は指定できない（取消は void_intake から）", () => {
    expect(supplementIntakeInputSchema.safeParse({ ...base, status: "voided" }).success).toBe(
      false,
    );
    for (const status of ["taken", "skipped", "as_needed"]) {
      expect(supplementIntakeInputSchema.safeParse({ ...base, status }).success, status).toBe(true);
    }
  });

  it("スキップした服用は在庫を消費できない", () => {
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, status: "skipped", consumeQuantity: 2 })
        .success,
    ).toBe(false);
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, status: "skipped", consumeQuantity: 0 })
        .success,
    ).toBe(true);
  });

  it("consumeQuantity には 0 を明示できる（在庫を引かずに記録だけ残す）", () => {
    expect(supplementIntakeInputSchema.safeParse({ ...base, consumeQuantity: 0 }).success).toBe(
      true,
    );
    expect(supplementIntakeInputSchema.safeParse({ ...base, consumeQuantity: -1 }).success).toBe(
      false,
    );
  });

  it("記録に id / expectedRowVersion は無い（訂正は取消して録り直す）", () => {
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, id: ROW_ID, expectedRowVersion: 1 }).success,
    ).toBe(false);
  });

  it("日時はオフセット付き ISO 8601 のみ", () => {
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, recordedAt: "2026-09-15 09:00" }).success,
    ).toBe(false);
    expect(
      supplementIntakeInputSchema.safeParse({ ...base, recordedAt: "2026-09-15T09:00:00+09:00" })
        .success,
    ).toBe(true);
  });
});

describe("リクエスト全体（実装仕様書 7章）", () => {
  it("resource で判別され、対応するペイロードが必要", () => {
    expect(
      saveSupplementRequestSchema.safeParse({ resource: "product", product: validProduct }).success,
    ).toBe(true);

    // 別リソースのペイロードは混ぜられない。
    expect(
      saveSupplementRequestSchema.safeParse({ resource: "product", schedule: {} }).success,
    ).toBe(false);

    expect(saveSupplementRequestSchema.safeParse({ resource: "unknown" }).success).toBe(false);
  });

  it("取消は id 必須、expectedRowVersion は任意", () => {
    expect(
      saveSupplementRequestSchema.safeParse({
        resource: "void_intake",
        void: { id: ROW_ID },
      }).success,
    ).toBe(true);

    expect(
      saveSupplementRequestSchema.safeParse({ resource: "void_intake", void: {} }).success,
    ).toBe(false);
  });

  it("削除できるのは予定とロットだけ（商品・服用記録は不可）", () => {
    for (const resource of ["schedule", "lot"]) {
      expect(
        deleteSupplementRequestSchema.safeParse({ resource, id: ROW_ID }).success,
        resource,
      ).toBe(true);
    }
    for (const resource of ["product", "intake", "movement"]) {
      expect(
        deleteSupplementRequestSchema.safeParse({ resource, id: ROW_ID }).success,
        resource,
      ).toBe(false);
    }
  });
});

describe("GET のクエリ（実装仕様書 7章 / docs/api/supplements.md 1.8節）", () => {
  it("既定は intake / desc / 100件", () => {
    const parsed = supplementListQuerySchema.parse({});
    expect(parsed).toMatchObject({ resource: "intake", order: "desc", limit: 100 });
  });

  it("limit は 1〜500", () => {
    expect(supplementListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(supplementListQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(supplementListQuerySchema.parse({ limit: "500" }).limit).toBe(500);
  });

  it("id は他の絞り込みと併用できない（1件取得は他条件に依存しない）", () => {
    for (const extra of [
      { from: "2026-09-01T00:00:00Z" },
      { to: "2026-09-30T00:00:00Z" },
      { cursor: "abc" },
      { productId: PRODUCT_ID },
      { status: "taken" },
    ]) {
      expect(
        supplementListQuerySchema.safeParse({ resource: "intake", id: ROW_ID, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }

    expect(supplementListQuerySchema.safeParse({ resource: "intake", id: ROW_ID }).success).toBe(
      true,
    );
  });

  it("status は resource=intake のときだけ指定できる", () => {
    expect(supplementListQuerySchema.safeParse({ resource: "lot", status: "taken" }).success).toBe(
      false,
    );
    expect(
      supplementListQuerySchema.safeParse({ resource: "intake", status: "taken" }).success,
    ).toBe(true);
  });

  it("商品は一覧リソースではない（どの応答にも全件入る）", () => {
    expect(supplementListQuerySchema.safeParse({ resource: "product" }).success).toBe(false);
  });
});

describe("409 後の対象特定（docs/api/supplements.md 1.8節）", () => {
  it("id があれば必ず主キーの1件取得を選ぶ", () => {
    const query = buildSupplementRefetchQuery({
      resource: "schedule",
      id: ROW_ID,
      productId: PRODUCT_ID,
      scheduleKind: "daily",
      startDate: "2026-09-01",
    });

    expect(query.strategy).toBe("id");
    expect(Object.fromEntries(query.params)).toStrictEqual({
      resource: "schedule",
      id: ROW_ID,
    });
    // 組み立てたクエリはそのままスキーマを通る。
    expect(supplementListQuerySchema.safeParse(Object.fromEntries(query.params)).success).toBe(
      true,
    );
  });

  it("id が無いときだけ識別子で引く（後退手段）", () => {
    const query = buildSupplementRefetchQuery({
      resource: "lot",
      productId: PRODUCT_ID,
      lotCode: "L-001",
    });

    expect(query.strategy).toBe("identifier");
    expect(Object.fromEntries(query.params)).toStrictEqual({
      resource: "lot",
      productId: PRODUCT_ID,
      limit: "500",
    });
  });

  it("id で引いた0件だけを「削除された」と断定する", () => {
    expect(interpretSupplementRefetch("id", [])).toStrictEqual({ kind: "deleted" });
    expect(
      interpretSupplementRefetch("identifier", [], {
        resource: "lot",
        productId: PRODUCT_ID,
        lotCode: "L-001",
      }),
    ).toStrictEqual({ kind: "unresolved" });
  });

  it("識別子で引いた結果からは一致する行だけを拾う", () => {
    const target = {
      resource: "lot" as const,
      productId: PRODUCT_ID,
      lotCode: "L-001",
    };
    const entries = [
      { id: "a", lotCode: "L-002" },
      { id: "b", lotCode: "L-001" },
    ];

    expect(interpretSupplementRefetch("identifier", entries, target)).toStrictEqual({
      kind: "found",
      entry: entries[1],
    });

    // 一致が無ければ「削除された」とは断定しない。
    expect(
      interpretSupplementRefetch("identifier", [{ id: "a", lotCode: "L-002" }], target),
    ).toStrictEqual({ kind: "unresolved" });
  });

  it("lotCode が無いロットには後退手段が無い（常に unresolved）", () => {
    expect(
      interpretSupplementRefetch("identifier", [{ id: "a", lotCode: null }], {
        resource: "lot",
        productId: PRODUCT_ID,
        lotCode: null,
      }),
    ).toStrictEqual({ kind: "unresolved" });
  });
});
