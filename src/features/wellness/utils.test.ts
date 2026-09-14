import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  activeCustomSymptomCount,
  buildHydrationCsv,
  buildSleepCsv,
  convertDateTimeLocalToTimezone,
  escapeCsvValue,
  formatDateTimeJa,
  formatMinutes,
  toDateInputValue,
  toDateTimeLocalValue,
  toDateTimeLocalValueInTimezone,
} from "./utils";
import type { HydrationEntry, SleepEntry, SymptomType } from "./schema";

function withTimezone(tz: string) {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = original;
  });
}

describe("toDateTimeLocalValue", () => {
  withTimezone("Asia/Tokyo");

  it("Date を datetime-local 用にフォーマットする", () => {
    const date = new Date("2026-09-01T08:30:00+09:00");
    expect(toDateTimeLocalValue(date)).toBe("2026-09-01T08:30");
  });
});

describe("toDateInputValue", () => {
  withTimezone("Asia/Tokyo");

  it("Date を date 入力用にフォーマットする", () => {
    const date = new Date("2026-09-01T08:30:00+09:00");
    expect(toDateInputValue(date)).toBe("2026-09-01");
  });
});

describe("toDateTimeLocalValueInTimezone", () => {
  withTimezone("UTC");

  it("保存済み ISO を entry.timezone の壁時計として datetime-local 値に戻す", () => {
    // Asia/Tokyo の 2026-09-01 08:30 は UTC では 2026-08-31T23:30Z
    const iso = "2026-09-01T08:30:00+09:00";
    expect(toDateTimeLocalValueInTimezone(iso, "Asia/Tokyo")).toBe("2026-09-01T08:30");
  });

  it("convertDateTimeLocalToTimezone との往復で元の絶対時刻に戻る", () => {
    const iso = "2026-09-01T08:30:00+09:00";
    const localValue = toDateTimeLocalValueInTimezone(iso, "Asia/Tokyo");
    const converted = convertDateTimeLocalToTimezone(localValue, "Asia/Tokyo");
    expect(converted.toISOString()).toBe(new Date(iso).toISOString());
  });

  it("編集を繰り返しても日時がずれない（UTC ブラウザーで東京記録）", () => {
    const iso = "2026-09-01T08:30:00+09:00";
    let current = new Date(iso).toISOString();
    for (let i = 0; i < 5; i += 1) {
      const localValue = toDateTimeLocalValueInTimezone(current, "Asia/Tokyo");
      current = convertDateTimeLocalToTimezone(localValue, "Asia/Tokyo").toISOString();
    }
    expect(current).toBe(new Date(iso).toISOString());
  });

  it("無効なタイムゾーンではローカル表示にフォールバックする", () => {
    const iso = "2026-09-01T08:30:00+09:00";
    expect(toDateTimeLocalValueInTimezone(iso, "Not/A/Zone")).toBe(
      toDateTimeLocalValue(new Date(iso)),
    );
  });

  describe.each([
    {
      timezone: "America/New_York",
      iso: "2026-01-15T14:00:00-05:00",
      expectedLocal: "2026-01-15T14:00",
    },
    {
      timezone: "Europe/London",
      iso: "2026-01-15T14:00:00+00:00",
      expectedLocal: "2026-01-15T14:00",
    },
    {
      timezone: "Pacific/Auckland",
      iso: "2026-01-15T09:00:00+13:00",
      expectedLocal: "2026-01-15T09:00",
    },
    {
      timezone: "Asia/Tokyo",
      iso: "2026-09-01T08:30:00+09:00",
      expectedLocal: "2026-09-01T08:30",
    },
  ])("読み書き対称化（$timezone）", ({ timezone, iso, expectedLocal }) => {
    it("保存済み ISO を entry.timezone の壁時計に戻す", () => {
      expect(toDateTimeLocalValueInTimezone(iso, timezone)).toBe(expectedLocal);
    });

    it("datetime-local 値を entry.timezone の絶対時刻に変換する", () => {
      const converted = convertDateTimeLocalToTimezone(expectedLocal, timezone);
      expect(converted.toISOString()).toBe(new Date(iso).toISOString());
    });

    it("5 回編集しても絶対時刻がずれない", () => {
      let current = new Date(iso).toISOString();
      for (let i = 0; i < 5; i += 1) {
        const localValue = toDateTimeLocalValueInTimezone(current, timezone);
        current = convertDateTimeLocalToTimezone(localValue, timezone).toISOString();
      }
      expect(current).toBe(new Date(iso).toISOString());
    });
  });
});

describe("formatDateTimeJa", () => {
  describe("ブラウザー TZ=Asia/Tokyo", () => {
    withTimezone("Asia/Tokyo");

    it("UTC ISO 文字列をローカル日時表示に変換する", () => {
      const date = new Date("2026-09-01T08:30:00+09:00");
      expect(formatDateTimeJa(date.toISOString())).toMatch(/9月1日 08:30/);
    });
  });

  describe("ブラウザー TZ=UTC", () => {
    withTimezone("UTC");

    it("タイムゾーンを指定すると entry.timezone の壁時計で表示する", () => {
      const iso = "2026-09-01T08:30:00+09:00";
      expect(formatDateTimeJa(iso, "Asia/Tokyo")).toMatch(/9月1日 08:30/);
    });

    it("タイムゾーンを省略するとブラウザー UTC で表示する", () => {
      const iso = "2026-09-01T08:30:00+09:00";
      // UTC では 2026-08-31T23:30Z
      expect(formatDateTimeJa(iso)).toMatch(/8月31日 23:30/);
    });
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
