// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  uniqueViolation,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/** `/api/measurements/goals`（実装仕様書 5.3節 / 6.4節 / 7章）。 */

const APP_ORIGIN = "https://app.example";
const TYPE_ID = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";
const GOAL_ID = "5e2d3c4b-5a69-4788-9900-aabbccddeeff";
const ARCHIVED_TYPE_ID = "6e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "9e2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { GET, POST, DELETE } = await import("./route");

const typeRows = [
  {
    id: TYPE_ID,
    measurement_key: "weight",
    display_name: "体重",
    unit_constraint: "mass",
    default_unit: "kg",
    is_default: true,
    sort_order: 10,
    archived_at: null,
    row_version: 1,
    client_mutation_id: null,
    created_at: "2026-08-01T00:00:00+00:00",
    updated_at: "2026-08-01T00:00:00+00:00",
  },
];

const archivedTypeRow = {
  id: ARCHIVED_TYPE_ID,
  measurement_key: "grip_strength",
  display_name: "握力",
  unit_constraint: "custom",
  default_unit: "custom",
  is_default: false,
  sort_order: 1000,
  archived_at: "2026-08-20T00:00:00+00:00",
  row_version: 2,
  client_mutation_id: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-20T00:00:00+00:00",
};

const goalRow = (overrides: Record<string, unknown> = {}) => ({
  id: GOAL_ID,
  type_id: TYPE_ID,
  target_value: 60,
  unit: "kg",
  start_value: 64,
  target_date: "2026-12-31",
  note: null,
  achieved_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-27T00:00:00+00:00",
  updated_at: "2026-08-27T00:00:00+00:00",
  ...overrides,
});

const useSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase({
    responses: { "select:body_measurement_types": [{ data: typeRows, error: null }] },
    ...options,
  });
  return supabaseState.fake;
};

const jsonRequest = (method: "POST" | "DELETE", body: unknown) =>
  new NextRequest(new URL("/api/measurements/goals", APP_ORIGIN), {
    method,
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getRequest = (query = "") =>
  new NextRequest(new URL(`/api/measurements/goals${query}`, APP_ORIGIN), {
    headers: { origin: APP_ORIGIN },
  });

const readError = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

const readData = async (response: Response) =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
  supabaseState.configured = true;
  useSupabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

describe("一覧", () => {
  it("既定では未達成の目標だけを所有者スコープで読む", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurement_goals": [{ data: [goalRow()], error: null }],
      },
    });

    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const goals = (await readData(response)).goals as Record<string, unknown>[];
    expect(goals).toHaveLength(1);
    expect(goals[0]?.measurementKey).toBe("weight");
    expect(goals[0]?.targetDate).toBe("2026-12-31");

    const list = fake.operations.find((operation) => operation.table === "body_measurement_goals");
    expect(list?.filters).toStrictEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "is", column: "achieved_at", value: null },
    ]);
  });

  it("includeAchieved=true なら達成済みも含める", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurement_goals": [{ data: [], error: null }],
      },
    });

    await GET(getRequest("?includeAchieved=true"));

    const list = fake.operations.find((operation) => operation.table === "body_measurement_goals");
    expect(list?.filters).toStrictEqual([{ op: "eq", column: "owner_id", value: DEFAULT_USER_ID }]);
  });
});

describe("保存（実装仕様書 6.4節）", () => {
  it("新規作成は 201 と outcome=created", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "insert:body_measurement_goals": [{ data: goalRow(), error: null }],
      },
    });

    const response = await POST(
      jsonRequest("POST", {
        goal: {
          typeId: TYPE_ID,
          targetValue: 60,
          unit: "kg",
          startValue: 64,
          targetDate: "2026-12-31",
        },
      }),
    );

    expect(response.status).toBe(201);
    expect((await readData(response)).outcome).toBe("created");

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values?.owner_id).toBe(DEFAULT_USER_ID);
  });

  it("未達成の目標が既にあれば 409 MEASUREMENT_GOAL_CONFLICT", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "insert:body_measurement_goals": [
          { data: null, error: uniqueViolation("body_measurement_goals_owner_type_active_key") },
        ],
      },
    });

    const response = await POST(
      jsonRequest("POST", { goal: { typeId: TYPE_ID, targetValue: 59, unit: "kg" } }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_GOAL_CONFLICT");
  });

  it("row_version 不一致の更新は 409 MEASUREMENT_CONFLICT", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "update:body_measurement_goals": [{ data: null, error: null }],
      },
    });

    const response = await POST(
      jsonRequest("POST", {
        goal: { id: GOAL_ID, expectedRowVersion: 1, typeId: TYPE_ID, targetValue: 59, unit: "kg" },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_CONFLICT");
  });

  it("更新は id + owner_id + row_version を WHERE 句に含める（楽観ロック）", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "update:body_measurement_goals": [
          { data: goalRow({ row_version: 3, target_value: 59 }), error: null },
        ],
      },
    });

    const response = await POST(
      jsonRequest("POST", {
        goal: { id: GOAL_ID, expectedRowVersion: 2, typeId: TYPE_ID, targetValue: 59, unit: "kg" },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("updated");

    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.filters).toStrictEqual([
      { op: "eq", column: "id", value: GOAL_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 2 },
    ]);
    // 版番号はサーバーが進める。保存する値には含めない（実装仕様書 6.4節）。
    expect(update?.values).not.toHaveProperty("row_version");
    expect(update?.values).not.toHaveProperty("owner_id");
  });

  it("冪等キーが適用済みなら同じ目標を idempotent_replay として返す", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurement_goals": [
          { data: goalRow({ client_mutation_id: MUTATION_ID }), error: null },
        ],
      },
    });

    const response = await POST(
      jsonRequest("POST", {
        clientMutationId: MUTATION_ID,
        goal: { typeId: TYPE_ID, targetValue: 60, unit: "kg" },
      }),
    );

    expect(response.status).toBe(200);
    const data = await readData(response);
    expect(data.outcome).toBe("idempotent_replay");
    expect((data.goal as { id: string }).id).toBe(GOAL_ID);

    // 再送は INSERT せずに終わる。
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);

    const lookup = fake.operations.find(
      (operation) => operation.kind === "select" && operation.table === "body_measurement_goals",
    );
    expect(lookup?.filters).toStrictEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "client_mutation_id", value: MUTATION_ID },
    ]);
  });

  it("同じ冪等キーの同時更新は、片方が updated・もう片方が idempotent_replay になる", async () => {
    // 実装仕様書 6.4節: 同時多重送信でも 409 にせず同一の成功応答を返す。
    useSupabase({
      responses: {
        "select:body_measurement_types": [
          { data: typeRows, error: null },
          { data: typeRows, error: null },
        ],
        "select:body_measurement_goals": [
          { data: null, error: null },
          { data: null, error: null },
          { data: goalRow({ row_version: 2, client_mutation_id: MUTATION_ID }), error: null },
        ],
        "update:body_measurement_goals": [
          { data: goalRow({ row_version: 2, client_mutation_id: MUTATION_ID }), error: null },
          { data: null, error: null },
        ],
      },
    });

    const body = {
      clientMutationId: MUTATION_ID,
      goal: { id: GOAL_ID, expectedRowVersion: 1, typeId: TYPE_ID, targetValue: 59, unit: "kg" },
    };

    const [first, second] = await Promise.all([
      POST(jsonRequest("POST", body)),
      POST(jsonRequest("POST", body)),
    ]);

    expect([first.status, second.status]).toStrictEqual([200, 200]);

    const outcomes = [
      (await readData(first)).outcome as string,
      (await readData(second)).outcome as string,
    ].sort();
    expect(outcomes).toStrictEqual(["idempotent_replay", "updated"]);
  });

  it("アーカイブ済み種別への新規目標は 400 MEASUREMENT_TYPE_ARCHIVED", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [...typeRows, archivedTypeRow], error: null }],
      },
    });

    const response = await POST(
      jsonRequest("POST", {
        goal: { typeId: ARCHIVED_TYPE_ID, targetValue: 45, unit: "custom" },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_ARCHIVED");
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);
  });

  it("単位制約に合わない単位は 400 MEASUREMENT_UNIT_NOT_ALLOWED", async () => {
    const response = await POST(
      jsonRequest("POST", { goal: { typeId: TYPE_ID, targetValue: 20, unit: "percent" } }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_UNIT_NOT_ALLOWED");
  });

  it("所有者IDの持ち込みは 400", async () => {
    const response = await POST(
      jsonRequest("POST", {
        goal: { typeId: TYPE_ID, targetValue: 60, unit: "kg", ownerId: DEFAULT_USER_ID },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.message).toContain("所有者ID");
  });
});

describe("削除", () => {
  it("所有者と版番号を WHERE 句に含める", async () => {
    const fake = useSupabase({
      responses: { "delete:body_measurement_goals": [{ data: { id: GOAL_ID }, error: null }] },
    });

    const response = await DELETE(
      jsonRequest("DELETE", { goalId: GOAL_ID, expectedRowVersion: 2 }),
    );

    expect(response.status).toBe(200);
    expect(await readData(response)).toStrictEqual({ deletedId: GOAL_ID });

    const remove = fake.operations.find((operation) => operation.kind === "delete");
    expect(remove?.filters).toStrictEqual([
      { op: "eq", column: "id", value: GOAL_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 2 },
    ]);
  });

  it("0件削除は 409", async () => {
    useSupabase({
      responses: { "delete:body_measurement_goals": [{ data: null, error: null }] },
    });

    const response = await DELETE(jsonRequest("DELETE", { goalId: GOAL_ID }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_CONFLICT");
  });
});

describe("共通境界（実装仕様書 7章）", () => {
  it("same-origin でない GET は 403", async () => {
    const response = await GET(new NextRequest(new URL("/api/measurements/goals", APP_ORIGIN)));
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でない POST は 415", async () => {
    const request = new NextRequest(new URL("/api/measurements/goals", APP_ORIGIN), {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
  });

  it("未認証は 401", async () => {
    useSupabase({ user: null });
    const response = await GET(getRequest());
    expect(response.status).toBe(401);
    expect((await readError(response)).error.code).toBe("AUTHENTICATION_REQUIRED");
  });
});
