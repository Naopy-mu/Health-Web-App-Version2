import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { BeverageType } from "../schema";
import { HydrationPage } from "./hydration-page";

let uuidCounter = 0;

function nextUuid() {
  uuidCounter += 1;
  return `00000000-0000-0000-0000-${String(uuidCounter).padStart(12, "0")}`;
}

const WATER_TYPE: BeverageType = {
  id: "11111111-1111-1111-1111-111111111111",
  beverageKey: "water",
  displayName: "水",
  defaultUnit: "ml",
  defaultAmount: 200,
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

const TEA_TYPE: BeverageType = {
  ...WATER_TYPE,
  id: "22222222-2222-2222-2222-222222222222",
  beverageKey: "tea",
  displayName: "お茶",
  defaultAmount: 150,
};

const saveEntry = vi.fn(() => Promise.resolve(true));
const saveGoal = vi.fn(() => Promise.resolve(true));

vi.mock("../use-wellness", () => ({
  useWellness: () => ({
    entries: [],
    beverageTypes: [WATER_TYPE, TEA_TYPE],
    activeBeverageTypes: [WATER_TYPE, TEA_TYPE],
    archivedBeverageTypes: [],
    hydrationGoals: [],
    loadingState: "idle",
    error: null,
    conflict: null,
    nextCursor: null,
    isLoadingMore: false,
    loadMore: vi.fn(),
    load: vi.fn(),
    saveEntry,
    removeEntry: vi.fn(() => Promise.resolve(true)),
    saveGoal,
    removeGoal: vi.fn(() => Promise.resolve(true)),
    saveType: vi.fn(() => Promise.resolve(true)),
    toggleArchiveType: vi.fn(() => Promise.resolve(true)),
  }),
}));

beforeAll(() => {
  uuidCounter = 0;
  vi.stubGlobal("crypto", { randomUUID: () => nextUuid() });
  class ResizeObserverMock {
    observe = vi.fn();
    unobserve = vi.fn();
    disconnect = vi.fn();
  }
  vi.stubGlobal("ResizeObserver", ResizeObserverMock);
  vi.stubGlobal(
    "matchMedia",
    vi.fn(() => ({ matches: false, addEventListener: vi.fn(), removeEventListener: vi.fn() })),
  );
  globalThis.URL.createObjectURL = vi.fn(() => "blob:mock");
  globalThis.URL.revokeObjectURL = vi.fn();
  globalThis.confirm = vi.fn(() => true);
});

beforeEach(() => {
  saveEntry.mockReset().mockResolvedValue(true);
  saveGoal.mockReset().mockResolvedValue(true);
});

afterEach(() => {
  cleanup();
});

function fmt(d: Date) {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

describe("HydrationPage idempotency keys", () => {
  it("記録保存の失敗後に目標保存が成功しても、記録の冪等キーは保持される", async () => {
    render(<HydrationPage />);

    const recordedAt = new Date(Date.now() - 1000 * 60 * 60 * 3);
    await waitFor(() => expect(screen.getByLabelText("量")).toBeInTheDocument());

    saveEntry.mockResolvedValueOnce(false);

    const amountInput = screen.getByLabelText("量") as HTMLInputElement;
    fireEvent.input(amountInput, { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("日時") as HTMLInputElement, {
      target: { value: fmt(recordedAt) },
    });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    const entryMutationId = (
      (saveEntry.mock.calls[0] as unknown[])[0] as { clientMutationId: string }
    ).clientMutationId;

    fireEvent.click(screen.getByRole("tab", { name: "目標" }));
    await waitFor(() => expect(screen.getByLabelText("目標量（ml）")).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText("目標量（ml）") as HTMLInputElement, {
      target: { value: "1800" },
    });
    fireEvent.change(screen.getByLabelText("開始日") as HTMLInputElement, {
      target: { value: "2026-09-14" },
    });
    fireEvent.click(screen.getByRole("button", { name: "目標を設定する" }));

    await waitFor(() => expect(saveGoal).toHaveBeenCalledTimes(1));

    fireEvent.click(screen.getByRole("tab", { name: "水分記録" }));
    await waitFor(() => expect(screen.getByLabelText("量")).toBeInTheDocument());

    fireEvent.input(screen.getByLabelText("量") as HTMLInputElement, { target: { value: "250" } });
    fireEvent.change(screen.getByLabelText("日時") as HTMLInputElement, {
      target: { value: fmt(recordedAt) },
    });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(2));
    const retryMutationId = (
      (saveEntry.mock.calls[1] as unknown[])[0] as { clientMutationId: string }
    ).clientMutationId;

    expect(entryMutationId).toBe(retryMutationId);
  });

  it("クイック追加の失敗後に別の飲み物を追加しても冪等キーが衝突しない", async () => {
    render(<HydrationPage />);

    await waitFor(() => expect(screen.getByRole("button", { name: /水/ })).toBeInTheDocument());

    saveEntry.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

    fireEvent.click(screen.getByRole("button", { name: /水/ }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(1));
    const waterMutationId = (
      (saveEntry.mock.calls[0] as unknown[])[0] as { clientMutationId: string }
    ).clientMutationId;

    fireEvent.click(screen.getByRole("button", { name: /お茶/ }));
    await waitFor(() => expect(saveEntry).toHaveBeenCalledTimes(2));
    const teaMutationId = (
      (saveEntry.mock.calls[1] as unknown[])[0] as { clientMutationId: string }
    ).clientMutationId;

    expect(waterMutationId).not.toBe(teaMutationId);
  });
});
