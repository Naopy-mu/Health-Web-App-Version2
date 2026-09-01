import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import * as api from "../api";
import type { Measurement, MeasurementGoal, MeasurementType } from "../schema";
import { MeasurementsPage } from "./measurements-page";

vi.mock("next/navigation", () => ({
  usePathname: () => "/measurements",
}));

vi.mock("../api", async () => {
  const actual = await vi.importActual<typeof import("../api")>("../api");
  return {
    ...actual,
    listMeasurements: vi.fn(),
    listGoals: vi.fn(),
    saveMeasurement: vi.fn(),
    deleteMeasurement: vi.fn(),
    saveGoal: vi.fn(),
    deleteGoal: vi.fn(),
    seedDefaultTypes: vi.fn(),
    createMeasurementType: vi.fn(),
    archiveMeasurementType: vi.fn(),
  };
});

const WEIGHT_TYPE: MeasurementType = {
  id: "00000000-0000-0000-0000-000000000001",
  measurementKey: "weight",
  displayName: "体重",
  unitConstraint: "mass",
  defaultUnit: "kg",
  isDefault: true,
  sortOrder: 10,
  archivedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const ARCHIVED_TYPE: MeasurementType = {
  id: "00000000-0000-0000-0000-000000000002",
  measurementKey: "archived_foo",
  displayName: "アーカイブ済み",
  unitConstraint: "custom",
  defaultUnit: "custom",
  isDefault: false,
  sortOrder: 1000,
  archivedAt: "2026-08-27T00:00:00.000Z",
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

const CUSTOM_TYPE: MeasurementType = {
  id: "00000000-0000-0000-0000-000000000003",
  measurementKey: "grip_strength",
  displayName: "握力",
  unitConstraint: "custom",
  defaultUnit: "custom",
  isDefault: false,
  sortOrder: 1000,
  archivedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

function makeMeasurement(overrides: Partial<Measurement> = {}): Measurement {
  return {
    id: "00000000-0000-0000-0000-000000000010",
    typeId: WEIGHT_TYPE.id,
    measurementKey: "weight",
    displayName: "体重",
    measuredAt: "2026-08-27T07:30:00.000Z",
    value: 62.4,
    unit: "kg",
    normalizedValue: 62.4,
    normalizedUnit: "kg",
    note: null,
    measurementCondition: null,
    bodySite: null,
    photoReference: null,
    rowVersion: 1,
    clientMutationId: null,
    createdAt: "2026-08-27T07:31:00.000Z",
    updatedAt: "2026-08-27T07:31:00.000Z",
    ...overrides,
  };
}

function makeListResponse(measurements: Measurement[], types: MeasurementType[] = [WEIGHT_TYPE]) {
  return {
    measurements,
    types,
    context: {
      heightCm: 168,
      latestWeightKg: 62.4,
      latestWeightMeasuredAt: "2026-08-27T07:30:00.000Z",
      bmi: 22.1,
    },
    page: { limit: 100, order: "desc" as const, nextCursor: null },
  };
}

function makeGoalsResponse(goals: MeasurementGoal[] = []) {
  return { goals };
}

function ok<T>(data: T): { ok: true; data: T } {
  return { ok: true, data };
}

function err(
  code: string,
  message: string,
  status: number,
): { ok: false; error: { code: string; message: string }; status: number } {
  return { ok: false, error: { code, message }, status };
}

beforeAll(() => {
  vi.stubGlobal("crypto", { randomUUID: () => "00000000-0000-0000-0000-000000000000" });
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
  vi.resetAllMocks();
  cleanup();
});

describe("MeasurementsPage", () => {
  it("初期読み込み後に記録一覧が表示される", async () => {
    vi.mocked(api.listMeasurements).mockResolvedValue(ok(makeListResponse([makeMeasurement()])));
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));

    render(<MeasurementsPage />);

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "測定記録一覧" })).toBeInTheDocument(),
    );
    expect(screen.getByText("62.4kg")).toBeInTheDocument();
  });

  it("新規記録を追加できる", async () => {
    const saved = makeMeasurement({
      id: "00000000-0000-0000-0000-000000000011",
      value: 63,
      measuredAt: "2026-08-28T07:30:00.000Z",
      rowVersion: 1,
    });
    vi.mocked(api.listMeasurements)
      .mockResolvedValueOnce(ok(makeListResponse([makeMeasurement()])))
      .mockResolvedValueOnce(ok(makeListResponse([makeMeasurement(), saved])));
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));
    vi.mocked(api.saveMeasurement).mockResolvedValue(
      ok({ measurement: saved, outcome: "created" as const, derivedBmi: null }),
    );

    render(<MeasurementsPage />);
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新規記録" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByLabelText("単位")).toHaveValue("kg"));

    const valueInput = screen.getByLabelText("値") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "63" } });
    await waitFor(() => expect(valueInput).toHaveValue(63));
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(screen.getByText("63kg")).toBeInTheDocument());
  });

  it("記録を編集できる", async () => {
    const measurement = makeMeasurement();
    const updated = makeMeasurement({ value: 61, rowVersion: 2 });
    vi.mocked(api.listMeasurements)
      .mockResolvedValueOnce(ok(makeListResponse([measurement])))
      .mockResolvedValueOnce(ok(makeListResponse([updated])));
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));
    vi.mocked(api.saveMeasurement).mockResolvedValue(
      ok({ measurement: updated, outcome: "updated" as const, derivedBmi: null }),
    );

    render(<MeasurementsPage />);
    await waitFor(() => expect(screen.getByText("62.4kg")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "記録を編集" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByLabelText("単位")).toHaveValue("kg"));

    const valueInput = screen.getByLabelText("値") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "61" } });
    await waitFor(() => expect(valueInput).toHaveValue(61));
    fireEvent.click(screen.getByRole("button", { name: "更新する" }));

    await waitFor(() => expect(screen.getByText("61kg")).toBeInTheDocument());
  });

  it("記録を削除できる", async () => {
    const measurement = makeMeasurement();
    vi.mocked(api.listMeasurements)
      .mockResolvedValueOnce(ok(makeListResponse([measurement])))
      .mockResolvedValueOnce(ok(makeListResponse([])));
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));
    vi.mocked(api.deleteMeasurement).mockResolvedValue(ok({ deletedId: measurement.id }));

    render(<MeasurementsPage />);
    await waitFor(() => expect(screen.getByText("62.4kg")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "削除" }));

    await waitFor(() => expect(screen.queryByText("62.4kg")).not.toBeInTheDocument());
  });

  it("楽観ロック競合時にサーバー側の最新値を提示する", async () => {
    const measurement = makeMeasurement();
    vi.mocked(api.listMeasurements)
      .mockResolvedValueOnce(ok(makeListResponse([measurement])))
      .mockResolvedValueOnce(ok(makeListResponse([makeMeasurement({ value: 65, rowVersion: 2 })])));
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));
    vi.mocked(api.saveMeasurement).mockResolvedValue(
      err("MEASUREMENT_CONFLICT", "他の利用者が更新しました。", 409),
    );

    render(<MeasurementsPage />);
    await waitFor(() => expect(screen.getByText("62.4kg")).toBeInTheDocument());

    fireEvent.click(screen.getByRole("button", { name: "編集" }));
    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "記録を編集" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByLabelText("単位")).toHaveValue("kg"));

    const valueInput = screen.getByLabelText("値") as HTMLInputElement;
    fireEvent.change(valueInput, { target: { value: "61" } });
    await waitFor(() => expect(valueInput).toHaveValue(61));
    fireEvent.click(screen.getByRole("button", { name: "更新する" }));

    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("他の利用者が更新しました"),
    );
    await waitFor(() => expect(screen.getByText("65kg")).toBeInTheDocument());
  });

  it("アーカイブ済みの種別は種別フィルタに表示されない", async () => {
    vi.mocked(api.listMeasurements).mockResolvedValue(
      ok(makeListResponse([], [WEIGHT_TYPE, ARCHIVED_TYPE])),
    );
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));

    render(<MeasurementsPage />);
    await waitFor(() => expect(screen.getByLabelText("種別")).toBeInTheDocument());

    const select = screen.getByLabelText("種別") as HTMLSelectElement;
    const options = Array.from(select.options).map((option) => option.textContent);
    expect(options).toContain("体重");
    expect(options).not.toContain("アーカイブ済み");
  });

  it("既定種別は編集不可と表示される", async () => {
    vi.mocked(api.listMeasurements).mockResolvedValue(
      ok(makeListResponse([], [WEIGHT_TYPE, CUSTOM_TYPE])),
    );
    vi.mocked(api.listGoals).mockResolvedValue(ok(makeGoalsResponse()));

    render(<MeasurementsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "種別管理" }));

    await waitFor(() => expect(screen.getByText("編集不可")).toBeInTheDocument());
    const rows = screen.getAllByRole("row");
    const defaultRow = rows.find((row) => row.textContent?.includes("体重"));
    const customRow = rows.find((row) => row.textContent?.includes("握力"));
    expect(defaultRow).toBeDefined();
    expect(customRow).toBeDefined();
    expect(defaultRow).not.toHaveTextContent("アーカイブ");
    expect(customRow).toHaveTextContent("アーカイブ");
  });

  it("目標を追加できる", async () => {
    const goal: MeasurementGoal = {
      id: "00000000-0000-0000-0000-000000000020",
      typeId: WEIGHT_TYPE.id,
      measurementKey: "weight",
      displayName: "体重",
      targetValue: 60,
      unit: "kg",
      startValue: 64,
      targetDate: "2026-12-31",
      note: null,
      achievedAt: null,
      rowVersion: 1,
      clientMutationId: null,
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    };
    vi.mocked(api.listMeasurements).mockResolvedValue(ok(makeListResponse([], [WEIGHT_TYPE])));
    vi.mocked(api.listGoals)
      .mockResolvedValueOnce(ok(makeGoalsResponse()))
      .mockResolvedValueOnce(ok(makeGoalsResponse([goal])));
    vi.mocked(api.saveGoal).mockResolvedValue(ok({ goal, outcome: "created" as const }));

    render(<MeasurementsPage />);
    fireEvent.click(screen.getByRole("tab", { name: "目標" }));

    await waitFor(() =>
      expect(screen.getByRole("heading", { name: "新規目標" })).toBeInTheDocument(),
    );
    await waitFor(() => expect(screen.getByLabelText("単位")).toHaveValue("kg"));

    const targetInput = screen.getByLabelText("目標値") as HTMLInputElement;
    fireEvent.change(targetInput, { target: { value: "60" } });
    await waitFor(() => expect(targetInput).toHaveValue(60));
    const startInput = screen.getByLabelText("開始値（任意）") as HTMLInputElement;
    fireEvent.change(startInput, { target: { value: "64" } });
    const dateInput = screen.getByLabelText("目標日（任意）") as HTMLInputElement;
    fireEvent.change(dateInput, { target: { value: "2026-12-31" } });
    fireEvent.click(screen.getByRole("button", { name: "目標を設定する" }));

    await waitFor(() => expect(screen.getByText("60kg")).toBeInTheDocument());
  });
});
