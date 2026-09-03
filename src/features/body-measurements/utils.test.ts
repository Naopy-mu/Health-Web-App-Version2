// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";

import type { Measurement, MeasurementGoal } from "./schema";
import {
  buildMeasurementsCsv,
  downloadCsv,
  escapeCsvValue,
  findUnachievedGoal,
  formatUnitLabel,
  formatValue,
  generateUuid,
  movingAverage,
  sortMeasurementsByDate,
  toDateTimeLocalValue,
  toDateInputValue,
} from "./utils";

/**
 * CSV エスケープは `src/server/account/export.ts` の `escapeCsvValue()` と
 * 同じ形式（引用符の内側にアポストロフィ）であることを保証する（C3）。
 */
describe("escapeCsvValue（数式インジェクション対策）", () => {
  it("= + - @ で始まる値は引用符の内側にアポストロフィを置く", () => {
    expect(escapeCsvValue("=1+1")).toBe(`"'=1+1"`);
    expect(escapeCsvValue("+1")).toBe(`"'+1"`);
    expect(escapeCsvValue("-1")).toBe(`"'-1"`);
    expect(escapeCsvValue("@SUM(A1)")).toBe(`"'@SUM(A1)"`);
  });

  it("タブ・復帰で始まる値もアポストロフィを前置する", () => {
    expect(escapeCsvValue("\t=1+1")).toBe(`"'\t=1+1"`);
    expect(escapeCsvValue("\r=1+1")).toBe(`"'\r=1+1"`);
  });

  it("通常の値は二重引用符で囲む", () => {
    expect(escapeCsvValue("体重")).toBe(`"体重"`);
    expect(escapeCsvValue(64.2)).toBe(`"64.2"`);
    expect(escapeCsvValue(0)).toBe(`"0"`);
  });

  it("カンマ・改行・二重引用符を含む値は二重引用符で囲み、内部の引用符を二重化する", () => {
    expect(escapeCsvValue('say "hi"')).toBe(`"say ""hi"""`);
    expect(escapeCsvValue("a,b")).toBe(`"a,b"`);
    expect(escapeCsvValue("a\nb")).toBe(`"a\nb"`);
  });

  it("null / undefined は空文字を返す", () => {
    expect(escapeCsvValue(null)).toBe("");
    expect(escapeCsvValue(undefined)).toBe("");
  });
});

describe("buildMeasurementsCsv", () => {
  function makeMeasurement(overrides: Partial<Measurement> = {}): Measurement {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      typeId: "00000000-0000-0000-0000-000000000002",
      measurementKey: "weight",
      displayName: "体重",
      measuredAt: "2026-08-27T07:30:00.000Z",
      value: 62.4,
      unit: "kg",
      normalizedValue: 62.4,
      normalizedUnit: "kg",
      note: null,
      measurementCondition: null,
      bodySite: null,
      photoReference: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-08-27T07:31:00.000Z",
      updatedAt: "2026-08-27T07:31:00.000Z",
      ...overrides,
    };
  }

  it("ヘッダーと行を含む CSV を組み立てる", () => {
    const csv = buildMeasurementsCsv([makeMeasurement()]);
    const rows = csv.split("\n");
    expect(rows[0]).toContain("日時");
    expect(rows[1]).toContain("体重");
    expect(rows[1]).toContain("62.4");
  });

  it("数式インジェクション対策が適用される", () => {
    const csv = buildMeasurementsCsv([
      makeMeasurement({ note: "=cmd|'/c calc'!A0", measurementCondition: "a,b", bodySite: 'a"b' }),
    ]);
    expect(csv).toContain(`"'=cmd|'/c calc'!A0"`);
    expect(csv).toContain(`"a,b"`);
    expect(csv).toContain(`"a""b"`);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("generateUuid", () => {
  it("UUID v4 形式を返す", () => {
    const uuid = generateUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("crypto.randomUUID が無い場合もフォールバックする", () => {
    vi.stubGlobal("crypto", undefined);
    const uuid = generateUuid();
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe("toDateTimeLocalValue / toDateInputValue", () => {
  it("datetime-local 用の文字列を返す", () => {
    const date = new Date("2026-08-27T07:30:00.000Z");
    expect(toDateTimeLocalValue(date)).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
  });

  it("date 入力用の文字列を返す", () => {
    expect(toDateInputValue(new Date("2026-08-27T07:30:00.000Z"))).toBe("2026-08-27");
  });
});

describe("formatUnitLabel / formatValue", () => {
  it("単位に応じたラベルを返す", () => {
    expect(formatUnitLabel("percent")).toBe("%");
    expect(formatUnitLabel("index")).toBe("");
    expect(formatUnitLabel("custom")).toBe("");
    expect(formatUnitLabel("kg")).toBe("kg");
  });

  it("値とラベルを連結する", () => {
    expect(formatValue(62.4, "kg")).toBe("62.4kg");
    expect(formatValue(18.4, "percent")).toBe("18.4%");
    expect(formatValue(22.1, "index")).toBe("22.1");
  });
});

describe("sortMeasurementsByDate", () => {
  function makeMeasurement(measuredAt: string): Measurement {
    return {
      id: measuredAt,
      typeId: "00000000-0000-0000-0000-000000000001",
      measurementKey: "weight",
      displayName: "体重",
      measuredAt,
      value: 60,
      unit: "kg",
      normalizedValue: 60,
      normalizedUnit: "kg",
      note: null,
      measurementCondition: null,
      bodySite: null,
      photoReference: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: measuredAt,
      updatedAt: measuredAt,
    };
  }

  it("古い順に並べ替える", () => {
    const items = [
      makeMeasurement("2026-08-28T00:00:00.000Z"),
      makeMeasurement("2026-08-27T00:00:00.000Z"),
    ];
    const sorted = sortMeasurementsByDate(items, "asc");
    expect(sorted[0].measuredAt).toBe("2026-08-27T00:00:00.000Z");
  });

  it("新しい順に並べ替える", () => {
    const items = [
      makeMeasurement("2026-08-27T00:00:00.000Z"),
      makeMeasurement("2026-08-28T00:00:00.000Z"),
    ];
    const sorted = sortMeasurementsByDate(items, "desc");
    expect(sorted[0].measuredAt).toBe("2026-08-28T00:00:00.000Z");
  });
});

describe("movingAverage", () => {
  function makeMeasurement(
    value: number,
    normalizedValue: number,
    measuredAt: string,
  ): Measurement {
    return {
      id: measuredAt,
      typeId: "00000000-0000-0000-0000-000000000001",
      measurementKey: "weight",
      displayName: "体重",
      measuredAt,
      value,
      unit: "kg",
      normalizedValue,
      normalizedUnit: "kg",
      note: null,
      measurementCondition: null,
      bodySite: null,
      photoReference: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: measuredAt,
      updatedAt: measuredAt,
    };
  }

  it("直近 N 件の正規化値の平均を返す（S7）", () => {
    const items = [
      makeMeasurement(60, 60, "2026-08-21T00:00:00.000Z"),
      makeMeasurement(62, 62, "2026-08-22T00:00:00.000Z"),
      makeMeasurement(64, 64, "2026-08-23T00:00:00.000Z"),
    ];
    const result = movingAverage(items, 7);
    expect(result[0].average).toBe(60);
    expect(result[1].average).toBe(61);
    expect(result[2].average).toBe(62);
  });

  it("正規化値が null のものは平均に含めない", () => {
    const items = [
      makeMeasurement(60, 60, "2026-08-21T00:00:00.000Z"),
      makeMeasurement(62, 62, "2026-08-22T00:00:00.000Z"),
      {
        ...makeMeasurement(64, 64, "2026-08-23T00:00:00.000Z"),
        normalizedValue: null,
        normalizedUnit: null,
      },
    ];
    const result = movingAverage(items, 7);
    expect(result[2].average).toBe(61);
  });

  it("windowSize より件数が少ない場合も計算する", () => {
    const items = [makeMeasurement(60, 60, "2026-08-21T00:00:00.000Z")];
    const result = movingAverage(items, 7);
    expect(result[0].average).toBe(60);
  });
});

describe("findUnachievedGoal", () => {
  function makeGoal(typeId: string, achievedAt: string | null): MeasurementGoal {
    return {
      id: "00000000-0000-0000-0000-000000000001",
      typeId,
      measurementKey: "weight",
      displayName: "体重",
      targetValue: 60,
      unit: "kg",
      startValue: null,
      targetDate: null,
      note: null,
      achievedAt,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
  }

  it("未達成の目標を返す", () => {
    const goal = makeGoal("type-1", null);
    expect(findUnachievedGoal([goal], "type-1")).toBe(goal);
  });

  it("達成済みの目標は無視する", () => {
    const goal = makeGoal("type-1", "2026-08-27T00:00:00.000Z");
    expect(findUnachievedGoal([goal], "type-1")).toBeUndefined();
  });
});

describe("downloadCsv", () => {
  it("Blob URL を生成してダウンロードリンクを発行する", () => {
    // happy-dom では anchor.click() が window.open を呼び出して複雑になるため、
    // DOM API を直接 stub して主要な副作用だけを検証する。
    const originalCreateObjectURL = globalThis.URL?.createObjectURL;
    const originalRevokeObjectURL = globalThis.URL?.revokeObjectURL;
    const createObjectURL = vi.fn(() => "blob:mock");
    const revokeObjectURL = vi.fn();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.URL as any).createObjectURL = createObjectURL;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (globalThis.URL as any).revokeObjectURL = revokeObjectURL;

    let appended: HTMLAnchorElement | null = null;
    const originalAppendChild = document.body.appendChild.bind(document.body);
    const originalRemoveChild = document.body.removeChild.bind(document.body);
    document.body.appendChild = vi.fn((node: Node) => {
      appended = node as HTMLAnchorElement;
      return node;
    }) as unknown as typeof document.body.appendChild;
    document.body.removeChild = vi.fn(
      (node) => node,
    ) as unknown as typeof document.body.removeChild;

    downloadCsv("test.csv", "a,b");

    expect(createObjectURL).toHaveBeenCalled();
    expect(appended).not.toBeNull();
    expect(document.body.removeChild).toHaveBeenCalled();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    document.body.appendChild = originalAppendChild;
    document.body.removeChild = originalRemoveChild;
    if (originalCreateObjectURL) {
      globalThis.URL.createObjectURL = originalCreateObjectURL;
    }
    if (originalRevokeObjectURL) {
      globalThis.URL.revokeObjectURL = originalRevokeObjectURL;
    }
  });
});
