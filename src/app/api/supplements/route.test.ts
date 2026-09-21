// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteSupplementResponseSchema,
  saveSupplementResponseSchema,
  supplementListResponseSchema,
} from "@/features/supplements/schema";
import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  uniqueViolation,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/**
 * `/api/supplements` の境界と挙動（実装仕様書 5.6節 / 6.4節 / 7章 / 9.2節）。
 *
 * 共通境界の実装そのものは `src/server/api/guards.test.ts` が検証する。
 * ここでは**このルートに実際に配線されているか**と、リソースごとの分岐・
 * 楽観ロック・冪等キー・原子的RPCへの委譲を確認する。
 * DB の振る舞い（FEFO・制約・RLS・トリガー）は `tests/db/supplements*.test.ts`
 * が実データで見る。
 */

const APP_ORIGIN = "https://app.example";
const PRODUCT_ID = "1a2d3c4b-5a69-4788-9900-aabbccddeeff";
const ARCHIVED_PRODUCT_ID = "2a2d3c4b-5a69-4788-9900-aabbccddeeff";
const ENTRY_ID = "3a2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "4a2d3c4b-5a69-4788-9900-aabbccddeeff";
const LOT_ID = "5a2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { GET, POST, DELETE } = await import("./route");

const productRow = (overrides: Record<string, unknown> = {}) => ({
  id: PRODUCT_ID,
  product_key: "vitamin_c",
  name: "ビタミンC",
  name_normalized: "ビタミンc",
  brand: "テストブランド",
  category: "vitamin",
  form: "tablet",
  default_amount: 2,
  default_unit: "tablet",
  amount_per_container: 120,
  low_stock_threshold: 10,
  ingredient_note: null,
  safety_note: null,
  url: "https://example.com/vitamin-c",
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-01T00:00:00+00:00",
  updated_at: "2026-09-01T00:00:00+00:00",
  ...overrides,
});

const productRows = [
  productRow(),
  productRow({
    id: ARCHIVED_PRODUCT_ID,
    product_key: "old_iron",
    name: "旧・鉄",
    name_normalized: "旧・鉄",
    archived_at: "2026-09-02T00:00:00+00:00",
    row_version: 2,
  }),
];

const stockRows = [
  { product_id: PRODUCT_ID, remaining_total: 42, lot_count: 2, nearest_expires_on: "2027-01-31" },
  {
    product_id: ARCHIVED_PRODUCT_ID,
    remaining_total: 0,
    lot_count: 0,
    nearest_expires_on: null,
  },
];

const summaryRows = [
  {
    weekly_scheduled_count: 7,
    weekly_taken_count: 5,
    monthly_taken_count: 22,
    low_stock_product_count: 1,
    expiring_lot_count: 0,
  },
];

const scheduleRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  product_id: PRODUCT_ID,
  schedule_kind: "daily",
  time_of_day: "08:00:00",
  timezone: "Asia/Tokyo",
  weekdays: null,
  start_date: "2026-09-01",
  end_date: null,
  amount: 2,
  unit: "tablet",
  meal_relation: "after_meal",
  note: null,
  archived_at: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-01T00:00:00+00:00",
  updated_at: "2026-09-01T00:00:00+00:00",
  ...overrides,
});

const lotRow = (overrides: Record<string, unknown> = {}) => ({
  id: LOT_ID,
  product_id: PRODUCT_ID,
  lot_code: "L-001",
  quantity: 60,
  remaining_quantity: 42,
  unit: "tablet",
  purchased_on: "2026-08-01",
  opened_on: "2026-08-10",
  expires_on: "2027-01-31",
  note: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-08-01T00:00:00+00:00",
  updated_at: "2026-08-10T00:00:00+00:00",
  ...overrides,
});

const intakeRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  product_id: PRODUCT_ID,
  schedule_id: null,
  status: "taken",
  scheduled_for: null,
  recorded_at: "2026-09-15T09:00:00+00:00",
  timezone: "Asia/Tokyo",
  amount: 2,
  unit: "tablet",
  consumed_quantity: 2,
  idempotency_key: "intake-20260915-0900",
  voided_at: null,
  void_reason: null,
  note: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-15T09:00:00+00:00",
  updated_at: "2026-09-15T09:00:00+00:00",
  ...overrides,
});

const movementRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  product_id: PRODUCT_ID,
  lot_id: LOT_ID,
  intake_log_id: null,
  movement_kind: "purchase",
  quantity_delta: 60,
  unit: "tablet",
  occurred_at: "2026-08-01T00:00:00+00:00",
  note: null,
  created_at: "2026-08-01T00:00:00+00:00",
  ...overrides,
});

/** 冪等キーの適用結果ログ（`supplement_mutation_log`）の1件。 */
const loggedMutation = (snapshot: unknown) => ({ data: { snapshot }, error: null });

const CATALOG_RESPONSES = {
  "select:supplement_products": [{ data: productRows, error: null }],
};

const CATALOG_RPC = {
  supplement_product_stock: { data: stockRows, error: null },
  supplement_summary: { data: summaryRows, error: null },
};

/** テスト用の Supabase 代替を差し替える（React のフックではない）。 */
const mockSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase({
    ...options,
    responses: { ...CATALOG_RESPONSES, ...(options.responses ?? {}) },
    rpc: { ...CATALOG_RPC, ...(options.rpc ?? {}) },
  });
  return supabaseState.fake;
};

const postRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL("/api/supplements", APP_ORIGIN), {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const deleteRequest = (body: unknown) =>
  new NextRequest(new URL("/api/supplements", APP_ORIGIN), {
    method: "DELETE",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getRequest = (query = "") =>
  new NextRequest(new URL(`/api/supplements${query}`, APP_ORIGIN), {
    headers: { origin: APP_ORIGIN },
  });

const readError = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

const validProduct = {
  productKey: "magnesium",
  name: "マグネシウム",
  category: "mineral" as const,
  form: "capsule" as const,
  defaultAmount: 1,
  defaultUnit: "capsule" as const,
};

const validIntake = {
  productId: PRODUCT_ID,
  idempotencyKey: "intake-20260915-0900",
  recordedAt: "2026-09-15T09:00:00Z",
  amount: 2,
};

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_APP_URL", APP_ORIGIN);
  supabaseState.configured = true;
  mockSupabase();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});

/* -------------------------------------------------------------------------- */

describe("共通境界の配線（実装仕様書 7章）", () => {
  it("same-origin でない POST は 403 SAME_ORIGIN_REQUIRED", async () => {
    const request = new NextRequest(new URL("/api/supplements", APP_ORIGIN), {
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
    const response = await GET(new NextRequest(new URL("/api/supplements", APP_ORIGIN)));
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でない POST は 415 JSON_REQUIRED", async () => {
    const request = new NextRequest(new URL("/api/supplements", APP_ORIGIN), {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
    expect((await readError(response)).error.code).toBe("JSON_REQUIRED");
  });

  it("64KiB を超えるボディは 413 PAYLOAD_TOO_LARGE", async () => {
    const request = postRequest({ resource: "product", product: validProduct });
    request.headers.set("content-length", String(64 * 1024 + 1));

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect((await readError(response)).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("所有者IDの持ち込みは 400（実装仕様書 3.2節）", async () => {
    const response = await POST(
      postRequest({ resource: "product", product: { ...validProduct, ownerId: DEFAULT_USER_ID } }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("未知フィールドは 400（Zod .strict()）", async () => {
    const response = await POST(
      postRequest({ resource: "product", product: validProduct, extra: 1 }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("Supabase未設定は 503、未認証は 401、非activeは 403", async () => {
    supabaseState.configured = false;
    expect((await GET(getRequest())).status).toBe(503);

    supabaseState.configured = true;
    mockSupabase({ user: null });
    expect((await GET(getRequest())).status).toBe(401);

    mockSupabase({ isActiveUser: false });
    expect((await GET(getRequest())).status).toBe(403);
  });

  it("成功応答にも no-store が付く", async () => {
    const response = await GET(getRequest("?resource=intake"));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});

/* -------------------------------------------------------------------------- */

describe("GET /api/supplements", () => {
  it("既定の resource は intake。商品カタログと集計が必ず同梱される", async () => {
    const fake = mockSupabase({
      responses: { "select:supplement_intake_logs": [{ data: [intakeRow()], error: null }] },
    });

    const response = await GET(getRequest());
    expect(response.status).toBe(200);

    const body = supplementListResponseSchema.parse(await response.json());
    expect(body.data.resource).toBe("intake");
    expect(body.data.products).toHaveLength(2);
    expect(body.data.summary.weeklyScheduledCount).toBe(7);

    // 商品には在庫要約が載る（低在庫の判定込み）。
    const product = body.data.products.find((entry) => entry.id === PRODUCT_ID);
    expect(product?.stock).toStrictEqual({
      remainingTotal: 42,
      lotCount: 2,
      nearestExpiresOn: "2027-01-31",
      lowStock: false,
    });
    // しきい値 10 に対して残量 0 の商品は低在庫。
    const archived = body.data.products.find((entry) => entry.id === ARCHIVED_PRODUCT_ID);
    expect(archived?.stock.lowStock).toBe(true);

    // 所有者は必ずセッション由来（実装仕様書 3.2節）。
    const intakeSelect = fake.operations.find(
      (operation) => operation.table === "supplement_intake_logs",
    );
    expect(intakeSelect?.filters).toContainEqual({
      op: "eq",
      column: "owner_id",
      value: DEFAULT_USER_ID,
    });
  });

  it("resource ごとに異なる時間軸で並べ替える", async () => {
    for (const [resource, table, column] of [
      ["schedule", "supplement_schedules", "created_at"],
      ["lot", "supplement_inventory_lots", "created_at"],
      ["intake", "supplement_intake_logs", "recorded_at"],
      ["movement", "supplement_inventory_movements", "occurred_at"],
    ] as const) {
      const fake = mockSupabase();
      await GET(getRequest(`?resource=${resource}`));
      const operation = fake.operations.find((entry) => entry.table === table);
      expect(operation?.orders[0]).toStrictEqual({ column, ascending: false });
      expect(operation?.orders[1]).toStrictEqual({ column: "id", ascending: false });
    }
  });

  it("id 指定は主キーの1件取得になり、絞り込みにも limit にも依存しない", async () => {
    const fake = mockSupabase({
      responses: { "select:supplement_intake_logs": [{ data: intakeRow(), error: null }] },
    });

    const response = await GET(getRequest(`?resource=intake&id=${ENTRY_ID}`));
    expect(response.status).toBe(200);

    const body = supplementListResponseSchema.parse(await response.json());
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.page.nextCursor).toBeNull();

    const operation = fake.operations.find((entry) => entry.table === "supplement_intake_logs");
    expect(operation?.single).toBe(true);
    expect(operation?.filters).toStrictEqual([
      { op: "eq", column: "id", value: ENTRY_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
    ]);
    expect(operation?.limitValue).toBeUndefined();
  });

  it("id で引いた0件は空配列（本当に存在しない）", async () => {
    mockSupabase({
      responses: { "select:supplement_intake_logs": [{ data: null, error: null }] },
    });

    const response = await GET(getRequest(`?resource=intake&id=${ENTRY_ID}`));
    const body = supplementListResponseSchema.parse(await response.json());
    expect(body.data.entries).toStrictEqual([]);
  });

  it("id と他の絞り込みの併用は 400", async () => {
    const response = await GET(
      getRequest(`?resource=intake&id=${ENTRY_ID}&productId=${PRODUCT_ID}`),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("status は resource=intake のときだけ使える", async () => {
    const ok = await GET(getRequest("?resource=intake&status=voided"));
    expect(ok.status).toBe(200);

    const rejected = await GET(getRequest("?resource=lot&status=voided"));
    expect(rejected.status).toBe(400);
  });

  it("productId / status が WHERE 句へ渡る", async () => {
    const fake = mockSupabase();
    await GET(getRequest(`?resource=intake&productId=${PRODUCT_ID}&status=taken`));

    const operation = fake.operations.find((entry) => entry.table === "supplement_intake_logs");
    expect(operation?.filters).toContainEqual({
      op: "eq",
      column: "product_id",
      value: PRODUCT_ID,
    });
    expect(operation?.filters).toContainEqual({ op: "eq", column: "status", value: "taken" });
  });

  it("次ページがあるとカーソルを返し、1件多く読む", async () => {
    const rows = Array.from({ length: 3 }, (_, index) =>
      intakeRow({
        id: `3a2d3c4b-5a69-4788-9900-aabbccddee0${index}`,
        recorded_at: `2026-09-1${index + 1}T09:00:00+00:00`,
      }),
    );
    const fake = mockSupabase({
      responses: { "select:supplement_intake_logs": [{ data: rows, error: null }] },
    });

    const response = await GET(getRequest("?resource=intake&limit=2"));
    const body = supplementListResponseSchema.parse(await response.json());

    expect(body.data.entries).toHaveLength(2);
    expect(body.data.page.nextCursor).not.toBeNull();
    const operation = fake.operations.find((entry) => entry.table === "supplement_intake_logs");
    expect(operation?.limitValue).toBe(3);
  });

  it("壊れた cursor は 400", async () => {
    const response = await GET(getRequest("?resource=intake&cursor=not-a-cursor"));
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("在庫の動きは商品ラベル付きで返る（監査画面が商品名を引き直さずに済む）", async () => {
    mockSupabase({
      responses: {
        "select:supplement_inventory_movements": [{ data: [movementRow()], error: null }],
      },
    });

    const response = await GET(getRequest("?resource=movement"));
    const body = supplementListResponseSchema.parse(await response.json());
    expect(body.data.resource).toBe("movement");
    if (body.data.resource !== "movement") {
      throw new Error("unreachable");
    }
    expect(body.data.entries[0]?.productName).toBe("ビタミンC");
    expect(body.data.entries[0]?.quantityDelta).toBe(60);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/supplements — 商品", () => {
  it("作成は 201 を返し、所有者はセッション由来、product_key は作成時のみ", async () => {
    const created = productRow({ product_key: "magnesium", name: "マグネシウム" });
    const fake = mockSupabase({
      responses: { "insert:supplement_products": [{ data: created, error: null }] },
    });

    const response = await POST(postRequest({ resource: "product", product: validProduct }));
    expect(response.status).toBe(201);

    const body = saveSupplementResponseSchema.parse(await response.json());
    expect(body.data.resource).toBe("product");
    if (body.data.resource !== "product") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("created");

    const insert = fake.operations.find(
      (entry) => entry.kind === "insert" && entry.table === "supplement_products",
    );
    expect(insert?.values?.["owner_id"]).toBe(DEFAULT_USER_ID);
    expect(insert?.values?.["product_key"]).toBe("magnesium");
  });

  it("更新は楽観ロックの WHERE 句を必ず付ける（実装仕様書 6.4節）", async () => {
    const fake = mockSupabase({
      responses: {
        "update:supplement_products": [{ data: productRow({ row_version: 2 }), error: null }],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC（改）",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );
    expect(response.status).toBe(200);

    const update = fake.operations.find((entry) => entry.kind === "update");
    expect(update?.filters).toStrictEqual([
      { op: "eq", column: "id", value: PRODUCT_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 1 },
    ]);
    // stableKey は更新の値に混ざらない。
    expect(update?.values).not.toHaveProperty("product_key");
  });

  it("更新で productKey を送ると 400（作成後は変更できない）", async () => {
    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          productKey: "renamed",
          name: "ビタミンC",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("名称の重複は 409 SUPPLEMENT_DUPLICATE_CONFLICT", async () => {
    mockSupabase({
      responses: {
        "insert:supplement_products": [
          { data: null, error: uniqueViolation("supplement_products_owner_name_key") },
        ],
      },
    });

    const response = await POST(postRequest({ resource: "product", product: validProduct }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_DUPLICATE_CONFLICT");
  });

  /* ---------------------------------------------------------------- */
  /* 409 の内訳（実装仕様書 6.4節 / docs/api/supplements.md 1.4節）   */
  /* ---------------------------------------------------------------- */

  it("版番号不一致の更新0件は 409 SUPPLEMENT_CONFLICT（重複競合ではない）", async () => {
    // 一意制約違反は起きていない。単に WHERE row_version が一致しなかっただけ。
    const fake = mockSupabase({
      responses: { "update:supplement_products": [{ data: null, error: null }] },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC（改）",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");

    // 楽観ロックの UPDATE は確かに投げている（0件だった）。
    const update = fake.operations.find((entry) => entry.kind === "update");
    expect(update?.filters).toContainEqual({ op: "eq", column: "row_version", value: 1 });
  });

  it("更新での一意制約違反は 409 SUPPLEMENT_DUPLICATE_CONFLICT のまま", async () => {
    mockSupabase({
      responses: {
        "update:supplement_products": [
          { data: null, error: uniqueViolation("supplement_products_owner_name_key") },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "旧・鉄", // 既存の別商品と同じ名前
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_DUPLICATE_CONFLICT");
  });

  it("409 SUPPLEMENT_CONFLICT のあと、products から id で引き直して再送すると通る", async () => {
    // 1. 古い版番号で更新 → 0件 → SUPPLEMENT_CONFLICT。
    mockSupabase({
      responses: { "update:supplement_products": [{ data: null, error: null }] },
    });

    const conflicted = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC（改）",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );
    expect(conflicted.status).toBe(409);
    expect((await readError(conflicted)).error.code).toBe("SUPPLEMENT_CONFLICT");

    // 2. 復帰分岐（1.8節「商品には対象特定クエリが要らない」）。
    //    商品はどの GET の応答にも全件入るので、その中から id で探す。
    mockSupabase({
      responses: {
        "select:supplement_products": [
          { data: [productRow({ row_version: 7 }), productRows[1]], error: null },
        ],
      },
    });
    const listed = await GET(getRequest());
    const listBody = supplementListResponseSchema.parse(await listed.json());
    const current = listBody.data.products.find((entry) => entry.id === PRODUCT_ID);
    expect(current?.rowVersion).toBe(7);

    // 3. 取り直した rowVersion で再送すると成功する。
    const fake = mockSupabase({
      responses: {
        "select:supplement_products": [
          { data: [productRow({ row_version: 7 }), productRows[1]], error: null },
        ],
        "update:supplement_products": [{ data: productRow({ row_version: 8 }), error: null }],
      },
    });

    const retried = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: current?.rowVersion,
          name: "ビタミンC（改）",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );
    expect(retried.status).toBe(200);

    const body = saveSupplementResponseSchema.parse(await retried.json());
    if (body.data.resource !== "product") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("updated");
    expect(body.data.product.rowVersion).toBe(8);

    const update = fake.operations.find((entry) => entry.kind === "update");
    expect(update?.filters).toContainEqual({ op: "eq", column: "row_version", value: 7 });
  });

  it("更新対象の商品が無いときも 409 SUPPLEMENT_CONFLICT（404 にしない）", async () => {
    // 実装仕様書 6.4節: 行の不在と版番号違いを区別しない。
    const fake = mockSupabase();

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: "9a2d3c4b-5a69-4788-9900-aabbccddeeff",
          expectedRowVersion: 1,
          name: "消えた商品",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");
    expect(fake.operations.some((entry) => entry.kind === "update")).toBe(false);
  });

  /* ---------------------------------------------------------------- */
  /* defaultUnit は在庫の単位でもある（2.4節）                        */
  /* ---------------------------------------------------------------- */

  it("在庫ロットがある商品の defaultUnit 変更は 400 SUPPLEMENT_UNIT_MISMATCH", async () => {
    const fake = mockSupabase({
      responses: {
        "select:supplement_inventory_lots": [{ data: [{ id: LOT_ID }], error: null }],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID, // 既定単位は tablet。ロットも tablet で数えている。
          expectedRowVersion: 1,
          name: "ビタミンC",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "g",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_UNIT_MISMATCH");

    // 所有者スコープでロットの有無だけを見る（1件あれば十分）。
    const lookup = fake.operations.find(
      (entry) => entry.kind === "select" && entry.table === "supplement_inventory_lots",
    );
    expect(lookup?.filters).toStrictEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "product_id", value: PRODUCT_ID },
    ]);
    expect(lookup?.limitValue).toBe(1);

    // 拒否された以上、UPDATE は一切投げない。
    expect(fake.operations.some((entry) => entry.kind === "update")).toBe(false);
  });

  it("在庫ロットがあっても defaultUnit が同じなら更新できる（ロットを引かない）", async () => {
    const fake = mockSupabase({
      responses: {
        "select:supplement_inventory_lots": [{ data: [{ id: LOT_ID }], error: null }],
        "update:supplement_products": [{ data: productRow({ row_version: 2 }), error: null }],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC 1000mg",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "tablet",
        },
      }),
    );

    expect(response.status).toBe(200);
    expect(
      fake.operations.some(
        (entry) => entry.kind === "select" && entry.table === "supplement_inventory_lots",
      ),
    ).toBe(false);
  });

  it("在庫ロットが無ければ defaultUnit を変更できる", async () => {
    const fake = mockSupabase({
      responses: {
        "select:supplement_inventory_lots": [{ data: [], error: null }],
        "update:supplement_products": [
          { data: productRow({ default_unit: "g", row_version: 2 }), error: null },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "g",
        },
      }),
    );

    expect(response.status).toBe(200);
    const update = fake.operations.find((entry) => entry.kind === "update");
    expect(update?.values?.["default_unit"]).toBe("g");
  });

  it("DB 側のガードに当たった場合も 400 SUPPLEMENT_UNIT_MISMATCH へ写す", async () => {
    // 事前検査をすり抜けた同時実行（ロット登録と単位変更が同時に走った）。
    mockSupabase({
      responses: {
        "select:supplement_inventory_lots": [{ data: [], error: null }],
        "update:supplement_products": [
          {
            data: null,
            error: {
              code: "23514",
              message:
                "cannot change the supplement product default unit while inventory lots exist",
            },
          },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        product: {
          id: PRODUCT_ID,
          expectedRowVersion: 1,
          name: "ビタミンC",
          category: "vitamin",
          form: "tablet",
          defaultUnit: "g",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_UNIT_MISMATCH");
  });

  it("適用済みの冪等キーは DB へ書かずに当時の行を返す", async () => {
    const fake = mockSupabase({
      responses: {
        "select:supplement_mutation_log": [loggedMutation(productRow({ row_version: 3 }))],
      },
    });

    const response = await POST(
      postRequest({
        resource: "product",
        clientMutationId: MUTATION_ID,
        product: validProduct,
      }),
    );
    expect(response.status).toBe(200);

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "product") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("idempotent_replay");
    expect(body.data.product.rowVersion).toBe(3);

    expect(fake.operations.some((entry) => entry.kind === "insert")).toBe(false);
    expect(fake.operations.some((entry) => entry.kind === "update")).toBe(false);
  });

  it("HTTPS でない URL は 400（実装仕様書 5.6節）", async () => {
    const response = await POST(
      postRequest({
        resource: "product",
        product: { ...validProduct, url: "http://example.com" },
      }),
    );
    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/supplements — 摂取予定", () => {
  it("週次で曜日を省くと 400、単発で別日の終了日を送ると 400", async () => {
    const weekly = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: PRODUCT_ID,
          scheduleKind: "weekly",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(weekly.status).toBe(400);

    const once = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: PRODUCT_ID,
          scheduleKind: "once",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          endDate: "2026-09-02",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(once.status).toBe(400);
  });

  it("必要時の予定で時刻を送ると 400、それ以外で時刻を省くと 400", async () => {
    const withTime = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: PRODUCT_ID,
          scheduleKind: "as_needed",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(withTime.status).toBe(400);

    const withoutTime = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: PRODUCT_ID,
          scheduleKind: "daily",
          startDate: "2026-09-01",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(withoutTime.status).toBe(400);
  });

  it("アーカイブ済み商品への新規予定は 400 SUPPLEMENT_PRODUCT_ARCHIVED", async () => {
    const response = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: ARCHIVED_PRODUCT_ID,
          scheduleKind: "daily",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_PRODUCT_ARCHIVED");
  });

  it("存在しない商品への予定は 404 SUPPLEMENT_PRODUCT_NOT_FOUND", async () => {
    const response = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: "9a2d3c4b-5a69-4788-9900-aabbccddeeff",
          scheduleKind: "daily",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 1,
          unit: "tablet",
        },
      }),
    );
    expect(response.status).toBe(404);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_PRODUCT_NOT_FOUND");
  });

  it("作成は 201 で、商品ラベル付きの行を返す", async () => {
    mockSupabase({
      responses: { "insert:supplement_schedules": [{ data: scheduleRow(), error: null }] },
    });

    const response = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          productId: PRODUCT_ID,
          scheduleKind: "daily",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 2,
          unit: "tablet",
          mealRelation: "after_meal",
        },
      }),
    );
    expect(response.status).toBe(201);

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "schedule") {
      throw new Error("unreachable");
    }
    expect(body.data.schedule.productName).toBe("ビタミンC");
    // `HH:MM:SS` は契約の `HH:MM` へ丸める。
    expect(body.data.schedule.timeOfDay).toBe("08:00");
  });

  it("更新対象の予定が消えているときは 409 SUPPLEMENT_CONFLICT（404 にしない）", async () => {
    // 事前取得は archived_at を引き継ぐためのもので、契約（実装仕様書 6.4節）を
    // 変えない。0件は版番号違いと区別せず 409。
    const fake = mockSupabase({
      responses: { "select:supplement_schedules": [{ data: null, error: null }] },
    });

    const response = await POST(
      postRequest({
        resource: "schedule",
        schedule: {
          id: ENTRY_ID,
          expectedRowVersion: 1,
          productId: PRODUCT_ID,
          scheduleKind: "daily",
          timeOfDay: "08:00",
          startDate: "2026-09-01",
          amount: 2,
          unit: "tablet",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");
    expect(fake.operations.some((entry) => entry.kind === "update")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/supplements — 在庫ロット", () => {
  it("作成時に残量を省くと数量と同じになる（開封前の新品）", async () => {
    const fake = mockSupabase({
      responses: {
        "insert:supplement_inventory_lots": [
          { data: lotRow({ remaining_quantity: 60 }), error: null },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "lot",
        lot: { productId: PRODUCT_ID, lotCode: "L-001", quantity: 60, expiresOn: "2027-01-31" },
      }),
    );
    expect(response.status).toBe(201);

    const insert = fake.operations.find((entry) => entry.kind === "insert");
    expect(insert?.values?.["remaining_quantity"]).toBe(60);
    expect(insert?.values?.["unit"]).toBe("tablet");

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "lot") {
      throw new Error("unreachable");
    }
    // 在庫を動かす保存には商品の在庫要約が付く（低在庫警告の出し直しに使う）。
    expect(body.data.stock.remainingTotal).toBe(42);
  });

  it("商品の既定単位と違う単位は 400 SUPPLEMENT_UNIT_MISMATCH", async () => {
    const response = await POST(
      postRequest({
        resource: "lot",
        lot: { productId: PRODUCT_ID, quantity: 10, unit: "mg" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_UNIT_MISMATCH");
  });

  it("残量が数量を超える入力は 400", async () => {
    const response = await POST(
      postRequest({
        resource: "lot",
        lot: { productId: PRODUCT_ID, quantity: 10, remainingQuantity: 11 },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("更新対象のロットが消えているときは 409 SUPPLEMENT_CONFLICT（404 にしない）", async () => {
    const fake = mockSupabase({
      responses: { "select:supplement_inventory_lots": [{ data: null, error: null }] },
    });

    const response = await POST(
      postRequest({
        resource: "lot",
        lot: {
          id: LOT_ID,
          expectedRowVersion: 1,
          productId: PRODUCT_ID,
          quantity: 60,
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");
    expect(fake.operations.some((entry) => entry.kind === "update")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/supplements — 服用の記録と取消", () => {
  it("記録は原子的RPC（record_supplement_intake）へ委譲する", async () => {
    const fake = mockSupabase({
      rpc: {
        record_supplement_intake: {
          data: { outcome: "created", intake: intakeRow() },
          error: null,
        },
      },
    });

    const response = await POST(postRequest({ resource: "intake", intake: validIntake }));
    expect(response.status).toBe(201);

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "intake") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("created");
    expect(body.data.intake.consumedQuantity).toBe(2);
    expect(body.data.stock.remainingTotal).toBe(42);

    // 記録・在庫の減算をテーブルへ直接書いていない（RPC だけ）。
    expect(fake.operations.some((entry) => entry.table === "supplement_intake_logs")).toBe(false);
    expect(fake.operations.some((entry) => entry.table === "supplement_inventory_lots")).toBe(
      false,
    );

    const call = fake.rpcArgs.find((entry) => entry.name === "record_supplement_intake");
    expect(call?.args).toMatchObject({
      p_product_id: PRODUCT_ID,
      p_idempotency_key: "intake-20260915-0900",
      p_status: "taken",
      p_amount: 2,
    });
  });

  it("RPC が replay を名乗ったら 200 idempotent_replay", async () => {
    mockSupabase({
      rpc: {
        record_supplement_intake: {
          data: { outcome: "idempotent_replay", intake: intakeRow() },
          error: null,
        },
      },
    });

    const response = await POST(postRequest({ resource: "intake", intake: validIntake }));
    expect(response.status).toBe(200);

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "intake") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("idempotent_replay");
  });

  it("在庫不足は 409 SUPPLEMENT_INSUFFICIENT_STOCK", async () => {
    mockSupabase({
      rpc: {
        record_supplement_intake: {
          data: null,
          error: {
            code: "23514",
            message: "insufficient supplement inventory: 2.0000 remaining of 5 required",
          },
        },
      },
    });

    const response = await POST(postRequest({ resource: "intake", intake: validIntake }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_INSUFFICIENT_STOCK");
  });

  it("単位の換算が必要なときは 400 SUPPLEMENT_UNIT_MISMATCH", async () => {
    mockSupabase({
      rpc: {
        record_supplement_intake: {
          data: null,
          error: {
            code: "22023",
            message:
              "consume quantity is required when the intake unit differs from the inventory unit",
          },
        },
      },
    });

    const response = await POST(
      postRequest({ resource: "intake", intake: { ...validIntake, unit: "mg", amount: 500 } }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_UNIT_MISMATCH");
  });

  it("冪等キー（idempotencyKey）は必須で、8文字未満は 400", async () => {
    const missing = await POST(
      postRequest({
        resource: "intake",
        intake: { productId: PRODUCT_ID, recordedAt: "2026-09-15T09:00:00Z", amount: 1 },
      }),
    );
    expect(missing.status).toBe(400);

    const tooShort = await POST(
      postRequest({ resource: "intake", intake: { ...validIntake, idempotencyKey: "short" } }),
    );
    expect(tooShort.status).toBe(400);
  });

  it("status に voided は指定できない（取消は void_intake から）", async () => {
    const response = await POST(
      postRequest({ resource: "intake", intake: { ...validIntake, status: "voided" } }),
    );
    expect(response.status).toBe(400);
  });

  it("スキップで在庫消費を指定すると 400", async () => {
    const response = await POST(
      postRequest({
        resource: "intake",
        intake: { ...validIntake, status: "skipped", consumeQuantity: 2 },
      }),
    );
    expect(response.status).toBe(400);
  });

  it("取消は原子的RPC（void_supplement_intake）へ委譲する", async () => {
    const fake = mockSupabase({
      rpc: {
        void_supplement_intake: {
          data: {
            outcome: "voided",
            intake: intakeRow({
              status: "voided",
              voided_at: "2026-09-15T10:00:00+00:00",
              void_reason: "誤登録",
              row_version: 2,
            }),
          },
          error: null,
        },
      },
    });

    const response = await POST(
      postRequest({
        resource: "void_intake",
        void: { id: ENTRY_ID, expectedRowVersion: 1, reason: "誤登録" },
      }),
    );
    expect(response.status).toBe(200);

    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "void_intake") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("voided");
    expect(body.data.intake.status).toBe("voided");
    // 記録当時の消費量は残る（在庫は動きの復元行で戻る）。
    expect(body.data.intake.consumedQuantity).toBe(2);

    const call = fake.rpcArgs.find((entry) => entry.name === "void_supplement_intake");
    expect(call?.args).toMatchObject({ p_id: ENTRY_ID, p_expected_row_version: 1 });
  });

  it("記録時の clientMutationId を取消へ使い回しても偽の replay にせず RPC を実行する", async () => {
    const fake = mockSupabase({
      responses: {
        "select:supplement_mutation_log": [loggedMutation(intakeRow({ status: "taken" }))],
      },
      rpc: {
        void_supplement_intake: {
          data: {
            outcome: "voided",
            intake: intakeRow({
              status: "voided",
              voided_at: "2026-09-15T10:00:00+00:00",
              row_version: 2,
            }),
          },
          error: null,
        },
      },
    });

    const response = await POST(
      postRequest({
        resource: "void_intake",
        clientMutationId: MUTATION_ID,
        void: { id: ENTRY_ID, expectedRowVersion: 1 },
      }),
    );

    expect(response.status).toBe(200);
    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "void_intake") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("voided");
    expect(body.data.intake.status).toBe("voided");
    expect(fake.rpcArgs).toContainEqual({
      name: "void_supplement_intake",
      args: {
        p_id: ENTRY_ID,
        p_expected_row_version: 1,
        p_reason: null,
        p_client_mutation_id: MUTATION_ID,
      },
    });
  });

  it("取消済みの再送は 200 idempotent_replay", async () => {
    mockSupabase({
      rpc: {
        void_supplement_intake: {
          data: {
            outcome: "idempotent_replay",
            intake: intakeRow({ status: "voided", voided_at: "2026-09-15T10:00:00+00:00" }),
          },
          error: null,
        },
      },
    });

    const response = await POST(
      postRequest({ resource: "void_intake", void: { id: ENTRY_ID, expectedRowVersion: 1 } }),
    );
    expect(response.status).toBe(200);
    const body = saveSupplementResponseSchema.parse(await response.json());
    if (body.data.resource !== "void_intake") {
      throw new Error("unreachable");
    }
    expect(body.data.outcome).toBe("idempotent_replay");
  });

  it("対象なし・版番号不一致は 409 SUPPLEMENT_CONFLICT", async () => {
    mockSupabase({
      rpc: { void_supplement_intake: { data: { outcome: "conflict" }, error: null } },
    });

    const response = await POST(
      postRequest({ resource: "void_intake", void: { id: ENTRY_ID, expectedRowVersion: 9 } }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");
  });
});

/* -------------------------------------------------------------------------- */

describe("DELETE /api/supplements", () => {
  it("予定を削除できる（楽観ロック付き）", async () => {
    const fake = mockSupabase({
      responses: { "delete:supplement_schedules": [{ data: { id: ENTRY_ID }, error: null }] },
    });

    const response = await DELETE(
      deleteRequest({ resource: "schedule", id: ENTRY_ID, expectedRowVersion: 1 }),
    );
    expect(response.status).toBe(200);

    const body = deleteSupplementResponseSchema.parse(await response.json());
    expect(body.data.deletedId).toBe(ENTRY_ID);

    const operation = fake.operations.find((entry) => entry.kind === "delete");
    expect(operation?.filters).toStrictEqual([
      { op: "eq", column: "id", value: ENTRY_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 1 },
    ]);
  });

  it("0件の削除は 409 SUPPLEMENT_CONFLICT", async () => {
    mockSupabase({
      responses: { "delete:supplement_schedules": [{ data: null, error: null }] },
    });

    const response = await DELETE(
      deleteRequest({ resource: "schedule", id: ENTRY_ID, expectedRowVersion: 1 }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_CONFLICT");
  });

  it("服用に使われたロットの削除は 409 SUPPLEMENT_LOT_IN_USE", async () => {
    mockSupabase({
      responses: {
        "delete:supplement_inventory_lots": [
          {
            data: null,
            error: {
              code: "23514",
              message: "the inventory lot has been used by a recorded intake and cannot be deleted",
            },
          },
        ],
      },
    });

    const response = await DELETE(deleteRequest({ resource: "lot", id: LOT_ID }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("SUPPLEMENT_LOT_IN_USE");
  });

  it("商品・服用記録は DELETE の対象にできない（400）", async () => {
    for (const resource of ["product", "intake"]) {
      const response = await DELETE(deleteRequest({ resource, id: ENTRY_ID }));
      expect(response.status, `${resource} が削除できてしまう`).toBe(400);
    }
  });
});
