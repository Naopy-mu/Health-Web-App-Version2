import "@testing-library/jest-dom/vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { HydrationEntry, HydrationGoal } from "./schema";
import { useWellness } from "./use-wellness";
import * as api from "./api";

function ok<T>(data: T) {
  return { ok: true as const, data };
}

function err(code: string, message: string, status: number) {
  return { ok: false as const, error: { code, message }, status };
}

vi.mock("./api", async () => {
  const actual = await vi.importActual<typeof import("./api")>("./api");
  return {
    ...actual,
    listWellness: vi.fn(),
    saveWellness: vi.fn(),
    deleteWellness: vi.fn(),
  };
});

const DEFAULT_BEVERAGE_TYPE = {
  id: "b0000000-0000-0000-0000-000000000000",
  beverageKey: "water",
  displayName: "水",
  defaultUnit: "ml" as const,
  defaultAmount: null,
  containsCaffeine: false,
  containsAlcohol: false,
  isDefault: true,
  sortOrder: 10,
  archivedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

function makeEntry(overrides: Partial<HydrationEntry> = {}): HydrationEntry {
  return {
    id: "entry-id",
    beverageTypeId: "type-id",
    beverageKey: "water",
    displayName: "水",
    recordedAt: "2026-09-01T08:00:00.000+09:00",
    unit: "ml",
    amount: 250,
    amountMl: 250,
    containsCaffeine: false,
    containsAlcohol: false,
    note: null,
    rowVersion: 1,
    clientMutationId: null,
    createdAt: "2026-09-01T08:00:00.000+09:00",
    updatedAt: "2026-09-01T08:00:00.000+09:00",
    ...overrides,
  };
}

function listResponse(entries: HydrationEntry[]) {
  return {
    resource: "hydration" as const,
    entries,
    beverageTypes: [DEFAULT_BEVERAGE_TYPE],
    symptomTypes: [],
    sleepGoals: [],
    hydrationGoals: [],
    context: { activeSleepGoal: null, activeHydrationGoal: null },
    page: { limit: 100, order: "desc" as const, nextCursor: null },
  };
}

beforeAll(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "0ed6f568-e1cd-42c5-889e-358a00748f21" });
});

afterEach(() => {
  vi.resetAllMocks();
});

describe("useWellness 409 recovery", () => {
  it("更新 409 後に id 直接取得で rowVersion を更新し再試行する", async () => {
    const entry = makeEntry();
    const refreshed = makeEntry({ amount: 300, amountMl: 300, rowVersion: 2 });

    vi.mocked(api.listWellness)
      .mockResolvedValueOnce(ok(listResponse([entry])))
      // 409 後の一覧再取得
      .mockResolvedValueOnce(ok(listResponse([entry])))
      // id 直接取得での対象特定
      .mockResolvedValueOnce(ok(listResponse([refreshed])))
      // 再試行成功後の refresh
      .mockResolvedValueOnce(ok(listResponse([refreshed])));
    vi.mocked(api.saveWellness)
      .mockResolvedValueOnce(err("WELLNESS_CONFLICT", "競合", 409))
      .mockResolvedValueOnce(
        ok({ resource: "hydration", entry: refreshed, outcome: "updated" as const }),
      );

    const { result } = renderHook(() => useWellness<HydrationEntry>("hydration"));

    await waitFor(() => expect(result.current.entries).toHaveLength(1));

    // 実際の操作フローを模倣: 編集ボタンクリック → setEditingEntry で state 更新 → 保存
    const setEditingEntry = vi.fn();
    const first = await result.current.saveEntry(
      {
        resource: "hydration",
        clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
        entry: {
          id: entry.id,
          expectedRowVersion: entry.rowVersion,
          beverageTypeId: entry.beverageTypeId,
          recordedAt: entry.recordedAt,
          amount: entry.amount,
          unit: entry.unit,
          containsCaffeine: entry.containsCaffeine,
          containsAlcohol: entry.containsAlcohol,
          note: entry.note,
        },
      },
      { editingEntry: entry, setEditingEntry },
    );
    expect(first).toBe(false);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict?.message).toBe("競合");

    // 409 後に setEditingEntry が呼ばれ、rowVersion が最新化されていることを検証（S12）
    expect(setEditingEntry).toHaveBeenCalledWith(
      expect.objectContaining({ id: entry.id, rowVersion: 2 }),
    );

    // 更新された editingEntry を使って再試行
    const updatedEditingEntry = setEditingEntry.mock.calls[0][0] as HydrationEntry;
    const second = await result.current.saveEntry(
      {
        resource: "hydration",
        clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
        entry: {
          id: updatedEditingEntry.id,
          expectedRowVersion: updatedEditingEntry.rowVersion,
          beverageTypeId: updatedEditingEntry.beverageTypeId,
          recordedAt: updatedEditingEntry.recordedAt,
          amount: updatedEditingEntry.amount,
          unit: updatedEditingEntry.unit,
          containsCaffeine: updatedEditingEntry.containsCaffeine,
          containsAlcohol: updatedEditingEntry.containsAlcohol,
          note: updatedEditingEntry.note,
        },
      },
      { editingEntry: updatedEditingEntry, setEditingEntry },
    );
    expect(second).toBe(true);

    expect(api.listWellness).toHaveBeenCalledWith(
      expect.objectContaining({ resource: "hydration", id: "entry-id" }),
    );
    expect(api.saveWellness).toHaveBeenLastCalledWith(
      expect.objectContaining({
        entry: expect.objectContaining({ expectedRowVersion: 2 }),
      }),
    );
  });

  it("目標の 409 後に goals を再取得して rowVersion を更新し再試行する", async () => {
    const goal: HydrationGoal = {
      id: "goal-id",
      targetAmountMl: 2000,
      weekdays: [1, 2, 3, 4, 5],
      timezone: "Asia/Tokyo",
      startDate: "2026-09-01",
      endDate: null,
      note: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    const refreshed: HydrationGoal = { ...goal, targetAmountMl: 2200, rowVersion: 2 };

    vi.mocked(api.listWellness)
      .mockResolvedValueOnce(ok(listResponse([])))
      .mockResolvedValueOnce(ok({ ...listResponse([]), hydrationGoals: [refreshed] }))
      .mockResolvedValueOnce(ok({ ...listResponse([]), hydrationGoals: [refreshed] }));
    vi.mocked(api.saveWellness)
      .mockResolvedValueOnce(err("WELLNESS_GOAL_CONFLICT", "目標が競合しています", 409))
      .mockResolvedValueOnce(
        ok({ resource: "hydration_goal", goal: refreshed, outcome: "updated" as const }),
      );

    const { result } = renderHook(() => useWellness<HydrationEntry>("hydration"));
    await waitFor(() => expect(result.current.loadingState).toBe("idle"));

    const setEditingGoal = vi.fn();
    const first = await result.current.saveGoal(
      {
        resource: "hydration_goal",
        clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
        goal: {
          id: goal.id,
          expectedRowVersion: goal.rowVersion,
          targetAmountMl: 2100,
          weekdays: goal.weekdays,
          startDate: goal.startDate,
        },
      },
      { editingGoal: goal, setEditingGoal },
    );
    expect(first).toBe(false);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict?.message).toBe("目標が競合しています");

    // 409 後に setEditingGoal が呼ばれ、rowVersion が最新化されていることを検証（C1）
    expect(setEditingGoal).toHaveBeenCalledWith(
      expect.objectContaining({ id: goal.id, rowVersion: 2 }),
    );

    const updatedEditingGoal = setEditingGoal.mock.calls[0][0] as HydrationGoal;
    const second = await result.current.saveGoal(
      {
        resource: "hydration_goal",
        clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
        goal: {
          id: updatedEditingGoal.id,
          expectedRowVersion: updatedEditingGoal.rowVersion,
          targetAmountMl: 2100,
          weekdays: updatedEditingGoal.weekdays,
          startDate: updatedEditingGoal.startDate,
        },
      },
      { editingGoal: updatedEditingGoal, setEditingGoal },
    );
    expect(second).toBe(true);

    expect(api.saveWellness).toHaveBeenLastCalledWith(
      expect.objectContaining({
        goal: expect.objectContaining({ expectedRowVersion: 2 }),
      }),
    );
  });
});
