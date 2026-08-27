// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  uniqueViolation,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/**
 * `/api/measurements` の境界と挙動（実装仕様書 5.3節 / 6.4節 / 7章 / 9.2節）。
 *
 * 共通境界の実装そのものは `src/server/api/guards.test.ts` が検証する。
 * ここでは**このルートに実際に配線されているか**と、
 * 楽観ロック・冪等キー・重複登録防止の応答を確認する。
 */

const APP_ORIGIN = "https://app.example";
const TYPE_ID = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";
const OTHER_TYPE_ID = "2e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MEASUREMENT_ID = "3e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "4e2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { GET, POST, DELETE } = await import("./route");

/** 既定10種別のうち、テストで使う2件の行（`body_measurement_types`）。 */
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
  {
    id: OTHER_TYPE_ID,
    measurement_key: "waist",
    display_name: "ウエスト",
    unit_constraint: "length",
    default_unit: "cm",
    is_default: true,
    sort_order: 40,
    archived_at: null,
    row_version: 1,
    client_mutation_id: null,
    created_at: "2026-08-01T00:00:00+00:00",
    updated_at: "2026-08-01T00:00:00+00:00",
  },
];

/** 利用者が自分で作った kg 種別（例: 荷物の重さ）。BMI の算出元にはならない。 */
const CUSTOM_MASS_TYPE_ID = "5e2d3c4b-5a69-4788-9900-aabbccddeeff";
/** アーカイブ済みのカスタム種別。 */
const ARCHIVED_TYPE_ID = "6e2d3c4b-5a69-4788-9900-aabbccddeeff";

const customMassTypeRow = {
  id: CUSTOM_MASS_TYPE_ID,
  measurement_key: "luggage_weight",
  display_name: "荷物の重さ",
  unit_constraint: "mass",
  default_unit: "kg",
  is_default: false,
  sort_order: 1000,
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-01T00:00:00+00:00",
};

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

const measurementRow = (overrides: Record<string, unknown> = {}) => ({
  id: MEASUREMENT_ID,
  type_id: TYPE_ID,
  measured_at: "2026-08-27T07:30:00+00:00",
  value: 62.4,
  unit: "kg",
  normalized_value: 62.4,
  normalized_unit: "kg",
  note: null,
  measurement_condition: null,
  body_site: null,
  photo_reference: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-27T07:31:00+00:00",
  updated_at: "2026-08-27T07:31:00+00:00",
  ...overrides,
});

const useSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase({
    responses: { "select:body_measurement_types": [{ data: typeRows, error: null }] },
    ...options,
  });
  return supabaseState.fake;
};

const postRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL("/api/measurements", APP_ORIGIN), {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const deleteRequest = (body: unknown) =>
  new NextRequest(new URL("/api/measurements", APP_ORIGIN), {
    method: "DELETE",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getRequest = (query = "") =>
  new NextRequest(new URL(`/api/measurements${query}`, APP_ORIGIN), {
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

describe("共通境界の配線（実装仕様書 7章）", () => {
  it("same-origin でない POST は 403 SAME_ORIGIN_REQUIRED", async () => {
    const request = new NextRequest(new URL("/api/measurements", APP_ORIGIN), {
      method: "POST",
      headers: { origin: "https://evil.example", "content-type": "application/json" },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("Origin も Sec-Fetch-Site も無い GET は 403（フェイルクローズ）", async () => {
    const response = await GET(new NextRequest(new URL("/api/measurements", APP_ORIGIN)));
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でない POST は 415 JSON_REQUIRED", async () => {
    const request = new NextRequest(new URL("/api/measurements", APP_ORIGIN), {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
    expect((await readError(response)).error.code).toBe("JSON_REQUIRED");
  });

  it("64KiB を超えるボディは 413 PAYLOAD_TOO_LARGE", async () => {
    const request = postRequest({
      clientMutationId: MUTATION_ID,
      measurement: { typeId: TYPE_ID, measuredAt: "2026-08-27T07:30:00Z", value: 62, unit: "kg" },
    });
    // 実バイト数の検査を通す前に、宣言値だけで拒否されることを見る。
    request.headers.set("content-length", String(64 * 1024 + 1));

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect((await readError(response)).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("エラー応答は { error: { code, message } } 形式で no-store", async () => {
    const response = await POST(postRequest({ measurement: {} }));
    const body = await readError(response);

    expect(Object.keys(body)).toStrictEqual(["error"]);
    expect(Object.keys(body.error).sort()).toStrictEqual(["code", "message"]);
    expect(typeof body.error.message).toBe("string");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("成功応答も no-store を返す", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });

  it("Supabase未設定なら 503 / 未認証なら 401 / 非active なら 403", async () => {
    supabaseState.configured = false;
    const unavailable = await GET(getRequest());
    expect(unavailable.status).toBe(503);
    expect((await readError(unavailable)).error.code).toBe("ACCOUNT_SERVICE_UNAVAILABLE");

    supabaseState.configured = true;
    useSupabase({ user: null });
    const unauthenticated = await GET(getRequest());
    expect(unauthenticated.status).toBe(401);
    expect((await readError(unauthenticated)).error.code).toBe("AUTHENTICATION_REQUIRED");

    useSupabase({ isActiveUser: false });
    const inactive = await GET(getRequest());
    expect(inactive.status).toBe(403);
    expect((await readError(inactive)).error.code).toBe("ACCOUNT_INACTIVE");
  });
});

describe("入力検証（実装仕様書 9.2節 / 3.2節）", () => {
  it("所有者IDをボディに含めると 400 で拒否する", async () => {
    for (const field of ["owner_id", "ownerId", "user_id", "userId"]) {
      const response = await POST(
        postRequest({
          [field]: DEFAULT_USER_ID,
          measurement: {
            typeId: TYPE_ID,
            measuredAt: "2026-08-27T07:30:00Z",
            value: 62,
            unit: "kg",
          },
        }),
      );
      expect(response.status, field).toBe(400);
      expect((await readError(response)).error.message).toContain("所有者ID");
    }
  });

  it("ネストした所有者IDも拒否する", async () => {
    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62,
          unit: "kg",
          ownerId: DEFAULT_USER_ID,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.message).toContain("所有者ID");
  });

  it("未知フィールドは 400 INVALID_REQUEST", async () => {
    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62,
          unit: "kg",
          rowVersion: 9,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("配列ボディは 400", async () => {
    const response = await POST(postRequest([1, 2, 3]));
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("未知の測定種別は 404 MEASUREMENT_TYPE_NOT_FOUND", async () => {
    const response = await POST(
      postRequest({
        measurement: {
          typeId: "9e2d3c4b-5a69-4788-9900-aabbccddeeff",
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62,
          unit: "kg",
        },
      }),
    );
    expect(response.status).toBe(404);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_NOT_FOUND");
  });

  it("単位制約に合わない単位は 400 MEASUREMENT_UNIT_NOT_ALLOWED", async () => {
    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID, // 体重（mass）
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62,
          unit: "cm",
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_UNIT_NOT_ALLOWED");
  });

  it("他利用者の storage:// パスを指す写真参照は 400（実装仕様書 6.6節）", async () => {
    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62,
          unit: "kg",
          photoReference: `storage://health-images/00000000-0000-0000-0000-0000000000ff/${MEASUREMENT_ID}.jpg`,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.message).toContain("自分のストレージパス");
  });
});

describe("保存（実装仕様書 5.3節 / 6.4節）", () => {
  it("新規作成は 201 と outcome=created を返し、所有者をセッションから入れる", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "insert:body_measurements": [{ data: measurementRow(), error: null }],
        "select:user_profiles": [
          { data: { settings: { confirmed_profile: { heightCm: 168 } } }, error: null },
        ],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62.4,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(201);
    const data = await readData(response);
    expect(data.outcome).toBe("created");
    expect((data.measurement as { measurementKey: string }).measurementKey).toBe("weight");
    // 実装仕様書 5.3節: 体重の保存には BMI を添える（62.4 / 1.68^2 = 22.1）。
    expect(data.derivedBmi).toBe(22.1);

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values?.owner_id).toBe(DEFAULT_USER_ID);
    expect(insert?.values).not.toHaveProperty("row_version");
  });

  it("更新は id + owner_id + row_version を WHERE 句に含める（楽観ロック）", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "update:body_measurements": [
          { data: measurementRow({ row_version: 3, value: 61 }), error: null },
        ],
        "select:user_profiles": [{ data: { settings: {} }, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          id: MEASUREMENT_ID,
          expectedRowVersion: 2,
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 61,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("updated");

    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.filters).toStrictEqual([
      { op: "eq", column: "id", value: MEASUREMENT_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 2 },
    ]);
  });

  it("row_version 不一致（0件更新）は 409 MEASUREMENT_CONFLICT", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "update:body_measurements": [{ data: null, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          id: MEASUREMENT_ID,
          expectedRowVersion: 1,
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 61,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_CONFLICT");
  });

  it("冪等キーが適用済みなら同じ行を idempotent_replay として返す", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        // 冪等キーによる事前確認で既存行が見つかる。
        "select:body_measurements": [
          { data: measurementRow({ client_mutation_id: MUTATION_ID }), error: null },
        ],
        "select:user_profiles": [{ data: { settings: {} }, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        clientMutationId: MUTATION_ID,
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62.4,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(200);
    const data = await readData(response);
    expect(data.outcome).toBe("idempotent_replay");
    expect((data.measurement as { id: string }).id).toBe(MEASUREMENT_ID);

    // 再送は INSERT せずに終わる（二重登録しない。実装仕様書 6.4節）。
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);

    const lookup = fake.operations.find(
      (operation) => operation.kind === "select" && operation.table === "body_measurements",
    );
    expect(lookup?.filters).toStrictEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "client_mutation_id", value: MUTATION_ID },
    ]);
  });

  it("冪等キーの競合（一意制約違反）でも再読み取りして同じ成功を返す", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [
          // 事前確認では未適用。
          { data: null, error: null },
          // INSERT 競合後の再読み取りで見つかる。
          { data: measurementRow({ client_mutation_id: MUTATION_ID }), error: null },
        ],
        "insert:body_measurements": [
          {
            data: null,
            error: uniqueViolation("body_measurements_owner_client_mutation_key"),
          },
        ],
        "select:user_profiles": [{ data: { settings: {} }, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        clientMutationId: MUTATION_ID,
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62.4,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("idempotent_replay");
  });

  it("既定でない mass 種別からは BMI を算出しない（実装仕様書 5.3節）", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [...typeRows, customMassTypeRow], error: null }],
        "insert:body_measurements": [
          { data: measurementRow({ type_id: CUSTOM_MASS_TYPE_ID }), error: null },
        ],
        "select:user_profiles": [
          { data: { settings: { confirmed_profile: { heightCm: 168 } } }, error: null },
        ],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          typeId: CUSTOM_MASS_TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62.4,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(201);
    // 既定の体重種別ではないので、身長が分かっていても BMI は出さない。
    expect((await readData(response)).derivedBmi).toBeNull();
  });

  it("アーカイブ済み種別への新規登録は 400 MEASUREMENT_TYPE_ARCHIVED", async () => {
    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [...typeRows, archivedTypeRow], error: null }],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          typeId: ARCHIVED_TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 42,
          unit: "custom",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_TYPE_ARCHIVED");
    // DB へ到達する前に拒否する。
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);
  });

  it("アーカイブ済み種別でも既存記録の更新はできる（過去データを直せる）", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [...typeRows, archivedTypeRow], error: null }],
        "update:body_measurements": [
          {
            data: measurementRow({ type_id: ARCHIVED_TYPE_ID, unit: "custom", row_version: 3 }),
            error: null,
          },
        ],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          id: MEASUREMENT_ID,
          expectedRowVersion: 2,
          typeId: ARCHIVED_TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 41,
          unit: "custom",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("updated");
  });

  it("更新の 0 件でも冪等キーが適用済みなら 409 ではなく idempotent_replay", async () => {
    // 先着のリクエストが版番号を進めたあとに届いた再送。契約上は同じ成功応答を返す。
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [
          // 更新前の事前確認では未適用。
          { data: null, error: null },
          // 0 件更新のあとの再確認で、先着が書いた行が見つかる。
          {
            data: measurementRow({ row_version: 2, value: 61, client_mutation_id: MUTATION_ID }),
            error: null,
          },
        ],
        "update:body_measurements": [{ data: null, error: null }],
        "select:user_profiles": [{ data: { settings: {} }, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        clientMutationId: MUTATION_ID,
        measurement: {
          id: MEASUREMENT_ID,
          expectedRowVersion: 1,
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 61,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(200);
    const data = await readData(response);
    expect(data.outcome).toBe("idempotent_replay");
    expect((data.measurement as { rowVersion: number }).rowVersion).toBe(2);
  });

  it("同じ冪等キーの同時更新は、片方が updated・もう片方が idempotent_replay になる", async () => {
    // 2つのリクエストを実際に並行で流す。DB では片方だけが版番号一致で更新でき、
    // 遅れた側は 0 件更新になる。契約（実装仕様書 6.4節）では、遅れた側にも
    // 409 ではなく同じ成功応答を返さなければならない。
    useSupabase({
      responses: {
        "select:body_measurement_types": [
          { data: typeRows, error: null },
          { data: typeRows, error: null },
        ],
        "select:body_measurements": [
          // 双方の事前確認（まだ誰も適用していない）。
          { data: null, error: null },
          { data: null, error: null },
          // 0 件更新になった側の再確認。
          {
            data: measurementRow({ row_version: 2, value: 61, client_mutation_id: MUTATION_ID }),
            error: null,
          },
        ],
        "update:body_measurements": [
          // 先着だけが 1 件更新できる。
          {
            data: measurementRow({ row_version: 2, value: 61, client_mutation_id: MUTATION_ID }),
            error: null,
          },
          // 遅れた側は版番号が合わず 0 件。
          { data: null, error: null },
        ],
      },
    });

    const body = {
      clientMutationId: MUTATION_ID,
      measurement: {
        id: MEASUREMENT_ID,
        expectedRowVersion: 1,
        typeId: TYPE_ID,
        measuredAt: "2026-08-27T07:30:00Z",
        value: 61,
        unit: "kg",
      },
    };

    const [first, second] = await Promise.all([POST(postRequest(body)), POST(postRequest(body))]);

    expect([first.status, second.status]).toStrictEqual([200, 200]);

    const outcomes = [
      (await readData(first)).outcome as string,
      (await readData(second)).outcome as string,
    ].sort();
    expect(outcomes).toStrictEqual(["idempotent_replay", "updated"]);
  });

  it("同一の所有者・種別・日時の重複は 409 MEASUREMENT_DUPLICATE_CONFLICT", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "insert:body_measurements": [
          {
            data: null,
            error: uniqueViolation("body_measurements_owner_type_measured_at_key"),
          },
        ],
      },
    });

    const response = await POST(
      postRequest({
        measurement: {
          typeId: TYPE_ID,
          measuredAt: "2026-08-27T07:30:00Z",
          value: 62.4,
          unit: "kg",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_DUPLICATE_CONFLICT");
  });
});

describe("削除（実装仕様書 6.4節）", () => {
  it("expectedRowVersion を指定すると WHERE 句に入る", async () => {
    const fake = useSupabase({
      responses: { "delete:body_measurements": [{ data: { id: MEASUREMENT_ID }, error: null }] },
    });

    const response = await DELETE(
      deleteRequest({ measurementId: MEASUREMENT_ID, expectedRowVersion: 4 }),
    );

    expect(response.status).toBe(200);
    expect(await readData(response)).toStrictEqual({ deletedId: MEASUREMENT_ID });

    const remove = fake.operations.find((operation) => operation.kind === "delete");
    expect(remove?.filters).toStrictEqual([
      { op: "eq", column: "id", value: MEASUREMENT_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 4 },
    ]);
  });

  it("0件削除は 409 MEASUREMENT_CONFLICT（存在しない行と版番号違いを区別しない）", async () => {
    useSupabase({ responses: { "delete:body_measurements": [{ data: null, error: null }] } });

    const response = await DELETE(
      deleteRequest({ measurementId: MEASUREMENT_ID, expectedRowVersion: 1 }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("MEASUREMENT_CONFLICT");
  });
});

describe("一覧（実装仕様書 5.3節）", () => {
  it("記録・種別・BMI文脈・ページング情報を返す", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [
          { data: [measurementRow()], error: null },
          // BMI 用の最新体重。
          {
            data: { normalized_value: 62.4, measured_at: "2026-08-27T07:30:00+00:00" },
            error: null,
          },
        ],
        "select:user_profiles": [
          { data: { settings: { confirmed_profile: { heightCm: 168 } } }, error: null },
        ],
      },
    });

    const response = await GET(getRequest());
    expect(response.status).toBe(200);

    const data = await readData(response);
    expect((data.measurements as unknown[]).length).toBe(1);
    expect((data.types as unknown[]).length).toBe(2);
    expect(data.context).toStrictEqual({
      heightCm: 168,
      latestWeightKg: 62.4,
      latestWeightMeasuredAt: "2026-08-27T07:30:00.000Z",
      bmi: 22.1,
    });
    expect(data.page).toStrictEqual({ limit: 100, order: "desc", nextCursor: null });
  });

  it("weight キーでも既定種別でなければ context の体重・BMI を出さない", async () => {
    // 既定種別の偽装（同じキーのカスタム種別）を BMI 文脈へ波及させない。
    const impostor = { ...typeRows[0], is_default: false, unit_constraint: "custom" };

    const fake = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: [impostor], error: null }],
        "select:body_measurements": [{ data: [], error: null }],
        "select:user_profiles": [
          { data: { settings: { confirmed_profile: { heightCm: 168 } } }, error: null },
        ],
      },
    });

    const data = await readData(await GET(getRequest()));
    expect(data.context).toStrictEqual({
      heightCm: 168,
      latestWeightKg: null,
      latestWeightMeasuredAt: null,
      bmi: null,
    });

    // 最新体重の問い合わせ自体を行わない。
    const weightLookup = fake.operations.filter(
      (operation) => operation.columns === "normalized_value, measured_at",
    );
    expect(weightLookup).toStrictEqual([]);
  });

  it("CSV出力に必要な列（正規化値・単位・種別名）が応答に含まれる", async () => {
    useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [{ data: [measurementRow()], error: null }],
      },
    });

    const data = await readData(await GET(getRequest()));
    const first = (data.measurements as Record<string, unknown>[])[0];

    expect(Object.keys(first ?? {}).sort()).toStrictEqual([
      "bodySite",
      "clientMutationId",
      "createdAt",
      "displayName",
      "id",
      "measuredAt",
      "measurementCondition",
      "measurementKey",
      "normalizedUnit",
      "normalizedValue",
      "note",
      "photoReference",
      "rowVersion",
      "typeId",
      "unit",
      "updatedAt",
      "value",
    ]);
  });

  it("limit を超える件数があれば nextCursor を返し、次ページで続きから読む", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      measurementRow({
        id: `0000000${index}-5a69-4788-9900-aabbccddeeff`,
        measured_at: `2026-08-2${index + 1}T07:30:00+00:00`,
      }),
    );

    const first = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [{ data: rows, error: null }],
      },
    });

    const response = await GET(getRequest("?limit=2"));
    const data = await readData(response);

    expect((data.measurements as unknown[]).length).toBe(2);
    const nextCursor = (data.page as { nextCursor: string | null }).nextCursor;
    expect(nextCursor).not.toBeNull();

    // 次ページ要求ではキーセット条件が付く。
    const list = first.operations.find(
      (operation) => operation.kind === "select" && operation.table === "body_measurements",
    );
    expect(list?.limitValue).toBe(3); // limit + 1
    expect(list?.orders).toStrictEqual([
      { column: "measured_at", ascending: false },
      { column: "id", ascending: false },
    ]);

    const second = useSupabase({
      responses: {
        "select:body_measurement_types": [{ data: typeRows, error: null }],
        "select:body_measurements": [{ data: [], error: null }],
      },
    });
    await GET(getRequest(`?limit=2&cursor=${encodeURIComponent(nextCursor ?? "")}`));

    const paged = second.operations.find(
      (operation) => operation.kind === "select" && operation.table === "body_measurements",
    );
    expect(paged?.or).toContain("measured_at.lt.");
    expect(paged?.or).toContain("and(measured_at.eq.");
  });

  it("壊れた cursor は 400 INVALID_REQUEST", async () => {
    const response = await GET(getRequest("?cursor=not-a-cursor"));
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("期間・種別の絞り込みが所有者条件とともに WHERE 句へ入る", async () => {
    const fake = useSupabase();

    await GET(
      getRequest(
        `?typeId=${TYPE_ID}&from=2026-08-01T00%3A00%3A00Z&to=2026-08-31T23%3A59%3A59Z&order=asc`,
      ),
    );

    const list = fake.operations.find(
      (operation) => operation.kind === "select" && operation.table === "body_measurements",
    );
    expect(list?.filters).toStrictEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "type_id", value: TYPE_ID },
      { op: "gte", column: "measured_at", value: "2026-08-01T00:00:00Z" },
      { op: "lte", column: "measured_at", value: "2026-08-31T23:59:59Z" },
    ]);
    expect(list?.orders[0]).toStrictEqual({ column: "measured_at", ascending: true });
  });

  it("未知の測定種別キーでは空一覧を返す（エラーにしない）", async () => {
    const response = await GET(getRequest("?measurementKey=not_seeded_yet"));
    expect(response.status).toBe(200);
    expect((await readData(response)).measurements).toStrictEqual([]);
  });
});
