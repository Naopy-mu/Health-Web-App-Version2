/**
 * サプリメントフロントエンド用の小道具。
 *
 * 日時変換・CSV エスケープ・摂取予定の展開・冪等キー生成などを含む。
 * サーバー専用の依存は持たない。
 */

import type {
  SupplementIntake,
  SupplementLot,
  SupplementProduct,
  SupplementSchedule,
} from "./schema";
import {
  SUPPLEMENT_SCHEDULE_KINDS,
  type SupplementScheduleKind,
  type SupplementUnit,
} from "./units";

export function generateUuid(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (char) => {
    const random = (Math.random() * 16) | 0;
    const value = char === "x" ? random : (random & 0x3) | 0x8;
    return value.toString(16);
  });
}

export function toDateInputValue(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
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

export function parseDate(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

export function formatDateTimeJa(iso: string, timezone?: string): string {
  const date = new Date(iso);
  const options: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  };
  if (timezone) {
    options.timeZone = timezone;
  }
  return date.toLocaleString("ja-JP", options);
}

export function formatDateJa(iso: string): string {
  const date = new Date(iso);
  return date.toLocaleDateString("ja-JP", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
}

export function localDateInTimezone(date: Date, timezone: string): string {
  const formatter = new Intl.DateTimeFormat("ja-JP", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

export function escapeCsvValue(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) {
    return "";
  }
  const raw = String(value);
  const formulaLeading = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
  return `"${formulaLeading.replaceAll('"', '""')}"`;
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

export function buildIntakeCsv(intakes: SupplementIntake[]): string {
  const columns = [
    { key: "recordedAt", header: "記録日時" },
    { key: "productName", header: "商品" },
    { key: "status", header: "状態" },
    { key: "scheduledFor", header: "予定発生日時" },
    { key: "amount", header: "量" },
    { key: "unit", header: "単位" },
    { key: "consumedQuantity", header: "在庫消費量" },
    { key: "note", header: "メモ" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = intakes.map((intake) =>
    columns
      .map((column) => {
        const raw = intake[column.key as keyof SupplementIntake];
        return escapeCsvValue(raw as string | number | null | undefined);
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export function buildLotCsv(lots: SupplementLot[]): string {
  const columns = [
    { key: "productName", header: "商品" },
    { key: "lotCode", header: "ロット名" },
    { key: "quantity", header: "入荷数量" },
    { key: "remainingQuantity", header: "残量" },
    { key: "unit", header: "単位" },
    { key: "purchasedOn", header: "購入日" },
    { key: "openedOn", header: "開封日" },
    { key: "expiresOn", header: "使用期限" },
    { key: "note", header: "メモ" },
  ] as const;

  const header = columns.map((column) => escapeCsvValue(column.header)).join(",");
  const rows = lots.map((lot) =>
    columns
      .map((column) => {
        const raw = lot[column.key as keyof SupplementLot];
        return escapeCsvValue(raw as string | number | null | undefined);
      })
      .join(","),
  );
  return [header, ...rows].join("\n");
}

export type ScheduleOccurrence = {
  scheduleId: string;
  scheduledFor: string;
  timeOfDay: string | null;
  productId: string;
  productName: string;
  productKey: string;
  amount: number;
  unit: SupplementUnit;
  mealRelation: string;
  scheduleKind: SupplementScheduleKind;
};

function scheduleKindSort(kind: SupplementScheduleKind): number {
  return SUPPLEMENT_SCHEDULE_KINDS.indexOf(kind);
}

function occurrenceTimeMinutes(timeOfDay: string | null): number {
  if (!timeOfDay) {
    return 0;
  }
  const [hours, minutes] = timeOfDay.split(":").map(Number);
  return hours * 60 + minutes;
}

export function expandSchedulesForDate(
  schedules: SupplementSchedule[],
  date: Date,
  timezone: string,
): ScheduleOccurrence[] {
  const localDate = localDateInTimezone(date, timezone);
  const weekday = date.getDay();
  const occurrences: ScheduleOccurrence[] = [];

  for (const schedule of schedules) {
    if (schedule.archivedAt !== null) {
      continue;
    }
    if (schedule.startDate > localDate) {
      continue;
    }
    if (schedule.endDate !== null && schedule.endDate < localDate) {
      continue;
    }

    let include = false;
    if (schedule.scheduleKind === "once") {
      include = schedule.startDate === localDate;
    } else if (schedule.scheduleKind === "daily") {
      include = true;
    } else if (schedule.scheduleKind === "weekly") {
      include = schedule.weekdays?.includes(weekday) ?? false;
    } else if (schedule.scheduleKind === "as_needed") {
      include = false;
    }

    if (!include) {
      continue;
    }

    const time = schedule.timeOfDay ?? "00:00";
    const scheduledFor = new Date(`${localDate}T${time}:00`);
    occurrences.push({
      scheduleId: schedule.id,
      scheduledFor: scheduledFor.toISOString(),
      timeOfDay: schedule.timeOfDay,
      productId: schedule.productId,
      productName: schedule.productName,
      productKey: schedule.productKey,
      amount: schedule.amount,
      unit: schedule.unit,
      mealRelation: schedule.mealRelation,
      scheduleKind: schedule.scheduleKind,
    });
  }

  return occurrences.sort(
    (a, b) =>
      occurrenceTimeMinutes(a.timeOfDay) - occurrenceTimeMinutes(b.timeOfDay) ||
      a.productName.localeCompare(b.productName) ||
      scheduleKindSort(a.scheduleKind) - scheduleKindSort(b.scheduleKind),
  );
}

export function buildScheduledIntakeIdempotencyKey(
  scheduleId: string,
  scheduledFor: string,
): string {
  return `${scheduleId}:${scheduledFor}`;
}

export function buildAdhocIntakeIdempotencyKey(
  productId: string,
  recordedAt: string,
  retryCount?: number,
): string {
  const base = `adhoc:${productId}:${recordedAt}`;
  if (retryCount === undefined || retryCount <= 0) {
    return base;
  }
  return `${base}:retry${retryCount}`;
}

/**
 * 取り消し・スキップ後の録り直し用に、既存の服用記録から次の冪等キーを作る。
 * docs/api/supplements.md 5.4 節の `:retryN` ルールに従う。
 */
export function buildRetryIntakeIdempotencyKey(
  baseKey: string,
  intakes: SupplementIntake[],
): string {
  const retryPattern = new RegExp(
    `^${baseKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(:retry(\\d+))?$`,
  );
  let maxRetry = -1;
  let hasBase = false;
  for (const intake of intakes) {
    const match = retryPattern.exec(intake.idempotencyKey);
    if (!match) {
      continue;
    }
    if (match[1] === undefined) {
      hasBase = true;
      continue;
    }
    const n = Number(match[2]);
    if (n > maxRetry) {
      maxRetry = n;
    }
  }
  if (!hasBase) {
    return baseKey;
  }
  return `${baseKey}:retry${maxRetry + 1}`;
}

export function findIntakeForOccurrence(
  occurrence: ScheduleOccurrence,
  intakes: SupplementIntake[],
): SupplementIntake | undefined {
  const expectedKey = buildScheduledIntakeIdempotencyKey(
    occurrence.scheduleId,
    occurrence.scheduledFor,
  );
  return intakes.find(
    (intake) =>
      intake.idempotencyKey === expectedKey &&
      intake.status !== "voided" &&
      intake.status !== "skipped",
  );
}

export function productById(
  products: SupplementProduct[],
  id: string,
): SupplementProduct | undefined {
  return products.find((product) => product.id === id);
}

export function activeProducts(products: SupplementProduct[]): SupplementProduct[] {
  return products.filter((product) => product.archivedAt === null);
}

export function archivedProducts(products: SupplementProduct[]): SupplementProduct[] {
  return products.filter((product) => product.archivedAt !== null);
}
