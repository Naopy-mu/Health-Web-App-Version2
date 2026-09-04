import "@testing-library/jest-dom/vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { HydrationEntry } from "./schema";
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
      { editingEntry: entry },
    );
    expect(first).toBe(false);
    await waitFor(() => expect(result.current.conflict).not.toBeNull());
    expect(result.current.conflict?.message).toBe("競合");

    // 409 後の id 直接取得で rowVersion が 2 に更新された状態をシミュレート
    const updated = makeEntry({ amount: 300, amountMl: 300, rowVersion: 2 });
    const second = await result.current.saveEntry(
      {
        resource: "hydration",
        clientMutationId: "0ed6f568-e1cd-42c5-889e-358a00748f21",
        entry: {
          id: updated.id,
          expectedRowVersion: updated.rowVersion,
          beverageTypeId: updated.beverageTypeId,
          recordedAt: updated.recordedAt,
          amount: updated.amount,
          unit: updated.unit,
          containsCaffeine: updated.containsCaffeine,
          containsAlcohol: updated.containsAlcohol,
          note: updated.note,
        },
      },
      { editingEntry: updated },
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
});
