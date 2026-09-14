import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { SleepPage } from "./sleep-page";

vi.mock("../use-wellness", () => ({
  useWellness: () => ({
    entries: [],
    sleepGoals: [],
    loadingState: "idle",
    error: null,
    conflict: null,
    nextCursor: null,
    isLoadingMore: false,
    loadMore: vi.fn(),
    load: vi.fn(),
    saveEntry: vi.fn(() => Promise.resolve(true)),
    removeEntry: vi.fn(() => Promise.resolve(true)),
    saveGoal: vi.fn(() => Promise.resolve(true)),
    removeGoal: vi.fn(() => Promise.resolve(true)),
  }),
}));

beforeAll(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "0ed6f568-e1cd-42c5-889e-358a00748f21" });
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

afterEach(() => {
  cleanup();
});

describe("SleepPage tabs", () => {
  it("タブに id が振られ、aria-controls が対応する tabpanel を指す", () => {
    render(<SleepPage />);

    const recordsTab = screen.getByRole("tab", { name: "睡眠記録" });
    const goalsTab = screen.getByRole("tab", { name: "目標" });

    expect(recordsTab).toHaveAttribute("id", "sleep-tab-records");
    expect(goalsTab).toHaveAttribute("id", "sleep-tab-goals");
    expect(recordsTab).toHaveAttribute("aria-controls", "sleep-panel-records");
    expect(goalsTab).toHaveAttribute("aria-controls", "sleep-panel-goals");

    const recordsPanel = document.getElementById("sleep-panel-records");
    expect(recordsPanel).toHaveAttribute("aria-labelledby", "sleep-tab-records");
  });

  it("矢印キーでタブ間を移動でき、tabindex が更新される", async () => {
    render(<SleepPage />);

    const recordsTab = screen.getByRole("tab", { name: "睡眠記録" });
    const goalsTab = screen.getByRole("tab", { name: "目標" });

    expect(recordsTab).toHaveAttribute("tabindex", "0");
    expect(goalsTab).toHaveAttribute("tabindex", "-1");

    await act(async () => {
      fireEvent.keyDown(recordsTab, { key: "ArrowRight" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    await waitFor(() => expect(goalsTab).toHaveAttribute("tabindex", "0"));
    expect(recordsTab).toHaveAttribute("tabindex", "-1");

    await act(async () => {
      fireEvent.keyDown(goalsTab, { key: "ArrowLeft" });
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });

    await waitFor(() => expect(recordsTab).toHaveAttribute("tabindex", "0"));
    expect(goalsTab).toHaveAttribute("tabindex", "-1");
  });
});
