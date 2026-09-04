import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { BeverageType, SymptomType } from "../schema";
import { CUSTOM_SYMPTOM_TYPE_MAX } from "../defaults";
import { TypeManager } from "./type-manager";

const DEFAULT_BEVERAGE: BeverageType = {
  id: "b0000000-0000-0000-0000-000000000000",
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

function makeCustomSymptom(index: number): SymptomType {
  return {
    id: `c${String(index).padStart(35, "0")}`,
    symptomKey: `custom_${index}`,
    displayName: `症状${index}`,
    isDefault: false,
    sortOrder: 1000,
    archivedAt: null,
    rowVersion: 1,
    clientMutationId: null,
    createdAt: "2026-08-27T00:00:00.000Z",
    updatedAt: "2026-08-27T00:00:00.000Z",
  };
}

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

describe("TypeManager beverage", () => {
  it("既定種別はアーカイブできない", async () => {
    render(
      <TypeManager
        resource="hydration"
        activeTypes={[DEFAULT_BEVERAGE]}
        archivedTypes={[]}
        onCreate={vi.fn()}
        onArchiveToggle={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "アーカイブ" })).not.toBeInTheDocument();
  });
});

describe("TypeManager symptom", () => {
  it("カスタム症状が上限に達している場合、新規追加ボタンが無効になる", async () => {
    const types = Array.from({ length: CUSTOM_SYMPTOM_TYPE_MAX }, (_, i) => makeCustomSymptom(i));
    render(
      <TypeManager
        resource="condition"
        activeTypes={types}
        archivedTypes={[]}
        onCreate={vi.fn()}
        onArchiveToggle={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    expect(screen.getByRole("button", { name: "追加する" })).toBeDisabled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      `カスタム症状種別は${CUSTOM_SYMPTOM_TYPE_MAX}件までです。`,
    );
  });

  it("アーカイブ済みの種別は一覧に解除ボタンがある", async () => {
    const archived = { ...makeCustomSymptom(0), archivedAt: "2026-08-27T00:00:00.000Z" };
    render(
      <TypeManager
        resource="condition"
        activeTypes={[]}
        archivedTypes={[archived]}
        onCreate={vi.fn()}
        onArchiveToggle={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    expect(screen.getByRole("button", { name: "解除" })).toBeInTheDocument();
  });

  it("新規症状を作成できる", async () => {
    const onCreate = vi.fn().mockResolvedValue(true);
    render(
      <TypeManager
        resource="condition"
        activeTypes={[]}
        archivedTypes={[]}
        onCreate={onCreate}
        onArchiveToggle={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    fireEvent.change(screen.getByLabelText("項目キー") as HTMLInputElement, {
      target: { value: "custom_sore_throat" },
    });
    fireEvent.change(screen.getByLabelText("表示名") as HTMLInputElement, {
      target: { value: "のどの痛み" },
    });
    fireEvent.click(screen.getByRole("button", { name: "追加する" }));

    await waitFor(() => expect(onCreate).toHaveBeenCalled());
    expect(onCreate).toHaveBeenLastCalledWith(
      expect.objectContaining({ key: "custom_sore_throat", displayName: "のどの痛み" }),
    );
  });
});
