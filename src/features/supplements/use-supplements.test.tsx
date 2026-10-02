import "@testing-library/jest-dom/vitest";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupplementSchedule } from "./schema";
import * as api from "./api";
import { useSupplements } from "./use-supplements";

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    listSupplements: vi.fn(),
    saveSupplement: vi.fn(),
    deleteSupplement: vi.fn(),
  };
});

function ok<T>(data: T): { ok: true; data: T; status: number } {
  return { ok: true, data, status: 200 };
}

function err(
  code: string,
  message: string,
  status: number,
): { ok: false; error: { code: string; message: string }; status: number } {
  return { ok: false, error: { code, message }, status };
}

const PRODUCT = {
  id: "p1",
  productKey: "vitamin_c",
  name: "ビタミンC",
  nameNormalized: "ビタミンc",
  brand: null,
  category: "vitamin" as const,
  form: "tablet" as const,
  defaultAmount: 2,
  defaultUnit: "tablet" as const,
  amountPerContainer: null,
  lowStockThreshold: null,
  ingredientNote: null,
  safetyNote: null,
  url: null,
  archivedAt: null,
  stock: { remainingTotal: 10, lotCount: 1, nearestExpiresOn: null, lowStock: false },
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const SCHEDULE: SupplementSchedule = {
  id: "s1",
  productId: "p1",
  productKey: "vitamin_c",
  productName: "ビタミンC",
  scheduleKind: "daily",
  timeOfDay: "08:00",
  timezone: "Asia/Tokyo",
  weekdays: null,
  startDate: "2026-09-01",
  endDate: null,
  amount: 2,
  unit: "tablet",
  mealRelation: "after_meal",
  note: null,
  archivedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const REFRESHED_SCHEDULE: SupplementSchedule = {
  ...SCHEDULE,
  rowVersion: 2,
  updatedAt: "2026-09-01T01:00:00.000Z",
};

function listResponse<T>(entries: T[], resource: "schedule") {
  return {
    resource,
    entries,
    products: [PRODUCT],
    summary: {
      weeklyScheduledCount: 1,
      weeklyTakenCount: 0,
      monthlyTakenCount: 0,
      lowStockProductCount: 0,
      expiringLotCount: 0,
    },
    page: { limit: 100, order: "desc" as const, nextCursor: null },
  };
}

describe("useSupplements", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "0ed6f568-e1cd-42c5-889e-358a00748f21" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("更新 409 後に id 直接取得で rowVersion を更新し再試行する", async () => {
    vi.mocked(api.listSupplements)
      .mockResolvedValueOnce(ok(listResponse([SCHEDULE], "schedule")))
      .mockResolvedValueOnce(ok(listResponse([SCHEDULE], "schedule")))
      .mockResolvedValueOnce(ok(listResponse([REFRESHED_SCHEDULE], "schedule")))
      .mockResolvedValueOnce(ok(listResponse([REFRESHED_SCHEDULE], "schedule")));

    vi.mocked(api.saveSupplement)
      .mockResolvedValueOnce(err("SUPPLEMENT_CONFLICT", "競合", 409))
      .mockResolvedValueOnce(
        ok({
          resource: "schedule",
          schedule: REFRESHED_SCHEDULE,
          outcome: "updated",
        }),
      );

    const { result } = renderHook(() => useSupplements<SupplementSchedule>("schedule"));
    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    const setEditingSchedule = vi.fn();
    const request = {
      resource: "schedule" as const,
      clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
      schedule: {
        id: SCHEDULE.id,
        expectedRowVersion: SCHEDULE.rowVersion,
        productId: SCHEDULE.productId,
        scheduleKind: SCHEDULE.scheduleKind,
        timeOfDay: SCHEDULE.timeOfDay,
        timezone: SCHEDULE.timezone,
        startDate: SCHEDULE.startDate,
        endDate: SCHEDULE.endDate,
        amount: SCHEDULE.amount,
        unit: SCHEDULE.unit,
        mealRelation: SCHEDULE.mealRelation,
      },
    };

    const first = await result.current.saveSchedule(request, {
      editingSchedule: SCHEDULE,
      setEditingSchedule,
    });
    expect(first).toBe(false);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());

    expect(setEditingSchedule).toHaveBeenCalledWith(
      expect.objectContaining({ id: SCHEDULE.id, rowVersion: REFRESHED_SCHEDULE.rowVersion }),
    );

    const second = await result.current.saveSchedule(
      {
        ...request,
        schedule: { ...request.schedule, expectedRowVersion: REFRESHED_SCHEDULE.rowVersion },
      },
      {
        editingSchedule: { ...SCHEDULE, rowVersion: REFRESHED_SCHEDULE.rowVersion },
        setEditingSchedule,
      },
    );
    expect(second).toBe(true);

    await waitFor(() => expect(result.current.loadingState).toBe("idle"));
  });
});
