/**
 * 身体測定フロントエンド用の小道具。
 *
 * 日時変換・CSV エスケープ・移動平均などを含む。サーバー専用の依存は持たない。
 */

import type { Measurement, MeasurementGoal } from "./schema";
import type { MeasurementUnit } from "./units";

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

export function parseDateTimeLocal(value: string): Date {
  return new Date(value);
}

export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function formatUnitLabel(unit: MeasurementUnit): string {
  switch (unit) {
    case "percent":
      return "%";
    case "index":
      return "";
    case "custom":
      return "";
    default:
      return unit;
  }
}

export function formatValue(value: number, unit: MeasurementUnit): string {
  const label = formatUnitLabel(unit);
  return label ? `${value}${label}` : `${value}`;
}

export function sortMeasurementsByDate(
  items: Measurement[],
  order: "asc" | "desc" = "asc",
): Measurement[] {
  const sorted = [...items].sort(
    (a, b) => new Date(a.measuredAt).getTime() - new Date(b.measuredAt).getTime(),
  );
  return order === "desc" ? sorted.reverse() : sorted;
}

export function movingAverage(
  items: Measurement[],
  windowSize: number,
): { measuredAt: string; value: number; average: number | null }[] {
  const sorted = sortMeasurementsByDate(items, "asc");
  return sorted.map((item, index) => {
    const start = Math.max(0, index - windowSize + 1);
    const windowItems = sorted.slice(start, index + 1);
    const values = windowItems.map((m) => m.normalizedValue).filter((v): v is number => v !== null);
    const average =
      values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;
    return {
      measuredAt: item.measuredAt,
      value: item.normalizedValue ?? item.value,
      average: average,
    };
  });
}

export function escapeCsvValue(value: string | number | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const text = String(value);
  // 数式インジェクション対策（実装仕様書 9.2節）
  const needsQuotePrefix = /^[=+\-@]/.test(text);
  const needsQuoting = needsQuotePrefix || /[",\n\r]/.test(text);
  const safe = text.replace(/"/g, '""');
  if (needsQuoting) {
    return needsQuotePrefix ? `'"${safe}"` : `"${safe}"`;
  }
  return safe;
}

export function buildMeasurementsCsv(measurements: Measurement[]): string {
  const columns = [
    { key: "measuredAt", header: "日時" },
    { key: "measurementKey", header: "項目キー" },
    { key: "displayName", header: "表示名" },
    { key: "value", header: "値" },
    { key: "unit", header: "単位" },
    { key: "normalizedValue", header: "正規化値" },
    { key: "normalizedUnit", header: "正規化単位" },
    { key: "note", header: "メモ" },
    { key: "measurementCondition", header: "測定条件" },
    { key: "bodySite", header: "測定部位" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = measurements.map((measurement) =>
    columns
      .map((column) => {
        const raw = measurement[column.key];
        return escapeCsvValue(raw);
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

export function findUnachievedGoal(
  goals: MeasurementGoal[],
  typeId: string,
): MeasurementGoal | undefined {
  return goals.find((goal) => goal.typeId === typeId && goal.achievedAt === null);
}
