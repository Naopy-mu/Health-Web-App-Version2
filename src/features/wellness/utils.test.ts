import { describe, expect, it } from "vitest";

import {
  activeCustomSymptomCount,
  buildHydrationCsv,
  buildSleepCsv,
  escapeCsvValue,
  formatDateTimeJa,
  formatMinutes,
  toDateInputValue,
  toDateTimeLocalValue,
} from "./utils";
import type { HydrationEntry, SleepEntry, SymptomType } from "./schema";

describe("toDateTimeLocalValue", () => {
  it("Date を datetime-local 用にフォーマットする", () => {
    const date = new Date("2026-09-01T08:30:00+09:00");
    expect(toDateTimeLocalValue(date)).toBe("2026-09-01T08:30");
  });
});

describe("toDateInputValue", () => {
  it("Date を date 入力用にフォーマットする", () => {
    const date = new Date("2026-09-01T08:30:00+09:00");
    expect(toDateInputValue(date)).toBe("2026-09-01");
  });
});

describe("formatDateTimeJa", () => {
  it("UTC ISO 文字列をローカル日時表示に変換する", () => {
    const date = new Date("2026-09-01T08:30:00+09:00");
    expect(formatDateTimeJa(date.toISOString())).toMatch(/9月1日 08:30/);
  });
});

describe("formatMinutes", () => {
  it("分を時間・分表記に変換する", () => {
    expect(formatMinutes(125)).toBe("2時間5分");
  });
});

describe("escapeCsvValue", () => {
  it("値をダブルクォートで囲み、数式先頭をエスケープする", () => {
    expect(escapeCsvValue('a"b')).toBe('"a""b"');
    expect(escapeCsvValue("=1+1")).toBe('"\'=1+1"');
  });
});

describe("activeCustomSymptomCount", () => {
  it("既定種別とアーカイブ済みを除いた数を返す", () => {
    const types: SymptomType[] = [
      {
        id: "1",
        symptomKey: "fever",
        displayName: "発熱",
        isDefault: true,
        sortOrder: 10,
        archivedAt: null,
        rowVersion: 1,
        clientMutationId: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
      {
        id: "2",
        symptomKey: "custom_1",
        displayName: "カスタム1",
        isDefault: false,
        sortOrder: 10,
        archivedAt: null,
        rowVersion: 1,
        clientMutationId: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
      {
        id: "3",
        symptomKey: "custom_2",
        displayName: "カスタム2",
        isDefault: false,
        sortOrder: 10,
        archivedAt: "2026-08-27T00:00:00.000Z",
        rowVersion: 1,
        clientMutationId: null,
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      },
    ];
    expect(activeCustomSymptomCount(types)).toBe(1);
  });
});

describe("buildSleepCsv", () => {
  it("ヘッダーと行を生成する", () => {
    const entry: SleepEntry = {
      id: "id",
      sleepKind: "night",
      bedAt: "2026-09-01T22:30:00+09:00",
      sleepAt: "2026-09-01T23:00:00+09:00",
      wakeAt: "2026-09-02T06:30:00+09:00",
      outOfBedAt: "2026-09-02T06:45:00+09:00",
      timezone: "Asia/Tokyo",
      awakeningsCount: 1,
      awakeMinutes: 10,
      quality: 4,
      morningFeeling: 3,
      note: null,
      sleepMinutes: 440,
      timeInBedMinutes: 495,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-09-01T23:00:00+09:00",
      updatedAt: "2026-09-02T06:45:00+09:00",
    };
    const csv = buildSleepCsv([entry]);
    expect(csv).toContain("睡眠時間（分）");
    expect(csv).toContain("440");
  });
});

describe("buildHydrationCsv", () => {
  it("カフェイン・アルコールを含む列を生成する", () => {
    const entry: HydrationEntry = {
      id: "id",
      beverageTypeId: "type-id",
      beverageKey: "coffee",
      displayName: "コーヒー",
      recordedAt: "2026-09-01T08:00:00+09:00",
      unit: "ml",
      amount: 200,
      amountMl: 200,
      containsCaffeine: true,
      containsAlcohol: false,
      note: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-09-01T08:00:00+09:00",
      updatedAt: "2026-09-01T08:00:00+09:00",
    };
    const csv = buildHydrationCsv([entry]);
    expect(csv).toContain("カフェイン");
    expect(csv).toContain("はい");
  });
});
