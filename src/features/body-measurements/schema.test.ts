// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  deleteMeasurementRequestSchema,
  measurementGoalListQuerySchema,
  measurementKeySchema,
  measurementListQuerySchema,
  measurementTypeRequestSchema,
  measurementValueSchema,
  parseStoragePhotoReference,
  photoReferenceSchema,
  saveMeasurementGoalRequestSchema,
  saveMeasurementRequestSchema,
} from "./schema";

/**
 * 実装仕様書 9.2節:
 * > 全入力をZodで検証し（`.strict()` で未知フィールドを拒否）、DB制約とRLSを
 * > 最終防衛線とする。
 *
 * 実装仕様書 3.2節:
 * > 所有者IDは必ず検証済みサーバーセッションから導出し、リクエストボディの
 * > `owner_id` / `user_id` は拒否する。
 */

const OWNER = "6c4f8a1e-6c7b-4c4a-9f6f-6d9e1f1b2c3d";
const TYPE_ID = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";

const validMeasurement = {
  typeId: TYPE_ID,
  measuredAt: "2026-08-27T07:30:00Z",
  value: 62.4,
  unit: "kg" as const,
};

describe("値の検証（実装仕様書 5.3節）", () => {
  it("値は0超1000以下", () => {
    for (const value of [0, -1, 1000.1, 5000]) {
      expect(measurementValueSchema.safeParse(value).success, String(value)).toBe(false);
    }
    for (const value of [0.001, 62.4, 1000]) {
      expect(measurementValueSchema.safeParse(value).success, String(value)).toBe(true);
    }
  });

  it("小数第4位以下は拒否する（DB の numeric(10,3) が黙って丸めないように）", () => {
    expect(measurementValueSchema.safeParse(62.4567).success).toBe(false);
    expect(measurementValueSchema.safeParse(62.456).success).toBe(true);
  });

  it("NaN / Infinity を拒否する", () => {
    expect(measurementValueSchema.safeParse(Number.NaN).success).toBe(false);
    expect(measurementValueSchema.safeParse(Number.POSITIVE_INFINITY).success).toBe(false);
  });

  it("項目キーは ^[a-z][a-z0-9_]{1,49}$", () => {
    for (const key of ["weight", "body_fat_percentage", "a1"]) {
      expect(measurementKeySchema.safeParse(key).success, key).toBe(true);
    }
    for (const key of ["A", "1a", "a", "ab-cd", "ab cd", `a${"b".repeat(50)}`]) {
      expect(measurementKeySchema.safeParse(key).success, key).toBe(false);
    }
  });
});

describe("写真参照（実装仕様書 5.3節 / 6.6節）", () => {
  it("HTTPS URL と storage://health-images/<uuid>/... を許す", () => {
    expect(photoReferenceSchema.safeParse("https://example.test/a.jpg").success).toBe(true);
    expect(
      photoReferenceSchema.safeParse(`storage://health-images/${OWNER}/${TYPE_ID}.jpg`).success,
    ).toBe(true);
  });

  it("http / javascript / 別バケット / UUIDでないセグメントを拒む", () => {
    for (const reference of [
      "http://example.test/a.jpg",
      "javascript:alert(1)",
      "ftp://example.test/a.jpg",
      `storage://food-images-private/${OWNER}/a.jpg`,
      "storage://health-images/not-a-uuid/a.jpg",
      "storage://health-images//a.jpg",
    ]) {
      expect(photoReferenceSchema.safeParse(reference).success, reference).toBe(false);
    }
  });

  it("storage 参照を所有者とオブジェクトパスへ分解できる", () => {
    expect(
      parseStoragePhotoReference(`storage://health-images/${OWNER}/photos/a.jpg`),
    ).toStrictEqual({ ownerId: OWNER, objectPath: "photos/a.jpg" });
    expect(parseStoragePhotoReference("https://example.test/a.jpg")).toBeNull();
  });
});

describe("POST /api/measurements のボディ（実装仕様書 9.2節）", () => {
  it("最小の作成リクエストを受け付ける", () => {
    const parsed = saveMeasurementRequestSchema.safeParse({ measurement: validMeasurement });
    expect(parsed.success).toBe(true);
  });

  it("未知フィールドを拒否する（.strict()）", () => {
    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, unknownField: 1 },
      }).success,
    ).toBe(false);

    expect(
      saveMeasurementRequestSchema.safeParse({ measurement: validMeasurement, extra: true })
        .success,
    ).toBe(false);
  });

  it("所有者IDのフィールドは契約に存在しない（未知フィールドとして落ちる）", () => {
    for (const field of ["owner_id", "ownerId", "user_id", "userId"]) {
      expect(
        saveMeasurementRequestSchema.safeParse({
          measurement: { ...validMeasurement, [field]: OWNER },
        }).success,
        field,
      ).toBe(false);
    }
  });

  it("更新（id 指定）には expectedRowVersion が必須", () => {
    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, id: TYPE_ID },
      }).success,
    ).toBe(false);

    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, id: TYPE_ID, expectedRowVersion: 3 },
      }).success,
    ).toBe(true);
  });

  it("作成（id なし）に expectedRowVersion は送れない", () => {
    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, expectedRowVersion: 1 },
      }).success,
    ).toBe(false);
  });

  it("オフセットの無い日時を拒否する（実装仕様書 6.3節）", () => {
    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, measuredAt: "2026-08-27T07:30:00" },
      }).success,
    ).toBe(false);
    expect(
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, measuredAt: "2026-08-27T07:30:00+09:00" },
      }).success,
    ).toBe(true);
  });

  it("メモ500字・測定条件200字・測定部位100字の上限を課す", () => {
    const over = (field: string, length: number) =>
      saveMeasurementRequestSchema.safeParse({
        measurement: { ...validMeasurement, [field]: "あ".repeat(length) },
      }).success;

    expect(over("note", 501)).toBe(false);
    expect(over("note", 500)).toBe(true);
    expect(over("measurementCondition", 201)).toBe(false);
    expect(over("measurementCondition", 200)).toBe(true);
    expect(over("bodySite", 101)).toBe(false);
    expect(over("bodySite", 100)).toBe(true);
  });
});

describe("DELETE /api/measurements のボディ", () => {
  it("measurementId が必須で、未知フィールドを拒否する", () => {
    expect(deleteMeasurementRequestSchema.safeParse({}).success).toBe(false);
    expect(deleteMeasurementRequestSchema.safeParse({ measurementId: TYPE_ID }).success).toBe(true);
    expect(
      deleteMeasurementRequestSchema.safeParse({ measurementId: TYPE_ID, force: true }).success,
    ).toBe(false);
  });
});

describe("POST /api/measurements/types のボディ", () => {
  it("action で判別する", () => {
    expect(measurementTypeRequestSchema.safeParse({ action: "seed_defaults" }).success).toBe(true);
    expect(
      measurementTypeRequestSchema.safeParse({
        action: "create",
        type: {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
      }).success,
    ).toBe(true);
    expect(measurementTypeRequestSchema.safeParse({ action: "delete" }).success).toBe(false);
  });

  it("isDefault はクライアントから指定できない", () => {
    expect(
      measurementTypeRequestSchema.safeParse({
        action: "create",
        type: {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
          isDefault: true,
        },
      }).success,
    ).toBe(false);
  });

  it("seed_defaults に追加の入力は付けられない", () => {
    expect(
      measurementTypeRequestSchema.safeParse({ action: "seed_defaults", force: true }).success,
    ).toBe(false);
  });
});

describe("測定目標のボディ", () => {
  it("最小の作成リクエストを受け付ける", () => {
    expect(
      saveMeasurementGoalRequestSchema.safeParse({
        goal: { typeId: TYPE_ID, targetValue: 60, unit: "kg" },
      }).success,
    ).toBe(true);
  });

  it("targetDate は date 形式（日時ではない）", () => {
    const parse = (targetDate: string) =>
      saveMeasurementGoalRequestSchema.safeParse({
        goal: { typeId: TYPE_ID, targetValue: 60, unit: "kg", targetDate },
      }).success;

    expect(parse("2026-12-31")).toBe(true);
    expect(parse("2026-12-31T00:00:00Z")).toBe(false);
  });
});

describe("クエリの検証", () => {
  it("既定値（order=desc, limit=100）を埋める", () => {
    const parsed = measurementListQuerySchema.parse({});
    expect(parsed.order).toBe("desc");
    expect(parsed.limit).toBe(100);
  });

  it("limit は 1〜500", () => {
    expect(measurementListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
    expect(measurementListQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(measurementListQuerySchema.parse({ limit: "500" }).limit).toBe(500);
  });

  it("未知のクエリパラメータを拒否する", () => {
    expect(measurementListQuerySchema.safeParse({ ownerId: OWNER }).success).toBe(false);
    expect(measurementListQuerySchema.safeParse({ offset: "10" }).success).toBe(false);
  });

  it("目標一覧は既定で未達成のみ", () => {
    expect(measurementGoalListQuerySchema.parse({}).includeAchieved).toBe(false);
    expect(measurementGoalListQuerySchema.parse({ includeAchieved: "true" }).includeAchieved).toBe(
      true,
    );
    expect(measurementGoalListQuerySchema.safeParse({ includeAchieved: "1" }).success).toBe(false);
  });
});
