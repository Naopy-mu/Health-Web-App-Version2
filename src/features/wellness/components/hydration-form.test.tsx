import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BeverageType, HydrationEntry } from "../schema";
import { HydrationForm } from "./hydration-form";

const WATER_TYPE: BeverageType = {
  id: "a0b23c4d-5e6f-789a-bcde-f01234567890",
  beverageKey: "water",
  displayName: "水",
  defaultUnit: "ml",
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

const ARCHIVED_TYPE: BeverageType = {
  ...WATER_TYPE,
  id: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  beverageKey: "archived",
  displayName: "アーカイブ済み",
  archivedAt: "2026-08-27T00:00:00.000Z",
};

beforeAll(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("HydrationForm", () => {
  it("アーカイブ済みの種別は選択肢に表示されない", async () => {
    render(
      <HydrationForm
        beverageTypes={[WATER_TYPE, ARCHIVED_TYPE]}
        editingEntry={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const select = screen.getByLabelText("飲み物") as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toContain("水");
    expect(options).not.toContain("アーカイブ済み");
  });

  it("量が 0 以下の場合にエラー", async () => {
    const onSubmit = vi.fn();
    render(
      <HydrationForm
        beverageTypes={[WATER_TYPE]}
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("量") as HTMLInputElement, { target: { value: "0" } });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() =>
      expect(screen.getByText("量は0より大きく10,000以下で入力してください。")).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("正しい入力で onSubmit が呼ばれる", async () => {
    const onSubmit = vi.fn();
    render(
      <HydrationForm
        beverageTypes={[WATER_TYPE]}
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("量") as HTMLInputElement, { target: { value: "250" } });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0] as HydrationEntry;
    expect(submitted.amount).toBe(250);
    expect(submitted.beverageTypeId).toBe(WATER_TYPE.id);
  });
});
