// @vitest-environment node
import { describe, expect, it } from "vitest";

import {
  BMI_FRACTION_DIGITS,
  CENTIMETERS_PER_INCH,
  KILOGRAMS_PER_POUND,
  MEASUREMENT_UNITS,
  MEASUREMENT_UNIT_CONSTRAINTS,
  calculateBmi,
  centimetersToInches,
  inchesToCentimeters,
  isUnitAllowedFor,
  kilogramsToPounds,
  normalizeMeasurement,
  poundsToKilograms,
  roundTo,
} from "./units";

/**
 * 実装仕様書 5.3節:
 * > 計算: BMI（`体重kg / (身長m)^2` を小数1桁）、`kg↔lb`（0.45359237）、
 * > `cm↔inch`（2.54）の相互変換。
 */

describe("換算係数（実装仕様書 5.3節）", () => {
  it("仕様どおりの定数を使う", () => {
    expect(KILOGRAMS_PER_POUND).toBe(0.45359237);
    expect(CENTIMETERS_PER_INCH).toBe(2.54);
  });
});

describe("kg ↔ lb の相互変換", () => {
  it("1 lb = 0.45359237 kg", () => {
    expect(poundsToKilograms(1)).toBe(0.45359237);
  });

  it("1 kg ≒ 2.20462262 lb", () => {
    expect(kilogramsToPounds(1)).toBeCloseTo(2.2046226218, 9);
  });

  it("往復しても元の値へ戻る", () => {
    for (const kilograms of [0.5, 10, 62.4, 145.125, 500]) {
      expect(poundsToKilograms(kilogramsToPounds(kilograms))).toBeCloseTo(kilograms, 10);
    }
  });

  it("実用値の換算（140 lb ≒ 63.5 kg）", () => {
    expect(roundTo(poundsToKilograms(140), 1)).toBe(63.5);
  });
});

describe("cm ↔ inch の相互変換", () => {
  it("1 inch = 2.54 cm", () => {
    expect(inchesToCentimeters(1)).toBe(2.54);
  });

  it("1 cm ≒ 0.3937 inch", () => {
    expect(centimetersToInches(1)).toBeCloseTo(0.3937007874, 9);
  });

  it("往復しても元の値へ戻る", () => {
    for (const centimeters of [10, 70.5, 168, 300]) {
      expect(inchesToCentimeters(centimetersToInches(centimeters))).toBeCloseTo(centimeters, 10);
    }
  });

  it("実用値の換算（30 inch = 76.2 cm）", () => {
    expect(roundTo(inchesToCentimeters(30), 1)).toBe(76.2);
  });
});

describe("正規化（実装仕様書 6.3節の集計用の値）", () => {
  it("mass は kg、length は cm、percent はそのまま", () => {
    expect(normalizeMeasurement(62, "kg")).toStrictEqual({ value: 62, unit: "kg" });
    expect(normalizeMeasurement(140, "lb")).toStrictEqual({
      value: 140 * KILOGRAMS_PER_POUND,
      unit: "kg",
    });
    expect(normalizeMeasurement(70, "cm")).toStrictEqual({ value: 70, unit: "cm" });
    expect(normalizeMeasurement(30, "inch")).toStrictEqual({
      value: 30 * CENTIMETERS_PER_INCH,
      unit: "cm",
    });
    expect(normalizeMeasurement(18.4, "percent")).toStrictEqual({ value: 18.4, unit: "percent" });
  });

  it("custom は正規化しない", () => {
    expect(normalizeMeasurement(42, "custom")).toBeNull();
  });

  it("全ての単位を扱える（列挙の取りこぼしが無い）", () => {
    for (const unit of MEASUREMENT_UNITS) {
      expect(() => normalizeMeasurement(1, unit)).not.toThrow();
    }
  });
});

describe("単位制約（実装仕様書 5.3節）", () => {
  it("体重は kg|lb、体脂肪率・BMIは percent、周囲・長さは cm|inch", () => {
    expect(isUnitAllowedFor("mass", "kg")).toBe(true);
    expect(isUnitAllowedFor("mass", "lb")).toBe(true);
    expect(isUnitAllowedFor("mass", "cm")).toBe(false);
    expect(isUnitAllowedFor("mass", "percent")).toBe(false);

    expect(isUnitAllowedFor("percent", "percent")).toBe(true);
    expect(isUnitAllowedFor("percent", "kg")).toBe(false);

    expect(isUnitAllowedFor("length", "cm")).toBe(true);
    expect(isUnitAllowedFor("length", "inch")).toBe(true);
    expect(isUnitAllowedFor("length", "kg")).toBe(false);

    expect(isUnitAllowedFor("custom", "custom")).toBe(true);
    expect(isUnitAllowedFor("custom", "kg")).toBe(false);
  });

  it("どの単位制約も少なくとも1つの単位を許す", () => {
    for (const constraint of MEASUREMENT_UNIT_CONSTRAINTS) {
      expect(MEASUREMENT_UNITS.some((unit) => isUnitAllowedFor(constraint, unit))).toBe(true);
    }
  });
});

describe("BMI（実装仕様書 5.3節: 体重kg / (身長m)^2、小数1桁）", () => {
  it("代表的な値を小数1桁で返す", () => {
    // 62 / 1.68^2 = 21.9670... -> 22.0
    expect(calculateBmi(62, 168)).toBe(22);
    // 70 / 1.75^2 = 22.857... -> 22.9
    expect(calculateBmi(70, 175)).toBe(22.9);
    // 50 / 1.5^2 = 22.222... -> 22.2
    expect(calculateBmi(50, 150)).toBe(22.2);
    // 100 / 2.0^2 = 25 -> 25
    expect(calculateBmi(100, 200)).toBe(25);
  });

  it("小数1桁へ丸める（BMI_FRACTION_DIGITS）", () => {
    expect(BMI_FRACTION_DIGITS).toBe(1);
    const bmi = calculateBmi(62.4, 170);
    expect(bmi).not.toBeNull();
    expect(String(bmi).split(".")[1]?.length ?? 0).toBeLessThanOrEqual(1);
  });

  it("身長 cm を m へ直してから二乗する（cm のまま計算しない）", () => {
    // cm のままだと 62 / 168^2 ≒ 0.0 になる。
    expect(calculateBmi(62, 168)).toBeGreaterThan(10);
  });

  it("計算できない入力は null", () => {
    expect(calculateBmi(62, 0)).toBeNull();
    expect(calculateBmi(0, 168)).toBeNull();
    expect(calculateBmi(-62, 168)).toBeNull();
    expect(calculateBmi(62, -168)).toBeNull();
    expect(calculateBmi(Number.NaN, 168)).toBeNull();
    expect(calculateBmi(62, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("roundTo", () => {
  it("二進小数の誤差に引きずられず丸める", () => {
    expect(roundTo(1.05, 1)).toBe(1.1);
    expect(roundTo(2.675, 2)).toBe(2.68);
    expect(roundTo(22.96703, 1)).toBe(23);
  });
});
