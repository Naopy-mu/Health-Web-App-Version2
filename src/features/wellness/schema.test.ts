import { describe, expect, it } from "vitest";

import {
  conditionEntryInputSchema,
  deleteWellnessRequestSchema,
  hydrationEntryInputSchema,
  saveWellnessRequestSchema,
  sleepEntryInputSchema,
  sleepGoalInputSchema,
  beverageTypeInputSchema,
  symptomTypeInputSchema,
  wellnessListQuerySchema,
} from "./schema";

/**
 * 実装仕様書 5.5節・9.2節の入力契約。
 * `.strict()` による未知フィールドの拒否と、値域・必須条件を確かめる。
 */

const UUID = "11111111-2222-4333-8444-555555555555";
const OTHER_UUID = "99999999-2222-4333-8444-555555555555";

const validSleepEntry = {
  sleepKind: "night" as const,
  bedAt: "2026-09-01T22:30:00Z",
  sleepAt: "2026-09-01T23:00:00Z",
  wakeAt: "2026-09-02T06:30:00Z",
  outOfBedAt: "2026-09-02T06:45:00Z",
};

describe("睡眠記録の入力 (実装仕様書 5.5節)", () => {
  it("必須の4日時と種別があれば通る", () => {
    expect(sleepEntryInputSchema.safeParse(validSleepEntry).success).toBe(true);
  });

  it("未知フィールドは拒否する", () => {
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, sleepScore: 5 }).success).toBe(
      false,
    );
  });

  it("オフセットの無い日時は拒否する（実装仕様書 6.3節）", () => {
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, sleepAt: "2026-09-01T23:00:00" })
        .success,
    ).toBe(false);
  });

  it("中途覚醒回数は0〜30", () => {
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, awakeningsCount: 30 }).success,
    ).toBe(true);
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, awakeningsCount: 31 }).success,
    ).toBe(false);
  });

  it("覚醒時間は0〜720分", () => {
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, awakeMinutes: 720 }).success).toBe(
      true,
    );
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, awakeMinutes: 721 }).success).toBe(
      false,
    );
  });

  it("睡眠の質・起床時の感覚は1〜5", () => {
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, quality: 5 }).success).toBe(true);
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, quality: 0 }).success).toBe(false);
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, morningFeeling: 6 }).success).toBe(
      false,
    );
  });

  it("更新には expectedRowVersion が必須（実装仕様書 6.4節）", () => {
    expect(sleepEntryInputSchema.safeParse({ ...validSleepEntry, id: UUID }).success).toBe(false);
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, id: UUID, expectedRowVersion: 2 })
        .success,
    ).toBe(true);
  });

  it("作成で expectedRowVersion を送ると拒否する", () => {
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, expectedRowVersion: 1 }).success,
    ).toBe(false);
  });

  it("タイムゾーンは IANA 名だけ（実装仕様書 6.3節）", () => {
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, timezone: "Asia/Tokyo" }).success,
    ).toBe(true);
    expect(
      sleepEntryInputSchema.safeParse({ ...validSleepEntry, timezone: "+09:00" }).success,
    ).toBe(false);
  });
});

describe("水分記録の入力 (実装仕様書 5.5節)", () => {
  const base = {
    beverageTypeId: UUID,
    recordedAt: "2026-09-01T09:00:00Z",
    unit: "ml" as const,
    amount: 200,
  };

  it("量は0超10,000以下", () => {
    expect(hydrationEntryInputSchema.safeParse({ ...base, amount: 10000 }).success).toBe(true);
    expect(hydrationEntryInputSchema.safeParse({ ...base, amount: 10000.1 }).success).toBe(false);
    expect(hydrationEntryInputSchema.safeParse({ ...base, amount: 0 }).success).toBe(false);
  });

  it("小数第3位までしか受け付けない（DB の numeric(10,3)）", () => {
    expect(hydrationEntryInputSchema.safeParse({ ...base, amount: 1.234 }).success).toBe(true);
    expect(hydrationEntryInputSchema.safeParse({ ...base, amount: 1.2345 }).success).toBe(false);
  });

  it("単位は ml / l / us_fl_oz のみ", () => {
    for (const unit of ["ml", "l", "us_fl_oz"]) {
      expect(hydrationEntryInputSchema.safeParse({ ...base, unit }).success).toBe(true);
    }
    expect(hydrationEntryInputSchema.safeParse({ ...base, unit: "cup" }).success).toBe(false);
  });
});

describe("体調記録の入力 (実装仕様書 5.5節)", () => {
  const base = { recordedAt: "2026-09-01T09:00:00Z" };

  it("各スコアは0〜10", () => {
    expect(conditionEntryInputSchema.safeParse({ ...base, overallScore: 10 }).success).toBe(true);
    expect(conditionEntryInputSchema.safeParse({ ...base, overallScore: 11 }).success).toBe(false);
    expect(conditionEntryInputSchema.safeParse({ ...base, stressScore: -1 }).success).toBe(false);
  });

  it("体温は30〜45℃で小数第1位まで", () => {
    expect(conditionEntryInputSchema.safeParse({ ...base, bodyTemperatureC: 36.6 }).success).toBe(
      true,
    );
    expect(conditionEntryInputSchema.safeParse({ ...base, bodyTemperatureC: 29.9 }).success).toBe(
      false,
    );
    expect(conditionEntryInputSchema.safeParse({ ...base, bodyTemperatureC: 45.1 }).success).toBe(
      false,
    );
    expect(conditionEntryInputSchema.safeParse({ ...base, bodyTemperatureC: 36.66 }).success).toBe(
      false,
    );
  });

  it("自由記述症状は10件まで", () => {
    const ten = Array.from({ length: 10 }, (_, index) => `症状${index}`);
    expect(conditionEntryInputSchema.safeParse({ ...base, freeTextSymptoms: ten }).success).toBe(
      true,
    );
    expect(
      conditionEntryInputSchema.safeParse({ ...base, freeTextSymptoms: [...ten, "溢れ"] }).success,
    ).toBe(false);
  });

  it("症状リンクは43件（既定13+カスタム30）まで", () => {
    const symptoms = Array.from({ length: 44 }, (_, index) => ({
      symptomTypeId: `${index.toString().padStart(8, "0")}-2222-4333-8444-555555555555`,
    }));
    expect(conditionEntryInputSchema.safeParse({ ...base, symptoms }).success).toBe(false);
    expect(
      conditionEntryInputSchema.safeParse({ ...base, symptoms: symptoms.slice(0, 43) }).success,
    ).toBe(true);
  });

  it("同じ症状種別を重複して指定できない", () => {
    expect(
      conditionEntryInputSchema.safeParse({
        ...base,
        symptoms: [{ symptomTypeId: UUID }, { symptomTypeId: UUID }],
      }).success,
    ).toBe(false);
    expect(
      conditionEntryInputSchema.safeParse({
        ...base,
        symptoms: [{ symptomTypeId: UUID }, { symptomTypeId: OTHER_UUID }],
      }).success,
    ).toBe(true);
  });
});

describe("目標の入力 (実装仕様書 5.5節)", () => {
  it("対象曜日は0〜6・重複なし", () => {
    expect(
      sleepGoalInputSchema.safeParse({
        targetSleepMinutes: 420,
        startDate: "2026-09-01",
        weekdays: [1, 2, 3],
      }).success,
    ).toBe(true);
    expect(
      sleepGoalInputSchema.safeParse({
        targetSleepMinutes: 420,
        startDate: "2026-09-01",
        weekdays: [1, 1],
      }).success,
    ).toBe(false);
    expect(
      sleepGoalInputSchema.safeParse({
        targetSleepMinutes: 420,
        startDate: "2026-09-01",
        weekdays: [],
      }).success,
    ).toBe(false);
  });

  it("目標就床・起床時刻は HH:MM", () => {
    expect(
      sleepGoalInputSchema.safeParse({
        targetSleepMinutes: 420,
        startDate: "2026-09-01",
        targetBedtime: "23:30",
        targetWakeTime: "06:30",
      }).success,
    ).toBe(true);
    expect(
      sleepGoalInputSchema.safeParse({
        targetSleepMinutes: 420,
        startDate: "2026-09-01",
        targetBedtime: "23:30:00",
      }).success,
    ).toBe(false);
  });
});

describe("種別の入力 (実装仕様書 5.5節)", () => {
  it("作成では項目キーが必須", () => {
    expect(
      beverageTypeInputSchema.safeParse({ displayName: "白湯", defaultUnit: "ml" }).success,
    ).toBe(false);
    expect(
      beverageTypeInputSchema.safeParse({
        beverageKey: "hot_water",
        displayName: "白湯",
        defaultUnit: "ml",
      }).success,
    ).toBe(true);
  });

  it("更新で項目キーを送ると拒否する（キーは作成後に変えられない）", () => {
    expect(
      beverageTypeInputSchema.safeParse({
        id: UUID,
        expectedRowVersion: 1,
        beverageKey: "hot_water",
        displayName: "白湯",
        defaultUnit: "ml",
      }).success,
    ).toBe(false);
    expect(
      beverageTypeInputSchema.safeParse({
        id: UUID,
        expectedRowVersion: 1,
        displayName: "白湯",
        defaultUnit: "ml",
        archived: true,
      }).success,
    ).toBe(true);
  });

  it("項目キーの形は ^[a-z][a-z0-9_]{1,49}$", () => {
    expect(
      symptomTypeInputSchema.safeParse({ symptomKey: "Eye_Strain", displayName: "目の疲れ" })
        .success,
    ).toBe(false);
    expect(
      symptomTypeInputSchema.safeParse({ symptomKey: "eye_strain", displayName: "目の疲れ" })
        .success,
    ).toBe(true);
  });

  it("isDefault は送れない（既定種別を作れるのは seed だけ）", () => {
    expect(
      symptomTypeInputSchema.safeParse({
        symptomKey: "eye_strain",
        displayName: "目の疲れ",
        isDefault: true,
      }).success,
    ).toBe(false);
  });
});

describe("POST のリクエスト全体", () => {
  it("resource で判別する", () => {
    expect(
      saveWellnessRequestSchema.safeParse({ resource: "sleep", entry: validSleepEntry }).success,
    ).toBe(true);
    expect(saveWellnessRequestSchema.safeParse({ resource: "seed_defaults" }).success).toBe(true);
    expect(saveWellnessRequestSchema.safeParse({ resource: "unknown" }).success).toBe(false);
  });

  it("seed_defaults に余分なフィールドは付けられない", () => {
    expect(
      saveWellnessRequestSchema.safeParse({
        resource: "seed_defaults",
        clientMutationId: UUID,
      }).success,
    ).toBe(false);
  });

  it("clientMutationId は UUID", () => {
    expect(
      saveWellnessRequestSchema.safeParse({
        resource: "sleep",
        clientMutationId: "not-a-uuid",
        entry: validSleepEntry,
      }).success,
    ).toBe(false);
  });

  it("体調記録は clientMutationId が必須（安全な再試行のため）", () => {
    const entry = { recordedAt: "2026-09-02T08:00:00Z" };

    expect(saveWellnessRequestSchema.safeParse({ resource: "condition", entry }).success).toBe(
      false,
    );
    expect(
      saveWellnessRequestSchema.safeParse({ resource: "condition", clientMutationId: UUID, entry })
        .success,
    ).toBe(true);

    // 他のリソースは従来どおり任意。
    expect(
      saveWellnessRequestSchema.safeParse({ resource: "sleep", entry: validSleepEntry }).success,
    ).toBe(true);
  });
});

describe("DELETE のリクエスト", () => {
  it("記録と目標だけを削除できる", () => {
    for (const resource of ["sleep", "hydration", "condition", "sleep_goal", "hydration_goal"]) {
      expect(deleteWellnessRequestSchema.safeParse({ resource, id: UUID }).success).toBe(true);
    }
  });

  it("種別は削除できない（アーカイブのみ）", () => {
    expect(
      deleteWellnessRequestSchema.safeParse({ resource: "beverage_type", id: UUID }).success,
    ).toBe(false);
    expect(
      deleteWellnessRequestSchema.safeParse({ resource: "symptom_type", id: UUID }).success,
    ).toBe(false);
  });
});

describe("GET のクエリ (実装仕様書 5.5節 / 7章)", () => {
  it("既定は sleep・desc・100件", () => {
    const parsed = wellnessListQuerySchema.parse({});
    expect(parsed.resource).toBe("sleep");
    expect(parsed.order).toBe("desc");
    expect(parsed.limit).toBe(100);
  });

  it("limit は1〜500", () => {
    expect(wellnessListQuerySchema.safeParse({ limit: "500" }).success).toBe(true);
    expect(wellnessListQuerySchema.safeParse({ limit: "501" }).success).toBe(false);
    expect(wellnessListQuerySchema.safeParse({ limit: "0" }).success).toBe(false);
  });

  it("sleepKind は resource=sleep のときだけ", () => {
    expect(wellnessListQuerySchema.safeParse({ resource: "sleep", sleepKind: "nap" }).success).toBe(
      true,
    );
    expect(
      wellnessListQuerySchema.safeParse({ resource: "hydration", sleepKind: "nap" }).success,
    ).toBe(false);
  });

  it("beverageTypeId は resource=hydration のときだけ", () => {
    expect(
      wellnessListQuerySchema.safeParse({ resource: "hydration", beverageTypeId: UUID }).success,
    ).toBe(true);
    expect(
      wellnessListQuerySchema.safeParse({ resource: "condition", beverageTypeId: UUID }).success,
    ).toBe(false);
  });

  it("未知のパラメータは拒否する", () => {
    expect(wellnessListQuerySchema.safeParse({ offset: "10" }).success).toBe(false);
  });

  it("id は単独で指定する（1件取得は他の絞り込みに依存しない）", () => {
    expect(wellnessListQuerySchema.safeParse({ resource: "sleep", id: UUID }).success).toBe(true);
    expect(wellnessListQuerySchema.safeParse({ resource: "condition", id: UUID }).success).toBe(
      true,
    );
    expect(wellnessListQuerySchema.safeParse({ resource: "sleep", id: "not-a-uuid" }).success).toBe(
      false,
    );

    for (const extra of [
      { from: "2026-09-01T00:00:00Z" },
      { to: "2026-09-01T00:00:00Z" },
      { cursor: "abc" },
      { sleepKind: "nap" },
    ]) {
      expect(
        wellnessListQuerySchema.safeParse({ resource: "sleep", id: UUID, ...extra }).success,
        JSON.stringify(extra),
      ).toBe(false);
    }
    expect(
      wellnessListQuerySchema.safeParse({ resource: "hydration", id: UUID, beverageTypeId: UUID })
        .success,
    ).toBe(false);
  });
});
