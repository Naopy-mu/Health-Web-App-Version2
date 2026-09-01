// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/**
 * `PATCH /api/measurements/types/{id}`（実装仕様書 5.3節 / 6.4節 / 7章）。
 *
 * カスタム種別のアーカイブ／解除だけを扱う。削除は提供しない。
 */

const APP_ORIGIN = "https://app.example";
const CUSTOM_TYPE_ID = "7e2d3c4b-5a69-4788-9900-aabbccddeeff";
const DEFAULT_TYPE_ID = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";
const UNKNOWN_TYPE_ID = "9e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "8e2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { PATCH } = await import("./route");

const customTypeRow = (overrides: Record<string, unknown> = {}) => ({
  id: CUSTOM_TYPE_ID,
  measurement_key: "grip_strength",
  display_name: "握力",
  unit_constraint: "custom",
  default_unit: "custom",
  is_default: false,
  sort_order: 1000,
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-01T00:00:00+00:00",
  ...overrides,
});

const defaultTypeRow = {
  id: DEFAULT_TYPE_ID,
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
};

/**
 * 冪等キーの適用結果ログ（`body_measurement_mutation_log`、migration 20260827000800）の
 * 1件。再送の引き当ては行の現在値ではなくこのログから行う（実装仕様書 5.3節）。
 */
const loggedMutation = (snapshot: unknown) => ({ data: { snapshot }, error: null });

const useSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase({
    responses: {
      "select:body_measurement_types": [{ data: [defaultTypeRow, customTypeRow()], error: null }],
    },
    ...options,
  });
  return supabaseState.fake;
};

const call = (id: string, body: unknown) => {
  const request = new NextRequest(new URL(`/api/measurements/types/${id}`, APP_ORIGIN), {
    method: "PATCH",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return PATCH(request, { params: Promise.resolve({ id }) });
};

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

describe("アーカイブ（実装仕様書 5.3節）", () => {
  it("archived=true で archived_at を設定し、所有者と版番号を WHERE 句に含める", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [defaultTypeRow, customTypeRow()], error: null }],
        "update:body_measurement_types": [
          {
            data: customTypeRow({ archived_at: "2026-08-27T09:00:00+00:00", row_version: 2 }),
            error: null,
          },
        ],
      },
    });

    const response = await call(CUSTOM_TYPE_ID, { expectedRowVersion: 1, archived: true });

    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");

    const data = await readData(response);
    expect(data.outcome).toBe("updated");
    expect((data.type as { archivedAt: string | null }).archivedAt).toBe(
      "2026-08-27T09:00:00.000Z",
    );

    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.filters).toStrictEqual([
      { op: "eq", column: "id", value: CUSTOM_TYPE_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 1 },
    ]);
    expect(typeof update?.values?.archived_at).toBe("string");
    // 版番号・所有者はサーバーが決める。保存する値には含めない（実装仕様書 6.4節）。
    expect(update?.values).not.toHaveProperty("row_version");
    expect(update?.values).not.toHaveProperty("owner_id");
  });

  it("archived=false で archived_at を解除する", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [
          {
            data: [customTypeRow({ archived_at: "2026-08-20T00:00:00+00:00", row_version: 2 })],
            error: null,
          },
        ],
        "update:body_measurement_types": [{ data: customTypeRow({ row_version: 3 }), error: null }],
      },
    });

    const response = await call(CUSTOM_TYPE_ID, { expectedRowVersion: 2, archived: false });

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("updated");

    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.values?.archived_at).toBeNull();
  });

  it("既定種別のアーカイブは 400（DBへ到達させない）", async () => {
    const fake = useSupabase();

    const response = await call(DEFAULT_TYPE_ID, { expectedRowVersion: 1, archived: true });

    expect(response.status).toBe(400);
    const body = await readError(response);
    expect(body.error.code).toBe("INVALID_REQUEST");
    expect(body.error.message).toContain("既定の測定種別");
    expect(fake.operations.some((operation) => operation.kind === "update")).toBe(false);
  });

  it("所有者の種別に無い id は 404 MEASUREMENT_TYPE_NOT_FOUND", async () => {
    const response = await call(UNKNOWN_TYPE_ID, { expectedRowVersion: 1, archived: true });

    expect(response.status).toBe(404);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_NOT_FOUND");
  });

  it("版番号不一致（0件更新）は 409 MEASUREMENT_TYPE_CONFLICT", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [defaultTypeRow, customTypeRow()], error: null }],
        "update:body_measurement_types": [{ data: null, error: null }],
      },
    });

    const response = await call(CUSTOM_TYPE_ID, { expectedRowVersion: 1, archived: true });

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_CONFLICT");
  });

  it("冪等キーが適用済みなら idempotent_replay を返す", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [defaultTypeRow, customTypeRow()], error: null }],
        // 冪等キーによる事前確認は適用結果ログを引く。
        "select:body_measurement_mutation_log": [
          loggedMutation(
            customTypeRow({
              archived_at: "2026-08-27T09:00:00+00:00",
              row_version: 2,
              client_mutation_id: MUTATION_ID,
            }),
          ),
        ],
      },
    });

    const response = await call(CUSTOM_TYPE_ID, {
      clientMutationId: MUTATION_ID,
      expectedRowVersion: 1,
      archived: true,
    });

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("idempotent_replay");
    expect(fake.operations.some((operation) => operation.kind === "update")).toBe(false);
  });

  it("同じ冪等キーの同時アーカイブは 409 にならず idempotent_replay になる", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [defaultTypeRow, customTypeRow()], error: null }],
        "select:body_measurement_mutation_log": [
          // 冪等キーの事前確認（未適用）
          { data: null, error: null },
          // 0件更新のあとの再確認（先着が残したスナップショット）
          loggedMutation(
            customTypeRow({
              archived_at: "2026-08-27T09:00:00+00:00",
              row_version: 2,
              client_mutation_id: MUTATION_ID,
            }),
          ),
        ],
        "update:body_measurement_types": [{ data: null, error: null }],
      },
    });

    const response = await call(CUSTOM_TYPE_ID, {
      clientMutationId: MUTATION_ID,
      expectedRowVersion: 1,
      archived: true,
    });

    expect(response.status).toBe(200);
    const data = await readData(response);
    expect(data.outcome).toBe("idempotent_replay");
    expect((data.type as { rowVersion: number }).rowVersion).toBe(2);
  });
});

describe("入力検証・共通境界（実装仕様書 7章 / 9.2節）", () => {
  it("expectedRowVersion が無ければ 400", async () => {
    const response = await call(CUSTOM_TYPE_ID, { archived: true });
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("未知フィールドは 400（.strict()）", async () => {
    const response = await call(CUSTOM_TYPE_ID, {
      expectedRowVersion: 1,
      archived: true,
      isDefault: true,
    });
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("所有者IDの持ち込みは 400", async () => {
    const response = await call(CUSTOM_TYPE_ID, {
      expectedRowVersion: 1,
      archived: true,
      ownerId: DEFAULT_USER_ID,
    });
    expect(response.status).toBe(400);
    expect((await readError(response)).error.message).toContain("所有者ID");
  });

  it("UUID でないパスパラメータは 400", async () => {
    const response = await call("not-a-uuid", { expectedRowVersion: 1, archived: true });
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("same-origin でなければ 403", async () => {
    const request = new NextRequest(
      new URL(`/api/measurements/types/${CUSTOM_TYPE_ID}`, APP_ORIGIN),
      {
        method: "PATCH",
        headers: { origin: "https://evil.example", "content-type": "application/json" },
        body: JSON.stringify({ expectedRowVersion: 1, archived: true }),
      },
    );

    const response = await PATCH(request, { params: Promise.resolve({ id: CUSTOM_TYPE_ID }) });
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でなければ 415", async () => {
    const request = new NextRequest(
      new URL(`/api/measurements/types/${CUSTOM_TYPE_ID}`, APP_ORIGIN),
      {
        method: "PATCH",
        headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
        body: "{}",
      },
    );

    const response = await PATCH(request, { params: Promise.resolve({ id: CUSTOM_TYPE_ID }) });
    expect(response.status).toBe(415);
  });

  it("未認証は 401", async () => {
    useSupabase({ user: null });
    const response = await call(CUSTOM_TYPE_ID, { expectedRowVersion: 1, archived: true });
    expect(response.status).toBe(401);
    expect((await readError(response)).error.code).toBe("AUTHENTICATION_REQUIRED");
  });
});
