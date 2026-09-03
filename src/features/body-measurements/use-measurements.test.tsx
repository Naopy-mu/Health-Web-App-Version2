import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useMeasurements } from "./use-measurements";
import type { Measurement, MeasurementType } from "./schema";

const WEIGHT_TYPE: MeasurementType = {
  id: "80df8359-7c51-4bd0-8dfa-e0bb4294a431",
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

const ORIGINAL_MEASUREMENT: Measurement = {
  id: "ee166b66-eb6d-464e-8b0e-ec9c8b3ab8e9",
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
};

const CONFLICT_ERROR = { error: { code: "MEASUREMENT_CONFLICT", message: "競合" } };

function emptyListResponse() {
  return {
    data: {
      measurements: [],
      types: [WEIGHT_TYPE],
      context: {
        heightCm: null,
        latestWeightKg: null,
        latestWeightMeasuredAt: null,
        bmi: null,
      },
      page: { limit: 100, order: "desc", nextCursor: null },
    },
  };
}

function listResponse(measurements: Measurement[]) {
  return {
    data: {
      measurements,
      types: [WEIGHT_TYPE],
      context: {
        heightCm: null,
        latestWeightKg: null,
        latestWeightMeasuredAt: null,
        bmi: null,
      },
      page: { limit: 100, order: "desc", nextCursor: null },
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("useMeasurements", () => {
  it("編集時に日時を変更して 409 になっても、永続値の measuredAt で対象特定クエリがヒットする（新規-9）", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];

    // 衝突しない新しい日時
    const newMeasuredAt = "2026-08-28T08:00:00.000Z";
    const updatedMeasurement: Measurement = {
      ...ORIGINAL_MEASUREMENT,
      rowVersion: 2,
      value: 63.0,
      updatedAt: "2026-08-27T08:00:00.000Z",
    };

    let saveAttempts = 0;

    const fetchMock = vi.fn(async (url: string, init: RequestInit = {}) => {
      requests.push({ url, init });

      if (url.startsWith("/api/measurements/goals")) {
        return { ok: true, status: 200, json: async () => ({ data: { goals: [] } }) } as Response;
      }

      if (url === "/api/measurements" && init.method === "POST") {
        saveAttempts++;
        const body = JSON.parse(String(init.body));
        if (saveAttempts === 1) {
          // 1 回目は 409（form から送信された新しい measuredAt を使っている）
          expect(body.measurement.measuredAt).toBe(newMeasuredAt);
          return { ok: false, status: 409, json: async () => CONFLICT_ERROR } as Response;
        }
        // 2 回目は rowVersion が最新化された後の再試行
        expect(body.measurement.expectedRowVersion).toBe(2);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            data: { measurement: updatedMeasurement, outcome: "updated", derivedBmi: null },
          }),
        } as Response;
      }

      if (url.startsWith("/api/measurements?")) {
        const params = new URLSearchParams(url.split("?")[1] ?? "");
        // 対象特定クエリ：typeId + from/to + limit=1
        if (params.get("typeId") && params.get("from") && params.get("limit") === "1") {
          // 永続値（元の measuredAt）でクエリが来ていることを検証
          expect(params.get("from")).toBe(ORIGINAL_MEASUREMENT.measuredAt);
          expect(params.get("to")).toBe(ORIGINAL_MEASUREMENT.measuredAt);
          return {
            ok: true,
            status: 200,
            json: async () => listResponse([updatedMeasurement]),
          } as Response;
        }
        // 通常の一覧再取得は空にして、対象特定クエリが必須な状況を作る
        return { ok: true, status: 200, json: async () => emptyListResponse() } as Response;
      }

      return { ok: false, status: 404, json: async () => ({ error: "not found" }) } as Response;
    });

    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useMeasurements());

    // 初期ロード完了を待つ
    await waitFor(() => expect(result.current.loadingState).toBe("idle"));

    // 編集対象をセット
    act(() => {
      result.current.setEditingMeasurement(ORIGINAL_MEASUREMENT);
    });

    // 日時を変更して更新（1 回目は 409）
    await act(async () => {
      await result.current.saveMeasurementRecord({
        id: ORIGINAL_MEASUREMENT.id,
        expectedRowVersion: ORIGINAL_MEASUREMENT.rowVersion,
        typeId: ORIGINAL_MEASUREMENT.typeId,
        measuredAt: newMeasuredAt,
        value: 63.0,
        unit: "kg",
        note: null,
        measurementCondition: null,
        bodySite: null,
        photoReference: null,
      });
    });

    // 対象特定クエリが発行され、editingMeasurement の rowVersion が最新化されている
    await waitFor(() => expect(result.current.editingMeasurement?.rowVersion).toBe(2));
    expect(result.current.conflict).not.toBeNull();

    // 再試行（rowVersion は editingMeasurement から読み替えて渡す）
    await act(async () => {
      await result.current.saveMeasurementRecord({
        id: ORIGINAL_MEASUREMENT.id,
        expectedRowVersion: result.current.editingMeasurement?.rowVersion ?? 2,
        typeId: ORIGINAL_MEASUREMENT.typeId,
        measuredAt: newMeasuredAt,
        value: 63.0,
        unit: "kg",
        note: null,
        measurementCondition: null,
        bodySite: null,
        photoReference: null,
      });
    });

    expect(saveAttempts).toBe(2);
  });
});
