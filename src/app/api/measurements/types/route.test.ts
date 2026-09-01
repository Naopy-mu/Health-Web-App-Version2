// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DEFAULT_MEASUREMENT_TYPES } from "@/features/body-measurements/defaults";
import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  uniqueViolation,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/** `POST /api/measurements/types`（実装仕様書 5.3節 / 7章）。 */

const APP_ORIGIN = "https://app.example";
const NEW_TYPE_ID = "7e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "8e2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { POST } = await import("./route");

const seededRows = DEFAULT_MEASUREMENT_TYPES.map((type, index) => ({
  id: `0000000${index}-5a69-4788-9900-aabbccddeeff`,
  measurement_key: type.measurementKey,
  display_name: type.displayName,
  unit_constraint: type.unitConstraint,
  default_unit: type.defaultUnit,
  is_default: true,
  sort_order: type.sortOrder,
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-01T00:00:00+00:00",
}));

const customRow = {
  id: NEW_TYPE_ID,
  measurement_key: "grip_strength",
  display_name: "握力",
  unit_constraint: "custom",
  default_unit: "custom",
  is_default: false,
  sort_order: 1000,
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-27T00:00:00+00:00",
  updated_at: "2026-08-27T00:00:00+00:00",
};

/**
 * 冪等キーの適用結果ログ（`body_measurement_mutation_log`、migration 20260827000800）の
 * 1件。再送の引き当ては行の現在値ではなくこのログから行う（実装仕様書 5.3節）。
 */
const loggedMutation = (snapshot: unknown) => ({ data: { snapshot }, error: null });

const useSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase(options);
  return supabaseState.fake;
};

const postRequest = (body: unknown) =>
  new NextRequest(new URL("/api/measurements/types", APP_ORIGIN), {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
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

describe("既定投入（実装仕様書 5.3節）", () => {
  it("seed_default_body_measurement_types RPC を呼び、既定10種別を返す", async () => {
    const fake = useSupabase({
      rpc: { seed_default_body_measurement_types: { data: seededRows, error: null } },
    });

    const response = await POST(postRequest({ action: "seed_defaults" }));

    expect(response.status).toBe(200);
    expect(fake.rpcCalls).toContain("seed_default_body_measurement_types");

    const data = await readData(response);
    expect(data.outcome).toBe("seeded");
    expect(
      (data.types as { measurementKey: string }[]).map((type) => type.measurementKey),
    ).toStrictEqual(DEFAULT_MEASUREMENT_TYPES.map((type) => type.measurementKey));
  });

  it("繰り返し呼んでも同じ結果になる（冪等）", async () => {
    const fake = useSupabase({
      rpc: { seed_default_body_measurement_types: { data: seededRows, error: null } },
    });

    const first = await readData(await POST(postRequest({ action: "seed_defaults" })));
    const second = await readData(await POST(postRequest({ action: "seed_defaults" })));

    expect(second).toStrictEqual(first);
    expect(
      fake.rpcCalls.filter((name) => name === "seed_default_body_measurement_types"),
    ).toHaveLength(2);
  });
});

describe("カスタム種別の追加（実装仕様書 5.3節）", () => {
  it("201 と outcome=created を返し、is_default 列には触れない", async () => {
    const fake = useSupabase({
      responses: { "insert:body_measurement_types": [{ data: customRow, error: null }] },
    });

    const response = await POST(
      postRequest({
        action: "create",
        type: {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
      }),
    );

    expect(response.status).toBe(201);
    const data = await readData(response);
    expect(data.outcome).toBe("created");

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values?.owner_id).toBe(DEFAULT_USER_ID);
    // 実装仕様書 5.3節: is_default は authenticated の列レベル権限から外れており、
    // 送ると permission denied になる。列の既定値 false に任せる。
    expect(insert?.values).not.toHaveProperty("is_default");
  });

  it("項目キーの重複は 409 MEASUREMENT_TYPE_CONFLICT", async () => {
    useSupabase({
      responses: {
        "insert:body_measurement_types": [
          { data: null, error: uniqueViolation("body_measurement_types_owner_key_key") },
        ],
      },
    });

    const response = await POST(
      postRequest({
        action: "create",
        type: {
          measurementKey: "grip_strength",
          displayName: "握力（重複）",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_CONFLICT");
  });

  it("既定カタログのキーは 400 MEASUREMENT_TYPE_KEY_RESERVED（既定種別の偽装を防ぐ）", async () => {
    const fake = useSupabase();

    for (const measurementKey of DEFAULT_MEASUREMENT_TYPES.map((type) => type.measurementKey)) {
      const response = await POST(
        postRequest({
          action: "create",
          type: {
            measurementKey,
            displayName: "自作",
            unitConstraint: "custom",
            defaultUnit: "custom",
          },
        }),
      );

      expect(response.status, measurementKey).toBe(400);
      expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_KEY_RESERVED");
    }

    // DB へ到達する前に拒否する（実装仕様書 9.2節）。
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);
  });

  it("unitConstraint は index も選べる（BMI 専用ではない。docs/api/measurements.md 2.2節）", async () => {
    // 予約されているのは `bmi` という項目キーだけで、単位制約 `index` は
    // 無次元の指標を測るカスタム種別からも選べる。
    const indexRow = {
      ...customRow,
      measurement_key: "body_score",
      display_name: "体スコア",
      unit_constraint: "index",
      default_unit: "index",
    };
    useSupabase({
      responses: { "insert:body_measurement_types": [{ data: indexRow, error: null }] },
    });

    const response = await POST(
      postRequest({
        action: "create",
        type: {
          measurementKey: "body_score",
          displayName: "体スコア",
          unitConstraint: "index",
          defaultUnit: "index",
        },
      }),
    );

    expect(response.status).toBe(201);
    const [created] = (await readData(response)).types as {
      unitConstraint: string;
      defaultUnit: string;
      isDefault: boolean;
    }[];
    expect(created).toMatchObject({
      unitConstraint: "index",
      defaultUnit: "index",
      isDefault: false,
    });
  });

  it("既定単位が単位制約に合わなければ 400 MEASUREMENT_UNIT_NOT_ALLOWED", async () => {
    const response = await POST(
      postRequest({
        action: "create",
        type: {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "mass",
          defaultUnit: "cm",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_UNIT_NOT_ALLOWED");
  });

  it("冪等キーが適用済みなら idempotent_replay を返す", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_mutation_log": [
          loggedMutation({ ...customRow, client_mutation_id: MUTATION_ID }),
        ],
      },
    });

    const response = await POST(
      postRequest({
        action: "create",
        clientMutationId: MUTATION_ID,
        type: {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("idempotent_replay");
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);
  });

  it("不正な項目キーは 400 INVALID_REQUEST", async () => {
    const response = await POST(
      postRequest({
        action: "create",
        type: {
          measurementKey: "Grip Strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });
});

describe("共通境界（実装仕様書 7章）", () => {
  it("same-origin でなければ 403", async () => {
    const request = new NextRequest(new URL("/api/measurements/types", APP_ORIGIN), {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ action: "seed_defaults" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でなければ 415", async () => {
    const request = new NextRequest(new URL("/api/measurements/types", APP_ORIGIN), {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: JSON.stringify({ action: "seed_defaults" }),
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
  });

  it("所有者IDの持ち込みは 400", async () => {
    const response = await POST(
      postRequest({ action: "seed_defaults", owner_id: DEFAULT_USER_ID }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.message).toContain("所有者ID");
  });

  it("成功応答も no-store", async () => {
    useSupabase({
      rpc: { seed_default_body_measurement_types: { data: seededRows, error: null } },
    });
    const response = await POST(postRequest({ action: "seed_defaults" }));
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
