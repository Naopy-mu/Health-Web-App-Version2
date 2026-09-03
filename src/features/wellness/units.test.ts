import { describe, expect, it } from "vitest";

import {
  areWeekdaysValid,
  calculateSleepEfficiency,
  calculateSleepMinutes,
  calculateTimeInBedMinutes,
  convertMillilitersTo,
  findSleepChronologyViolations,
  MILLILITERS_PER_LITER,
  MILLILITERS_PER_US_FLUID_OUNCE,
  normalizeHydrationAmount,
  roundTo,
} from "./units";

/**
 * 実装仕様書 5.5節の計算規則。
 * DB 側（生成列・CHECK 制約）と同じ結果になることは
 * `tests/db/wellness.test.ts` が実データベースで突き合わせる。
 */

describe("睡眠時間の算出 (実装仕様書 5.5節)", () => {
  it("睡眠時間 = 起床 - 入眠 - 覚醒時間", () => {
    // 23:00 入眠 → 06:30 起床 = 450分。覚醒25分を引いて425分。
    expect(calculateSleepMinutes("2026-09-01T23:00:00Z", "2026-09-02T06:30:00Z", 25)).toBe(425);
  });

  it("覚醒時間が0なら入眠から起床までがそのまま睡眠時間になる", () => {
    expect(calculateSleepMinutes("2026-09-01T13:00:00Z", "2026-09-01T13:30:00Z", 0)).toBe(30);
  });

  it("秒は切り捨てる（DB の floor(秒/60) と同じ）", () => {
    // 30分59秒 → 30分
    expect(calculateSleepMinutes("2026-09-01T13:00:00Z", "2026-09-01T13:30:59Z", 0)).toBe(30);
  });

  it("日時が解釈できなければ null", () => {
    expect(calculateSleepMinutes("いつか", "2026-09-02T06:30:00Z", 0)).toBeNull();
  });

  it("就床から離床までの分数を返す", () => {
    expect(calculateTimeInBedMinutes("2026-09-01T22:30:00Z", "2026-09-02T06:45:00Z")).toBe(495);
  });

  it("睡眠効率は小数1桁", () => {
    expect(calculateSleepEfficiency(425, 495)).toBe(85.9);
  });

  it("拘束時間が0以下なら睡眠効率は算出しない", () => {
    expect(calculateSleepEfficiency(0, 0)).toBeNull();
    expect(calculateSleepEfficiency(10, -5)).toBeNull();
  });
});

describe("睡眠の順序・上限の判定 (実装仕様書 5.5節)", () => {
  const base = {
    bedAt: "2026-09-01T22:30:00Z",
    sleepAt: "2026-09-01T23:00:00Z",
    wakeAt: "2026-09-02T06:30:00Z",
    outOfBedAt: "2026-09-02T06:45:00Z",
    awakeMinutes: 25,
  };

  it("就床≦入眠＜起床≦離床・24時間以内・覚醒<睡眠 を満たせば違反なし", () => {
    expect(findSleepChronologyViolations(base)).toEqual([]);
  });

  it("同値（就床=入眠、起床=離床）は許す（仮眠の記録）", () => {
    expect(
      findSleepChronologyViolations({
        bedAt: "2026-09-01T13:00:00Z",
        sleepAt: "2026-09-01T13:00:00Z",
        wakeAt: "2026-09-01T13:30:00Z",
        outOfBedAt: "2026-09-01T13:30:00Z",
        awakeMinutes: 0,
      }),
    ).toEqual([]);
  });

  it("入眠が就床より前なら order 違反", () => {
    expect(findSleepChronologyViolations({ ...base, sleepAt: "2026-09-01T22:00:00Z" })).toContain(
      "order",
    );
  });

  it("起床が入眠と同時刻なら order 違反（入眠＜起床は厳密）", () => {
    expect(
      findSleepChronologyViolations({
        bedAt: "2026-09-01T13:00:00Z",
        sleepAt: "2026-09-01T13:00:00Z",
        wakeAt: "2026-09-01T13:00:00Z",
        outOfBedAt: "2026-09-01T13:00:00Z",
        awakeMinutes: 0,
      }),
    ).toContain("order");
  });

  it("就床から離床までが24時間を超えれば違反", () => {
    expect(
      findSleepChronologyViolations({
        bedAt: "2026-09-01T00:00:00Z",
        sleepAt: "2026-09-01T01:00:00Z",
        wakeAt: "2026-09-02T00:30:00Z",
        outOfBedAt: "2026-09-02T00:30:00Z",
        awakeMinutes: 0,
      }),
    ).toContain("span_over_24_hours");
  });

  it("覚醒時間が睡眠時間以上なら違反（等号も拒否）", () => {
    expect(
      findSleepChronologyViolations({
        bedAt: "2026-09-01T13:00:00Z",
        sleepAt: "2026-09-01T13:00:00Z",
        wakeAt: "2026-09-01T13:30:00Z",
        outOfBedAt: "2026-09-01T13:30:00Z",
        awakeMinutes: 30,
      }),
    ).toContain("awake_not_shorter_than_sleep");
  });

  it("日時が壊れていれば invalid_datetime だけを返す", () => {
    expect(findSleepChronologyViolations({ ...base, wakeAt: "" })).toEqual(["invalid_datetime"]);
  });
});

describe("水分の ml 正規化 (実装仕様書 5.5節 / 6.3節)", () => {
  it("ml はそのまま", () => {
    expect(normalizeHydrationAmount(200, "ml")).toBe(200);
  });

  it("l は1000倍", () => {
    expect(normalizeHydrationAmount(1.5, "l")).toBe(1500);
    expect(MILLILITERS_PER_LITER).toBe(1000);
  });

  it("us_fl_oz は 29.5735295625 倍", () => {
    expect(normalizeHydrationAmount(8, "us_fl_oz")).toBe(236.588237);
    expect(MILLILITERS_PER_US_FLUID_OUNCE).toBe(29.5735295625);
  });

  it("非有限値は null", () => {
    expect(normalizeHydrationAmount(Number.NaN, "ml")).toBeNull();
  });

  it("ml から入力単位へ戻せる", () => {
    expect(convertMillilitersTo(1500, "l")).toBe(1.5);
    expect(convertMillilitersTo(500, "ml")).toBe(500);
  });
});

describe("丸め", () => {
  it("二進小数の誤差に強い", () => {
    expect(roundTo(1.05, 1)).toBe(1.1);
    expect(roundTo(2.675, 2)).toBe(2.68);
  });
});

describe("対象曜日の判定 (実装仕様書 5.5節)", () => {
  it("0〜6の重複なし1〜7件なら有効", () => {
    expect(areWeekdaysValid([0, 1, 2, 3, 4, 5, 6])).toBe(true);
    expect(areWeekdaysValid([1])).toBe(true);
  });

  it("空・範囲外・重複は無効", () => {
    expect(areWeekdaysValid([])).toBe(false);
    expect(areWeekdaysValid([7])).toBe(false);
    expect(areWeekdaysValid([-1])).toBe(false);
    expect(areWeekdaysValid([1, 1])).toBe(false);
  });
});
