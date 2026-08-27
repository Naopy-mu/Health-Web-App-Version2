/**
 * デモモードの架空の初期候補プロフィール（実装仕様書 3.1節）。
 *
 * > 架空の初期候補プロフィールを提示し、利用者が確認した内容だけを
 * > ブラウザのIndexedDBへ保存する。
 *
 * ここに実在の個人を思わせる値を置かないこと。項目名は実装仕様書 5.2節の
 * 候補項目に対応させてあるが、**編集UIの本実装は後続フェーズ**であり、
 * このフェーズでは骨格として型と初期値のみを持つ。
 *
 * TODO(Phase 3以降): 実装仕様書 5.2節の `ProfileWorkspace`（`/onboarding` と
 * 共通のプロフィール編集UI）と、年齢1〜130・身長30〜300cm・体重10〜500kg
 * などの検証を実装する。
 */

export type DemoUnitSystem = "metric" | "imperial";

export type DemoCandidateProfile = {
  readonly displayName: string;
  readonly age: number;
  readonly heightCm: number;
  readonly currentWeightKg: number;
  readonly targetWeightKg: number;
  readonly unitSystem: DemoUnitSystem;
  readonly timeZone: string;
  readonly sleepGoalHours: number;
  readonly availableWorkoutDays: readonly string[];
  readonly note: string;
};

/** 保存済みレコード。`confirmed` が true の内容だけを保持する（実装仕様書 5.2節）。 */
export type DemoProfileRecord = {
  readonly id: "candidate";
  readonly profile: DemoCandidateProfile;
  readonly confirmed: true;
  readonly updatedAt: string;
};

const DEFAULT_TIME_ZONE = "Asia/Tokyo";

/**
 * 架空の候補。`NEXT_PUBLIC_DEFAULT_TIME_ZONE`（実装仕様書 13.1節）があれば
 * タイムゾーンだけそれに合わせる。
 */
export function createDemoCandidateProfile(): DemoCandidateProfile {
  const configuredTimeZone = process.env.NEXT_PUBLIC_DEFAULT_TIME_ZONE?.trim();

  return {
    displayName: "デモ ユーザー",
    age: 34,
    heightCm: 168,
    currentWeightKg: 64,
    targetWeightKg: 61,
    unitSystem: "metric",
    timeZone:
      configuredTimeZone && configuredTimeZone !== "" ? configuredTimeZone : DEFAULT_TIME_ZONE,
    sleepGoalHours: 7.5,
    availableWorkoutDays: ["tuesday", "thursday", "saturday"],
    // 実装仕様書 10章: 過度な減量や極端な摂取制限を推奨しない文言を用いる。
    note: "無理のない範囲で、週に数回の運動とバランスのよい食事を続けることを目安にしています。",
  };
}

/** 画面表示用のラベル。値の整形はここに集約する。 */
export const DEMO_PROFILE_LABELS: Readonly<Record<keyof DemoCandidateProfile, string>> = {
  displayName: "表示名",
  age: "年齢",
  heightCm: "身長（cm）",
  currentWeightKg: "現在体重（kg）",
  targetWeightKg: "目標体重（kg）",
  unitSystem: "単位系",
  timeZone: "タイムゾーン",
  sleepGoalHours: "睡眠目標時間",
  availableWorkoutDays: "運動可能曜日",
  note: "メモ",
};

export function formatDemoProfileValue(value: DemoCandidateProfile[keyof DemoCandidateProfile]) {
  return Array.isArray(value) ? value.join(", ") : String(value);
}
