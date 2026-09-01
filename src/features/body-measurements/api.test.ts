// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  archiveMeasurementType,
  createMeasurementType,
  deleteGoal,
  deleteMeasurement,
  listGoals,
  listMeasurements,
  saveGoal,
  saveMeasurement,
  seedDefaultTypes,
} from "./api";
import type {
  ArchiveMeasurementTypeRequest,
  DeleteMeasurementGoalRequest,
  DeleteMeasurementRequest,
  Measurement,
  MeasurementGoal,
  MeasurementType,
  SaveMeasurementGoalRequest,
  SaveMeasurementRequest,
} from "./schema";

/**
 * API クライアントの fetch 呼び出しを検証する（S8）。
 * `../api` はモックせず、グローバルの fetch を stub して
 * メソッド・URL・Content-Type・ボディを確認する。
 */

type FetchMock = ReturnType<typeof vi.fn>;

function setupFetch(response: { status: number; body: unknown }): {
  fetchMock: FetchMock;
  lastRequest: { url: string; init: RequestInit };
} {
  const lastRequest = { url: "", init: {} as RequestInit };
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    lastRequest.url = url;
    lastRequest.init = init;
    return {
      ok: response.status >= 200 && response.status < 300,
      status: response.status,
      json: async () => response.body,
    } as Response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, lastRequest };
}

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

const MEASUREMENT: Measurement = {
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

const GOAL: MeasurementGoal = {
  id: "0d6d4309-46bf-4edf-8308-a390bdaf72cf",
  typeId: WEIGHT_TYPE.id,
  measurementKey: "weight",
  displayName: "体重",
  targetValue: 60,
  unit: "kg",
  startValue: null,
  targetDate: null,
  note: null,
  achievedAt: null,
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-08-27T00:00:00.000Z",
  updatedAt: "2026-08-27T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listMeasurements", () => {
  it("GET /api/measurements にクエリを付けて呼び、Accept: application/json を送る", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: {
        data: {
          measurements: [MEASUREMENT],
          types: [WEIGHT_TYPE],
          context: { heightCm: 168, latestWeightKg: 62.4, latestWeightMeasuredAt: null, bmi: 22.1 },
          page: { limit: 100, order: "desc", nextCursor: null },
        },
      },
    });

    const result = await listMeasurements({ order: "desc", limit: 50, typeId: WEIGHT_TYPE.id });
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe(`/api/measurements?typeId=${WEIGHT_TYPE.id}&order=desc&limit=50`);
    expect(lastRequest.init.method).toBe("GET");
    expect(lastRequest.init.headers).toMatchObject({ Accept: "application/json" });
  });

  it("from/to が ISO 8601 で送信される", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: {
        data: {
          measurements: [],
          types: [WEIGHT_TYPE],
          context: {
            heightCm: null,
            latestWeightKg: null,
            latestWeightMeasuredAt: null,
            bmi: null,
          },
          page: { limit: 100, order: "asc", nextCursor: "cursor-1" },
        },
      },
    });

    await listMeasurements({
      order: "asc",
      limit: 100,
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-31T23:59:59.999Z",
      cursor: "cursor-1",
    });
    expect(lastRequest.url).toContain("from=2026-08-01T00%3A00%3A00.000Z");
    expect(lastRequest.url).toContain("to=2026-08-31T23%3A59%3A59.999Z");
    expect(lastRequest.url).toContain("cursor=cursor-1");
  });
});

describe("saveMeasurement", () => {
  it("POST /api/measurements に JSON ボディを送る", async () => {
    const { lastRequest } = setupFetch({
      status: 201,
      body: { data: { measurement: MEASUREMENT, outcome: "created", derivedBmi: null } },
    });

    const request: SaveMeasurementRequest = {
      clientMutationId: "00000000-0000-0000-0000-000000000000",
      measurement: {
        typeId: WEIGHT_TYPE.id,
        measuredAt: "2026-08-27T07:30:00.000Z",
        value: 62.4,
        unit: "kg",
        note: null,
        measurementCondition: null,
        bodySite: null,
        photoReference: null,
      },
    };
    const result = await saveMeasurement(request);
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements");
    expect(lastRequest.init.method).toBe("POST");
    expect(lastRequest.init.headers).toMatchObject({
      "Content-Type": "application/json",
      Accept: "application/json",
    });
    expect(JSON.parse(String(lastRequest.init.body))).toEqual(request);
  });
});

describe("deleteMeasurement", () => {
  it("DELETE /api/measurements に JSON ボディを送る", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: { data: { deletedId: MEASUREMENT.id } },
    });

    const request: DeleteMeasurementRequest = {
      measurementId: MEASUREMENT.id,
      expectedRowVersion: 1,
    };
    const result = await deleteMeasurement(request);
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements");
    expect(lastRequest.init.method).toBe("DELETE");
    expect(JSON.parse(String(lastRequest.init.body))).toEqual(request);
  });
});

describe("seedDefaultTypes", () => {
  it("POST /api/measurements/types に action を送る", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: { data: { types: [WEIGHT_TYPE], outcome: "seeded" } },
    });

    const result = await seedDefaultTypes();
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements/types");
    expect(lastRequest.init.method).toBe("POST");
    expect(JSON.parse(String(lastRequest.init.body))).toEqual({ action: "seed_defaults" });
  });
});

describe("createMeasurementType", () => {
  it("POST /api/measurements/types に種別情報を送る", async () => {
    const { lastRequest } = setupFetch({
      status: 201,
      body: { data: { types: [WEIGHT_TYPE], outcome: "created" } },
    });

    const result = await createMeasurementType({
      action: "create",
      clientMutationId: "00000000-0000-0000-0000-000000000000",
      type: {
        measurementKey: "grip_strength",
        displayName: "握力",
        unitConstraint: "custom",
        defaultUnit: "custom",
        sortOrder: 1000,
      },
    });
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements/types");
    expect(JSON.parse(String(lastRequest.init.body))).toMatchObject({
      action: "create",
      type: { measurementKey: "grip_strength" },
    });
  });
});

describe("archiveMeasurementType", () => {
  it("PATCH /api/measurements/types/:id に JSON ボディを送る", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: { data: { type: WEIGHT_TYPE, outcome: "updated" } },
    });

    const request: ArchiveMeasurementTypeRequest = {
      clientMutationId: "00000000-0000-0000-0000-000000000000",
      expectedRowVersion: 1,
      archived: true,
    };
    const result = await archiveMeasurementType(WEIGHT_TYPE.id, request);
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe(`/api/measurements/types/${WEIGHT_TYPE.id}`);
    expect(lastRequest.init.method).toBe("PATCH");
    expect(JSON.parse(String(lastRequest.init.body))).toEqual(request);
  });
});

describe("listGoals", () => {
  it("GET /api/measurements/goals にクエリを付けて呼ぶ", async () => {
    const { lastRequest } = setupFetch({ status: 200, body: { data: { goals: [GOAL] } } });

    const result = await listGoals({ typeId: WEIGHT_TYPE.id, includeAchieved: true });
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe(
      `/api/measurements/goals?typeId=${WEIGHT_TYPE.id}&includeAchieved=true`,
    );
  });
});

describe("saveGoal", () => {
  it("POST /api/measurements/goals に JSON ボディを送る", async () => {
    const { lastRequest } = setupFetch({
      status: 201,
      body: { data: { goal: GOAL, outcome: "created" } },
    });

    const request: SaveMeasurementGoalRequest = {
      clientMutationId: "00000000-0000-0000-0000-000000000000",
      goal: {
        typeId: WEIGHT_TYPE.id,
        targetValue: 60,
        unit: "kg",
        startValue: null,
        targetDate: null,
        note: null,
        achievedAt: null,
      },
    };
    const result = await saveGoal(request);
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements/goals");
    expect(lastRequest.init.method).toBe("POST");
    expect(JSON.parse(String(lastRequest.init.body))).toEqual(request);
  });
});

describe("deleteGoal", () => {
  it("DELETE /api/measurements/goals に JSON ボディを送る", async () => {
    const { lastRequest } = setupFetch({
      status: 200,
      body: { data: { deletedId: GOAL.id } },
    });

    const request: DeleteMeasurementGoalRequest = { goalId: GOAL.id, expectedRowVersion: 1 };
    const result = await deleteGoal(request);
    expect(result.ok).toBe(true);
    expect(lastRequest.url).toBe("/api/measurements/goals");
    expect(lastRequest.init.method).toBe("DELETE");
    expect(JSON.parse(String(lastRequest.init.body))).toEqual(request);
  });
});

describe("エラー応答", () => {
  it("409 応答を ok:false として返す", async () => {
    setupFetch({
      status: 409,
      body: { error: { code: "MEASUREMENT_CONFLICT", message: "競合" } },
    });

    const result = await saveMeasurement({
      clientMutationId: "00000000-0000-0000-0000-000000000000",
      measurement: {
        id: MEASUREMENT.id,
        expectedRowVersion: 1,
        typeId: WEIGHT_TYPE.id,
        measuredAt: "2026-08-27T07:30:00.000Z",
        value: 62.4,
        unit: "kg",
        note: null,
        measurementCondition: null,
        bodySite: null,
        photoReference: null,
      },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(409);
      expect(result.error.code).toBe("MEASUREMENT_CONFLICT");
    }
  });
});
