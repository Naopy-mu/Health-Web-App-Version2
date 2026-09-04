import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { ConditionEntry, SymptomType } from "../schema";
import { ConditionForm } from "./condition-form";

const FEVER_TYPE: SymptomType = {
  id: "11111111-1111-1111-1111-111111111111",
  symptomKey: "fever",
  displayName: "発熱",
  isDefault: true,
  sortOrder: 10,
  archivedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const ARCHIVED_TYPE: SymptomType = {
  ...FEVER_TYPE,
  id: "22222222-2222-2222-2222-222222222222",
  symptomKey: "archived",
  displayName: "アーカイブ済み",
  archivedAt: "2026-08-27T00:00:00.000Z",
};

beforeAll(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000000" });
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("ConditionForm", () => {
  it("アーカイブ済みの症状は選択肢に表示されない", async () => {
    render(
      <ConditionForm
        symptomTypes={[FEVER_TYPE, ARCHIVED_TYPE]}
        editingEntry={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    expect(screen.getByLabelText("発熱")).toBeInTheDocument();
    expect(screen.queryByLabelText("アーカイブ済み")).not.toBeInTheDocument();
  });

  it("症状を追加して onSubmit に反映する", async () => {
    const onSubmit = vi.fn();
    render(
      <ConditionForm
        symptomTypes={[FEVER_TYPE]}
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    fireEvent.click(screen.getByLabelText("発熱") as HTMLInputElement);
    fireEvent.change(screen.getByLabelText("発熱のメモ") as HTMLInputElement, {
      target: { value: "37.8度" },
    });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0] as ConditionEntry;
    expect(submitted.symptoms).toHaveLength(1);
    expect(submitted.symptoms[0].symptomTypeId).toBe(FEVER_TYPE.id);
    expect(submitted.symptoms[0].note).toBe("37.8度");
  });

  it("serverError を表示する", async () => {
    render(
      <ConditionForm
        symptomTypes={[FEVER_TYPE]}
        editingEntry={null}
        onSubmit={vi.fn()}
        onCancel={vi.fn()}
        disabled={false}
        serverError="競合しました"
      />,
    );

    await waitFor(() => expect(screen.getByText("競合しました")).toBeInTheDocument());
  });
});
