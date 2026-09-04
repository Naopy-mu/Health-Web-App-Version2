/**
 * 睡眠・水分・体調フロントエンド用の小道具。
 *
 * 日時変換・CSV エスケープ・集計などを含む。サーバー専用の依存は持たない。
 */

import type {
  BeverageType,
  ConditionEntry,
  HydrationEntry,
  SleepEntry,
  SleepGoal,
  HydrationGoal,
  SymptomType,
} from "./schema";
import {
  calculateSleepEfficiency,
  calculateSleepMinutes,
  calculateTimeInBedMinutes,
  HYDRATION_UNIT_LABELS,
  MILLILITERS_PER_UNIT,
  normalizeHydrationAmount,
  SLEEP_KIND_LABELS,
  type HydrationUnit,
  type SleepKind,
} from "./units";

export function generateUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  // フォールバック（Node 26 では不要だがテスト環境の保険）
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function toDateTimeLocalValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function parseDateTimeLocal(value: string): Date {
  return new Date(value);
}

export function sleepKindLabel(kind: SleepKind): string {
  return SLEEP_KIND_LABELS[kind];
}

export function hydrationUnitLabel(unit: HydrationUnit): string {
  return HYDRATION_UNIT_LABELS[unit];
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${h}時間${m}分`;
}

export function formatSleepEntrySummary(entry: SleepEntry): string {
  const inBed = calculateTimeInBedMinutes(entry.bedAt, entry.outOfBedAt) ?? entry.timeInBedMinutes;
  const sleep =
    calculateSleepMinutes(entry.sleepAt, entry.wakeAt, entry.awakeMinutes) ?? entry.sleepMinutes;
  const efficiency = calculateSleepEfficiency(sleep, inBed);
  return `${sleepKindLabel(entry.sleepKind)} / 睡眠 ${formatMinutes(sleep)} / 効率 ${efficiency !== null ? `${efficiency}%` : "—"}`;
}

export function formatHydrationAmount(amount: number, unit: HydrationUnit): string {
  const label = hydrationUnitLabel(unit);
  return `${amount}${label}`;
}

export function sortByDateDesc<T extends { recordedAt: string } | { sleepAt: string }>(
  items: T[],
): T[] {
  return [...items].sort((a, b) => {
    const aDate = "recordedAt" in a ? a.recordedAt : a.sleepAt;
    const bDate = "recordedAt" in b ? b.recordedAt : b.sleepAt;
    return new Date(bDate).getTime() - new Date(aDate).getTime();
  });
}

export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const raw = String(value);
  // 数式インジェクション対策（実装仕様書 9.2節）
  const formulaLeading = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${formulaLeading.replaceAll('"', '""')}"`;
}

export function buildSleepCsv(entries: SleepEntry[]): string {
  const columns = [
    { key: "sleepAt", header: "日時" },
    { key: "sleepKind", header: "種別" },
    { key: "bedAt", header: "就床" },
    { key: "sleepAt", header: "入眠" },
    { key: "wakeAt", header: "起床" },
    { key: "outOfBedAt", header: "離床" },
    { key: "sleepMinutes", header: "睡眠時間（分）" },
    { key: "timeInBedMinutes", header: "就床〜離床（分）" },
    { key: "awakeningsCount", header: "中途覚醒回数" },
    { key: "awakeMinutes", header: "覚醒時間（分）" },
    { key: "quality", header: "睡眠の質" },
    { key: "morningFeeling", header: "起床時の感覚" },
    { key: "note", header: "メモ" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = entries.map((entry) =>
    columns
      .map((column) => {
        const raw = entry[column.key as keyof SleepEntry];
        return escapeCsvValue(raw as string | number | null | undefined);
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function buildHydrationCsv(entries: HydrationEntry[]): string {
  const columns = [
    { key: "recordedAt", header: "日時" },
    { key: "displayName", header: "飲み物" },
    { key: "beverageKey", header: "項目キー" },
    { key: "amount", header: "量" },
    { key: "unit", header: "単位" },
    { key: "amountMl", header: "量（ml換算）" },
    { key: "containsCaffeine", header: "カフェイン" },
    { key: "containsAlcohol", header: "アルコール" },
    { key: "note", header: "メモ" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = entries.map((entry) =>
    columns
      .map((column) => {
        const raw = entry[column.key as keyof HydrationEntry];
        if (column.key === "containsCaffeine" || column.key === "containsAlcohol") {
          return escapeCsvValue(raw ? "はい" : "いいえ");
        }
        return escapeCsvValue(raw as string | number | null | undefined);
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function buildConditionCsv(entries: ConditionEntry[]): string {
  const columns = [
    { key: "recordedAt", header: "日時" },
    { key: "overallScore", header: "総合" },
    { key: "fatigueScore", header: "疲労" },
    { key: "energyScore", header: "活力" },
    { key: "stressScore", header: "ストレス" },
    { key: "painScore", header: "痛み" },
    { key: "moodScore", header: "気分" },
    { key: "bodyTemperatureC", header: "体温" },
    { key: "symptoms", header: "症状" },
    { key: "freeTextSymptoms", header: "自由記述症状" },
    { key: "note", header: "メモ" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = entries.map((entry) =>
    columns
      .map((column) => {
        if (column.key === "symptoms") {
          return escapeCsvValue(
            entry.symptoms
              .map((s) => `${s.displayName}${s.severity !== null ? `(${s.severity})` : ""}`)
              .join(", "),
          );
        }
        if (column.key === "freeTextSymptoms") {
          return escapeCsvValue(entry.freeTextSymptoms.join(", "));
        }
        const raw = entry[column.key as keyof ConditionEntry];
        return escapeCsvValue(raw as string | number | null | undefined);
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function downloadCsv(filename: string, content: string): void {
  const blob = new Blob([content], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function activeGoal<T extends SleepGoal | HydrationGoal>(goals: T[]): T | undefined {
  return goals.find((goal) => goal.endDate === null);
}

export function activeCustomSymptomCount(types: SymptomType[]): number {
  return types.filter((type) => !type.isDefault && type.archivedAt === null).length;
}

export function archivedTypes<T extends { archivedAt: string | null }>(types: T[]): T[] {
  return types.filter((type) => type.archivedAt !== null);
}

export function activeTypes<T extends { archivedAt: string | null }>(types: T[]): T[] {
  return types.filter((type) => type.archivedAt === null);
}

export function beverageTypeById(types: BeverageType[], id: string): BeverageType | undefined {
  return types.find((type) => type.id === id);
}

export function symptomTypeById(types: SymptomType[], id: string): SymptomType | undefined {
  return types.find((type) => type.id === id);
}

export function calculateHydrationAmountMl(amount: number, unit: HydrationUnit): number | null {
  return normalizeHydrationAmount(amount, unit);
}

export function convertToUnit(amountMl: number, unit: HydrationUnit): number | null {
  if (!Number.isFinite(amountMl)) {
    return null;
  }
  const factor = MILLILITERS_PER_UNIT[unit];
  return Math.round((amountMl / factor) * 1000) / 1000;
}

export function formatDateTimeJa(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleString("ja-JP", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatDateJa(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
