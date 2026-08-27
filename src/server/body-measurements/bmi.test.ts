// @vitest-environment node
import { describe, expect, it } from "vitest";

import { deriveBmi, HEIGHT_CM_MAX, HEIGHT_CM_MIN, readHeightCmFromSettings } from "./bmi";

/**
 * 実装仕様書 5.3節「BMI（体重kg / (身長m)^2 を小数1桁）」。
 * 身長は実装仕様書 5.2節の**確定プロフィール**
 * （`user_profiles.settings.confirmed_profile.heightCm`）から取る。
 */

describe("確定プロフィールからの身長読み出し", () => {
  it("settings.confirmed_profile.heightCm を読む", () => {
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: 168 } })).toBe(168);
  });

  it("未確認（settings が空）なら null", () => {
    expect(readHeightCmFromSettings({})).toBeNull();
    expect(readHeightCmFromSettings(null)).toBeNull();
    expect(readHeightCmFromSettings("{}")).toBeNull();
  });

  it("確定前の候補（confirmed_profile 以外の場所）からは読まない", () => {
    expect(readHeightCmFromSettings({ candidate_profile: { heightCm: 168 } })).toBeNull();
    expect(readHeightCmFromSettings({ heightCm: 168 })).toBeNull();
  });

  it("実装仕様書 5.2節の範囲（30〜300cm）外は未設定として扱う", () => {
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: HEIGHT_CM_MIN } })).toBe(
      HEIGHT_CM_MIN,
    );
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: HEIGHT_CM_MAX } })).toBe(
      HEIGHT_CM_MAX,
    );
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: 29 } })).toBeNull();
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: 301 } })).toBeNull();
  });

  it("数値でない値は null", () => {
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: "168" } })).toBeNull();
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: null } })).toBeNull();
    expect(readHeightCmFromSettings({ confirmed_profile: { heightCm: Number.NaN } })).toBeNull();
  });
});

describe("deriveBmi", () => {
  it("身長・体重が揃えば小数1桁のBMIを返す", () => {
    expect(deriveBmi(62.4, 168)).toBe(22.1);
  });

  it("どちらかが欠ければ null", () => {
    expect(deriveBmi(null, 168)).toBeNull();
    expect(deriveBmi(62, null)).toBeNull();
    expect(deriveBmi(null, null)).toBeNull();
  });
});
