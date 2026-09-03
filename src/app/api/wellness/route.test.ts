// @vitest-environment node
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteWellnessResponseSchema,
  saveWellnessResponseSchema,
  wellnessListResponseSchema,
} from "@/features/wellness/schema";
import {
  createFakeSupabase,
  DEFAULT_USER_ID,
  uniqueViolation,
  type FakeResponseScript,
  type FakeSupabaseOptions,
} from "@/tests/fake-supabase";

/**
 * `/api/wellness` の境界と挙動（実装仕様書 5.5節 / 6.4節 / 7章 / 9.2節）。
 *
 * 共通境界の実装そのものは `src/server/api/guards.test.ts` が検証する。
 * ここでは**このルートに実際に配線されているか**と、リソースごとの分岐・
 * 楽観ロック・冪等キー・重複登録防止の応答を確認する。
 * DB の振る舞い（制約・RLS・トリガー）は `tests/db/wellness*.test.ts` が実データで見る。
 */

const APP_ORIGIN = "https://app.example";
const WATER_TYPE_ID = "1e2d3c4b-5a69-4788-9900-aabbccddeeff";
const HEADACHE_TYPE_ID = "2e2d3c4b-5a69-4788-9900-aabbccddeeff";
const ENTRY_ID = "3e2d3c4b-5a69-4788-9900-aabbccddeeff";
const MUTATION_ID = "4e2d3c4b-5a69-4788-9900-aabbccddeeff";
const ARCHIVED_TYPE_ID = "5e2d3c4b-5a69-4788-9900-aabbccddeeff";
const CUSTOM_TYPE_ID = "6e2d3c4b-5a69-4788-9900-aabbccddeeff";

const supabaseState = vi.hoisted(() => ({
  configured: true,
  fake: null as ReturnType<typeof import("@/tests/fake-supabase").createFakeSupabase> | null,
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServerClient: async () =>
    supabaseState.configured ? (supabaseState.fake?.client ?? null) : null,
}));

const { GET, POST, DELETE } = await import("./route");

const beverageTypeRows = [
  {
    id: WATER_TYPE_ID,
    beverage_key: "water",
    display_name: "水",
    default_unit: "ml",
    default_amount: 200,
    contains_caffeine: false,
    contains_alcohol: false,
    is_default: true,
    sort_order: 10,
    archived_at: null,
    row_version: 1,
    client_mutation_id: null,
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
  },
  {
    id: ARCHIVED_TYPE_ID,
    beverage_key: "hot_water",
    display_name: "白湯",
    default_unit: "ml",
    default_amount: null,
    contains_caffeine: false,
    contains_alcohol: false,
    is_default: false,
    sort_order: 1000,
    archived_at: "2026-09-02T00:00:00+00:00",
    row_version: 2,
    client_mutation_id: null,
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-02T00:00:00+00:00",
  },
  {
    id: CUSTOM_TYPE_ID,
    beverage_key: "smoothie",
    display_name: "スムージー",
    default_unit: "ml",
    default_amount: 300,
    contains_caffeine: false,
    contains_alcohol: false,
    is_default: false,
    sort_order: 1000,
    archived_at: null,
    row_version: 3,
    client_mutation_id: null,
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
  },
];

const symptomTypeRows = [
  {
    id: HEADACHE_TYPE_ID,
    symptom_key: "headache",
    display_name: "頭痛",
    is_default: true,
    sort_order: 10,
    archived_at: null,
    row_version: 1,
    client_mutation_id: null,
    created_at: "2026-09-01T00:00:00+00:00",
    updated_at: "2026-09-01T00:00:00+00:00",
  },
];

const sleepEntryRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  sleep_kind: "night",
  bed_at: "2026-09-01T22:30:00+00:00",
  sleep_at: "2026-09-01T23:00:00+00:00",
  wake_at: "2026-09-02T06:30:00+00:00",
  out_of_bed_at: "2026-09-02T06:45:00+00:00",
  timezone: "Asia/Tokyo",
  awakenings_count: 1,
  awake_minutes: 25,
  quality: 4,
  morning_feeling: 3,
  note: null,
  sleep_minutes: 425,
  time_in_bed_minutes: 495,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-02T07:00:00+00:00",
  updated_at: "2026-09-02T07:00:00+00:00",
  ...overrides,
});

const hydrationEntryRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  beverage_type_id: WATER_TYPE_ID,
  recorded_at: "2026-09-02T09:00:00+00:00",
  unit: "l",
  amount: 1.5,
  amount_ml: 1500,
  contains_caffeine: false,
  contains_alcohol: false,
  note: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-02T09:00:00+00:00",
  updated_at: "2026-09-02T09:00:00+00:00",
  ...overrides,
});

const conditionEntryRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  recorded_at: "2026-09-02T08:00:00+00:00",
  timezone: "Asia/Tokyo",
  overall_score: 7,
  fatigue_score: 3,
  energy_score: 6,
  stress_score: 2,
  pain_score: 0,
  mood_score: 7,
  body_temperature_c: 36.6,
  free_text_symptoms: ["肩こり"],
  note: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-02T08:00:00+00:00",
  updated_at: "2026-09-02T08:00:00+00:00",
  ...overrides,
});

const sleepGoalRow = (overrides: Record<string, unknown> = {}) => ({
  id: ENTRY_ID,
  target_sleep_minutes: 420,
  weekdays: [0, 1, 2, 3, 4, 5, 6],
  target_bedtime: "23:30:00",
  target_wake_time: "06:30:00",
  timezone: "Asia/Tokyo",
  start_date: "2026-09-01",
  end_date: null,
  note: null,
  row_version: 1,
  client_mutation_id: null,
  created_at: "2026-09-01T00:00:00+00:00",
  updated_at: "2026-09-01T00:00:00+00:00",
  ...overrides,
});

/** 冪等キーの適用結果ログ（`wellness_mutation_log`）の1件。 */
const loggedMutation = (snapshot: unknown) => ({ data: { snapshot }, error: null });

const CATALOG_RESPONSES = {
  "select:beverage_types": [{ data: beverageTypeRows, error: null }],
  "select:symptom_types": [{ data: symptomTypeRows, error: null }],
};

/** テスト用の Supabase 代替を差し替える（React のフックではない）。 */
const mockSupabase = (options: FakeSupabaseOptions = {}) => {
  supabaseState.fake = createFakeSupabase({
    ...options,
    responses: { ...CATALOG_RESPONSES, ...(options.responses ?? {}) },
  });
  return supabaseState.fake;
};

const postRequest = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL("/api/wellness", APP_ORIGIN), {
    method: "POST",
    headers: { origin: APP_ORIGIN, "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });

const deleteRequest = (body: unknown) =>
  new NextRequest(new URL("/api/wellness", APP_ORIGIN), {
    method: "DELETE",
    headers: { origin: APP_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const getRequest = (query = "") =>
  new NextRequest(new URL(`/api/wellness${query}`, APP_ORIGIN), {
    headers: { origin: APP_ORIGIN },
  });

const readError = async (response: Response) =>
  (await response.json()) as { error: { code: string; message: string } };

const readData = async (response: Response) =>
  ((await response.json()) as { data: Record<string, unknown> }).data;

const validSleepEntry = {
  sleepKind: "night" as const,
  bedAt: "2026-09-01T22:30:00Z",
  sleepAt: "2026-09-01T23:00:00Z",
  wakeAt: "2026-09-02T06:30:00Z",
  outOfBedAt: "2026-09-02T06:45:00Z",
  awakeMinutes: 25,
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
    const request = new NextRequest(new URL("/api/wellness", APP_ORIGIN), {
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
    const response = await GET(new NextRequest(new URL("/api/wellness", APP_ORIGIN)));
    expect(response.status).toBe(403);
    expect((await readError(response)).error.code).toBe("SAME_ORIGIN_REQUIRED");
  });

  it("Content-Type が JSON でない POST は 415 JSON_REQUIRED", async () => {
    const request = new NextRequest(new URL("/api/wellness", APP_ORIGIN), {
      method: "POST",
      headers: { origin: APP_ORIGIN, "content-type": "text/plain" },
      body: "{}",
    });

    const response = await POST(request);
    expect(response.status).toBe(415);
    expect((await readError(response)).error.code).toBe("JSON_REQUIRED");
  });

  it("64KiB を超えるボディは 413 PAYLOAD_TOO_LARGE", async () => {
    const request = postRequest({ resource: "sleep", entry: validSleepEntry });
    request.headers.set("content-length", String(64 * 1024 + 1));

    const response = await POST(request);
    expect(response.status).toBe(413);
    expect((await readError(response)).error.code).toBe("PAYLOAD_TOO_LARGE");
  });

  it("所有者IDの持ち込みは 400（実装仕様書 3.2節）", async () => {
    const response = await POST(
      postRequest({ resource: "sleep", entry: { ...validSleepEntry, ownerId: DEFAULT_USER_ID } }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("未知フィールドは 400（Zod .strict()）", async () => {
    const response = await POST(
      postRequest({ resource: "sleep", entry: validSleepEntry, extra: 1 }),
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

  it("成功応答も no-store で { data: ... } 形式", async () => {
    const response = await GET(getRequest());
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await readData(response)).toBeTypeOf("object");
  });
});

/* -------------------------------------------------------------------------- */

describe("GET /api/wellness（実装仕様書 5.5節 / 7章）", () => {
  it("既定は睡眠の一覧で、種別・目標・文脈を同梱する", async () => {
    const fake = mockSupabase({
      responses: {
        "select:sleep_entries": [{ data: [sleepEntryRow()], error: null }],
        "select:sleep_goals": [{ data: [sleepGoalRow()], error: null }],
        "select:hydration_goals": [{ data: [], error: null }],
      },
    });

    const data = await readData(await GET(getRequest()));

    expect(data.resource).toBe("sleep");
    expect(data.entries).toHaveLength(1);
    expect((data.beverageTypes as unknown[]).length).toBe(3);
    expect((data.symptomTypes as unknown[]).length).toBe(1);
    expect((data.context as { activeSleepGoal: unknown }).activeSleepGoal).not.toBeNull();
    expect((data.context as { activeHydrationGoal: unknown }).activeHydrationGoal).toBeNull();

    // 所有者はセッション由来。全クエリに owner_id の絞り込みが入る。
    for (const operation of fake.operations) {
      expect(
        operation.filters.some(
          (filter) => filter.column === "owner_id" && filter.value === DEFAULT_USER_ID,
        ),
        `${operation.kind}:${operation.table} に owner_id が無い`,
      ).toBe(true);
    }
  });

  it("睡眠の応答は生成列（睡眠時間・拘束時間）をそのまま返す", async () => {
    mockSupabase({
      responses: { "select:sleep_entries": [{ data: [sleepEntryRow()], error: null }] },
    });

    const data = await readData(await GET(getRequest()));
    const entry = (data.entries as Record<string, unknown>[])[0];
    expect(entry?.sleepMinutes).toBe(425);
    expect(entry?.timeInBedMinutes).toBe(495);
    expect(entry?.sleepAt).toBe("2026-09-01T23:00:00.000Z");
  });

  it("水分は種別のラベルと ml 正規化値を同梱する", async () => {
    mockSupabase({
      responses: {
        "select:hydration_entries": [{ data: [hydrationEntryRow()], error: null }],
      },
    });

    const data = await readData(await GET(getRequest("?resource=hydration")));
    const entry = (data.entries as Record<string, unknown>[])[0];
    expect(data.resource).toBe("hydration");
    expect(entry?.beverageKey).toBe("water");
    expect(entry?.displayName).toBe("水");
    expect(entry?.amountMl).toBe(1500);
  });

  it("体調は症状リンクを種別ラベル付きで返す", async () => {
    mockSupabase({
      responses: {
        "select:condition_entries": [{ data: [conditionEntryRow()], error: null }],
        "select:condition_entry_symptoms": [
          {
            data: [
              {
                id: "7e2d3c4b-5a69-4788-9900-aabbccddeeff",
                entry_id: ENTRY_ID,
                symptom_type_id: HEADACHE_TYPE_ID,
                severity: 3,
                note: null,
              },
            ],
            error: null,
          },
        ],
      },
    });

    const data = await readData(await GET(getRequest("?resource=condition")));
    const entry = (data.entries as Record<string, unknown>[])[0];
    expect(data.resource).toBe("condition");
    expect(entry?.freeTextSymptoms).toEqual(["肩こり"]);
    expect(entry?.symptoms).toEqual([
      {
        id: "7e2d3c4b-5a69-4788-9900-aabbccddeeff",
        symptomTypeId: HEADACHE_TYPE_ID,
        symptomKey: "headache",
        displayName: "頭痛",
        severity: 3,
        note: null,
      },
    ]);
  });

  it("絞り込み（種別・期間）が WHERE 句へ渡る（409 後の対象特定に使う）", async () => {
    const fake = mockSupabase({
      responses: { "select:sleep_entries": [{ data: [sleepEntryRow()], error: null }] },
    });

    await GET(
      getRequest(
        "?resource=sleep&sleepKind=night&from=2026-09-01T23:00:00Z&to=2026-09-01T23:00:00Z&limit=1",
      ),
    );

    const listing = fake.operations.find((operation) => operation.table === "sleep_entries");
    expect(listing?.filters).toEqual(
      expect.arrayContaining([
        { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
        { op: "eq", column: "sleep_kind", value: "night" },
        { op: "gte", column: "sleep_at", value: "2026-09-01T23:00:00Z" },
        { op: "lte", column: "sleep_at", value: "2026-09-01T23:00:00Z" },
      ]),
    );
  });

  it("次ページがあるとカーソルを返し、次の呼び出しでキーセット条件になる", async () => {
    const rows = [
      sleepEntryRow({ id: ENTRY_ID, sleep_at: "2026-09-03T23:00:00+00:00" }),
      sleepEntryRow({
        id: "8e2d3c4b-5a69-4788-9900-aabbccddeeff",
        sleep_at: "2026-09-02T23:00:00+00:00",
      }),
    ];
    mockSupabase({ responses: { "select:sleep_entries": [{ data: rows, error: null }] } });

    const first = await readData(await GET(getRequest("?limit=1")));
    const cursor = (first.page as { nextCursor: string | null }).nextCursor;
    expect(cursor).not.toBeNull();
    expect((first.entries as unknown[]).length).toBe(1);

    const fake = mockSupabase({
      responses: { "select:sleep_entries": [{ data: [], error: null }] },
    });
    await GET(getRequest(`?limit=1&cursor=${encodeURIComponent(cursor ?? "")}`));

    const listing = fake.operations.find((operation) => operation.table === "sleep_entries");
    expect(listing?.or).toContain("sleep_at.lt.2026-09-03T23:00:00.000Z");
  });

  it("壊れた cursor は 400", async () => {
    const response = await GET(getRequest("?cursor=%21%21%21not-a-cursor"));
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("未知のクエリパラメータは 400", async () => {
    const response = await GET(getRequest("?offset=10"));
    expect(response.status).toBe(400);
  });

  it("resource に合わない絞り込みは 400", async () => {
    const response = await GET(getRequest("?resource=condition&sleepKind=nap"));
    expect(response.status).toBe(400);
  });

  /* ---------------------------------------------------------------- */
  /* id による1件取得（409 後の対象特定。docs/api/wellness.md 1.7節） */
  /* ---------------------------------------------------------------- */

  it("resource + id は主キーで1件だけを取りに行く（limit・絞り込みに依存しない）", async () => {
    const fake = mockSupabase({
      responses: {
        "select:sleep_entries": [{ data: sleepEntryRow({ row_version: 4 }), error: null }],
      },
    });

    const data = await readData(await GET(getRequest(`?resource=sleep&id=${ENTRY_ID}`)));

    expect((data.entries as Record<string, unknown>[])[0]?.rowVersion).toBe(4);
    expect((data.page as { nextCursor: string | null }).nextCursor).toBeNull();

    const lookup = fake.operations.find((operation) => operation.table === "sleep_entries");
    expect(lookup?.single).toBe(true);
    expect(lookup?.limitValue).toBeUndefined();
    expect(lookup?.filters).toEqual([
      { op: "eq", column: "id", value: ENTRY_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
    ]);
  });

  it("id で0件なら entries は空（＝本当に削除された）", async () => {
    mockSupabase({ responses: { "select:sleep_entries": [{ data: null, error: null }] } });

    const data = await readData(await GET(getRequest(`?resource=sleep&id=${ENTRY_ID}`)));
    expect(data.entries).toEqual([]);
  });

  it("水分・体調も id で1件取得できる（体調は症状リンクも同梱）", async () => {
    mockSupabase({
      responses: { "select:hydration_entries": [{ data: hydrationEntryRow(), error: null }] },
    });
    const hydration = await readData(await GET(getRequest(`?resource=hydration&id=${ENTRY_ID}`)));
    expect((hydration.entries as Record<string, unknown>[])[0]?.beverageKey).toBe("water");

    mockSupabase({
      responses: {
        "select:condition_entries": [{ data: conditionEntryRow(), error: null }],
        "select:condition_entry_symptoms": [
          {
            data: [
              {
                id: "7e2d3c4b-5a69-4788-9900-aabbccddeeff",
                entry_id: ENTRY_ID,
                symptom_type_id: HEADACHE_TYPE_ID,
                severity: 3,
                note: null,
                row_version: 1,
                client_mutation_id: null,
                created_at: "2026-09-02T08:00:00+00:00",
                updated_at: "2026-09-02T08:00:00+00:00",
              },
            ],
            error: null,
          },
        ],
      },
    });
    const condition = await readData(await GET(getRequest(`?resource=condition&id=${ENTRY_ID}`)));
    const entry = (condition.entries as Record<string, unknown>[])[0];
    expect((entry?.symptoms as Record<string, unknown>[])[0]?.symptomKey).toBe("headache");
  });

  it("id と一覧の絞り込みの併用は 400（1件取得は他条件に依存しない）", async () => {
    for (const extra of [
      "&from=2026-09-01T00:00:00Z",
      "&to=2026-09-01T00:00:00Z",
      "&cursor=abc",
      "&sleepKind=nap",
    ]) {
      const response = await GET(getRequest(`?resource=sleep&id=${ENTRY_ID}${extra}`));
      expect(response.status, extra).toBe(400);
    }
  });

  it("id の形式が不正なら 400", async () => {
    expect((await GET(getRequest("?resource=sleep&id=not-a-uuid"))).status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/wellness — 睡眠（実装仕様書 5.5節）", () => {
  it("作成は 201 で outcome=created", async () => {
    mockSupabase({
      responses: { "insert:sleep_entries": [{ data: sleepEntryRow(), error: null }] },
    });

    const response = await POST(postRequest({ resource: "sleep", entry: validSleepEntry }));
    expect(response.status).toBe(201);

    const data = await readData(response);
    expect(data.resource).toBe("sleep");
    expect(data.outcome).toBe("created");
  });

  it("所有者はセッション由来で、ボディの値は使わない", async () => {
    const fake = mockSupabase({
      responses: { "insert:sleep_entries": [{ data: sleepEntryRow(), error: null }] },
    });

    await POST(postRequest({ resource: "sleep", entry: validSleepEntry }));

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values?.owner_id).toBe(DEFAULT_USER_ID);
    // row_version はサーバー（DBトリガー）が決める。送らない。
    expect(insert?.values).not.toHaveProperty("row_version");
  });

  it("更新は WHERE に id + owner_id + row_version を含める（実装仕様書 6.4節）", async () => {
    const fake = mockSupabase({
      responses: {
        "update:sleep_entries": [{ data: sleepEntryRow({ row_version: 3 }), error: null }],
      },
    });

    const response = await POST(
      postRequest({
        resource: "sleep",
        entry: { ...validSleepEntry, id: ENTRY_ID, expectedRowVersion: 2 },
      }),
    );
    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("updated");

    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.filters).toEqual([
      { op: "eq", column: "id", value: ENTRY_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 2 },
    ]);
  });

  it("版番号不一致（0件更新）は 409 WELLNESS_CONFLICT", async () => {
    mockSupabase({ responses: { "update:sleep_entries": [{ data: null, error: null }] } });

    const response = await POST(
      postRequest({
        resource: "sleep",
        entry: { ...validSleepEntry, id: ENTRY_ID, expectedRowVersion: 2 },
      }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_CONFLICT");
  });

  it("同一種別・同一入眠日時の重複は 409 WELLNESS_DUPLICATE_CONFLICT", async () => {
    mockSupabase({
      responses: {
        "insert:sleep_entries": [
          { data: null, error: uniqueViolation("sleep_entries_owner_kind_sleep_at_key") },
        ],
      },
    });

    const response = await POST(postRequest({ resource: "sleep", entry: validSleepEntry }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_DUPLICATE_CONFLICT");
  });

  it("適用済みの冪等キーは新しい行を作らず同じ成功応答を返す", async () => {
    const fake = mockSupabase({
      responses: {
        "select:wellness_mutation_log": [loggedMutation(sleepEntryRow({ row_version: 2 }))],
      },
    });

    const response = await POST(
      postRequest({
        resource: "sleep",
        clientMutationId: MUTATION_ID,
        entry: validSleepEntry,
      }),
    );

    expect(response.status).toBe(200);
    const data = await readData(response);
    expect(data.outcome).toBe("idempotent_replay");
    expect((data.entry as { rowVersion: number }).rowVersion).toBe(2);
    // 履歴を引いた時点で打ち切り、INSERT は走らせない。
    expect(fake.operations.some((operation) => operation.kind === "insert")).toBe(false);
  });

  it("冪等キーは行ではなく履歴テーブルから引く（何世代前でも replay になる）", async () => {
    const fake = mockSupabase({
      responses: {
        "select:wellness_mutation_log": [loggedMutation(sleepEntryRow({ row_version: 1 }))],
      },
    });

    await POST(
      postRequest({
        resource: "sleep",
        clientMutationId: MUTATION_ID,
        entry: { ...validSleepEntry, id: ENTRY_ID, expectedRowVersion: 1 },
      }),
    );

    const lookup = fake.operations.find((operation) => operation.table === "wellness_mutation_log");
    expect(lookup?.filters).toEqual([
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "resource", value: "sleep_entries" },
      { op: "eq", column: "client_mutation_id", value: MUTATION_ID },
    ]);
  });

  it("同時多重送信は 409 ではなく idempotent_replay（0件更新のあと履歴を引き直す）", async () => {
    mockSupabase({
      responses: {
        "select:wellness_mutation_log": [
          { data: null, error: null },
          loggedMutation(sleepEntryRow({ row_version: 2 })),
        ],
        "update:sleep_entries": [{ data: null, error: null }],
      },
    });

    const response = await POST(
      postRequest({
        resource: "sleep",
        clientMutationId: MUTATION_ID,
        entry: { ...validSleepEntry, id: ENTRY_ID, expectedRowVersion: 1 },
      }),
    );

    expect(response.status).toBe(200);
    expect((await readData(response)).outcome).toBe("idempotent_replay");
  });

  it("順序・24時間・覚醒時間の違反は DB へ届く前に 400", async () => {
    const fake = mockSupabase();

    const response = await POST(
      postRequest({
        resource: "sleep",
        entry: {
          ...validSleepEntry,
          sleepAt: "2026-09-01T22:00:00Z",
          bedAt: "2026-09-01T22:30:00Z",
        },
      }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("WELLNESS_INVALID_SLEEP_RANGE");
    expect(fake.operations.some((operation) => operation.table === "sleep_entries")).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/wellness — 水分（実装仕様書 5.5節）", () => {
  const entry = {
    beverageTypeId: WATER_TYPE_ID,
    recordedAt: "2026-09-02T09:00:00Z",
    unit: "l" as const,
    amount: 1.5,
  };

  it("カフェイン・アルコールの既定を飲み物種別から取る", async () => {
    const fake = mockSupabase({
      responses: { "insert:hydration_entries": [{ data: hydrationEntryRow(), error: null }] },
    });

    await POST(postRequest({ resource: "hydration", entry }));

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values?.contains_caffeine).toBe(false);
    expect(insert?.values?.contains_alcohol).toBe(false);
    // 正規化値は生成列。クライアントからもAPIからも書かない。
    expect(insert?.values).not.toHaveProperty("amount_ml");
  });

  it("所有者の種別に無い beverageTypeId は 404", async () => {
    const response = await POST(
      postRequest({
        resource: "hydration",
        entry: { ...entry, beverageTypeId: "00000000-0000-4000-8000-000000000000" },
      }),
    );
    expect(response.status).toBe(404);
    expect((await readError(response)).error.code).toBe("WELLNESS_TYPE_NOT_FOUND");
  });

  it("アーカイブ済み種別への新規登録は 400、既存記録の更新は妨げない", async () => {
    const rejected = await POST(
      postRequest({ resource: "hydration", entry: { ...entry, beverageTypeId: ARCHIVED_TYPE_ID } }),
    );
    expect(rejected.status).toBe(400);
    expect((await readError(rejected)).error.code).toBe("WELLNESS_TYPE_ARCHIVED");

    mockSupabase({
      responses: {
        "update:hydration_entries": [
          { data: hydrationEntryRow({ beverage_type_id: ARCHIVED_TYPE_ID }), error: null },
        ],
      },
    });
    const updated = await POST(
      postRequest({
        resource: "hydration",
        entry: {
          ...entry,
          beverageTypeId: ARCHIVED_TYPE_ID,
          id: ENTRY_ID,
          expectedRowVersion: 1,
        },
      }),
    );
    expect(updated.status).toBe(200);
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/wellness — 体調（実装仕様書 5.5節）", () => {
  /** 本体と症状リンクを1トランザクションで書く DB 関数の応答（migration 20260903000500）。 */
  const savedCondition = (overrides: Record<string, unknown> = {}) => ({
    save_condition_entry: { data: [conditionEntryRow(overrides)], error: null },
  });

  const conditionRequest = (entry: Record<string, unknown>) => ({
    resource: "condition",
    clientMutationId: MUTATION_ID,
    entry,
  });

  it("本体と症状リンクは単一の DB 関数（1トランザクション）へ渡る", async () => {
    const fake = mockSupabase({ rpc: savedCondition() });

    const response = await POST(
      postRequest(
        conditionRequest({
          recordedAt: "2026-09-02T08:00:00Z",
          overallScore: 7,
          symptoms: [{ symptomTypeId: HEADACHE_TYPE_ID, severity: 3 }],
        }),
      ),
    );

    expect(response.status).toBe(201);

    // 親行を直接 insert / update せず、必ず DB 関数を通す
    // （2回書くと「親だけ確定」の中途半端な状態が生まれるため）。
    expect(
      fake.operations.some(
        (operation) =>
          operation.table === "condition_entries" &&
          (operation.kind === "insert" || operation.kind === "update"),
      ),
    ).toBe(false);

    const call = fake.rpcArgs.find((rpc) => rpc.name === "save_condition_entry");
    expect(call?.args).toMatchObject({
      p_client_mutation_id: MUTATION_ID,
      p_id: null,
      p_expected_row_version: null,
      p_symptoms: [{ symptomTypeId: HEADACHE_TYPE_ID, severity: 3, note: null }],
    });
    expect(call?.args.p_entry).toMatchObject({
      recorded_at: "2026-09-02T08:00:00Z",
      overall_score: 7,
      free_text_symptoms: [],
    });
  });

  it("症状を省略すると p_symptoms は null（既存のリンクを残す）", async () => {
    const fake = mockSupabase({ rpc: savedCondition() });

    await POST(postRequest(conditionRequest({ recordedAt: "2026-09-02T08:00:00Z" })));

    const call = fake.rpcArgs.find((rpc) => rpc.name === "save_condition_entry");
    expect(call?.args.p_symptoms).toBeNull();
  });

  it("clientMutationId は必須（安全な再試行のため）", async () => {
    const response = await POST(
      postRequest({ resource: "condition", entry: { recordedAt: "2026-09-02T08:00:00Z" } }),
    );

    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("更新では id と期待版番号が DB 関数へ渡る（楽観ロック）", async () => {
    const fake = mockSupabase({ rpc: savedCondition({ row_version: 2 }) });

    const response = await POST(
      postRequest(
        conditionRequest({
          id: ENTRY_ID,
          expectedRowVersion: 1,
          recordedAt: "2026-09-02T08:00:00Z",
        }),
      ),
    );

    expect(response.status).toBe(200);
    const call = fake.rpcArgs.find((rpc) => rpc.name === "save_condition_entry");
    expect(call?.args).toMatchObject({ p_id: ENTRY_ID, p_expected_row_version: 1 });
  });

  it("DB 関数が0件を返したら 409 WELLNESS_CONFLICT（版番号不一致・対象なし）", async () => {
    mockSupabase({ rpc: { save_condition_entry: { data: [], error: null } } });

    const response = await POST(
      postRequest(
        conditionRequest({
          id: ENTRY_ID,
          expectedRowVersion: 1,
          recordedAt: "2026-09-02T08:00:00Z",
        }),
      ),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_CONFLICT");
  });

  it("所有者の種別に無い症状は 404", async () => {
    const response = await POST(
      postRequest(
        conditionRequest({
          recordedAt: "2026-09-02T08:00:00Z",
          symptoms: [{ symptomTypeId: "00000000-0000-4000-8000-000000000000" }],
        }),
      ),
    );
    expect(response.status).toBe(404);
    expect((await readError(response)).error.code).toBe("WELLNESS_TYPE_NOT_FOUND");
  });

  it("同一記録日時の重複は 409 WELLNESS_DUPLICATE_CONFLICT", async () => {
    mockSupabase({
      rpc: {
        save_condition_entry: {
          data: null,
          error: uniqueViolation("condition_entries_owner_recorded_at_key"),
        },
      },
    });

    const response = await POST(
      postRequest(conditionRequest({ recordedAt: "2026-09-02T08:00:00Z" })),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_DUPLICATE_CONFLICT");
  });
});

/* -------------------------------------------------------------------------- */

describe("POST /api/wellness — 目標と種別（実装仕様書 5.5節）", () => {
  it("睡眠の目標を作成できる（時刻は HH:MM で返る）", async () => {
    mockSupabase({ responses: { "insert:sleep_goals": [{ data: sleepGoalRow(), error: null }] } });

    const response = await POST(
      postRequest({
        resource: "sleep_goal",
        goal: {
          targetSleepMinutes: 420,
          startDate: "2026-09-01",
          targetBedtime: "23:30",
          targetWakeTime: "06:30",
        },
      }),
    );

    expect(response.status).toBe(201);
    const data = await readData(response);
    expect((data.goal as { targetBedtime: string }).targetBedtime).toBe("23:30");
    expect((data.goal as { weekdays: number[] }).weekdays).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("終了日の無い目標が既にあると 409 WELLNESS_GOAL_CONFLICT", async () => {
    mockSupabase({
      responses: {
        "insert:hydration_goals": [
          { data: null, error: uniqueViolation("hydration_goals_owner_active_key") },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "hydration_goal",
        goal: { targetAmountMl: 2000, startDate: "2026-09-01" },
      }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_GOAL_CONFLICT");
  });

  it("目標の版番号不一致（更新0件）も 409 WELLNESS_GOAL_CONFLICT", async () => {
    // 契約（docs/api/wellness.md 1.8節）では、目標の競合は重複も版番号不一致も
    // `WELLNESS_GOAL_CONFLICT`。記録用の `WELLNESS_CONFLICT` を混ぜると、
    // 画面が目標の競合を記録の競合として扱ってしまう。
    mockSupabase({ responses: { "update:sleep_goals": [{ data: null, error: null }] } });

    const response = await POST(
      postRequest({
        resource: "sleep_goal",
        goal: {
          id: ENTRY_ID,
          expectedRowVersion: 1,
          targetSleepMinutes: 420,
          startDate: "2026-09-01",
        },
      }),
    );

    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_GOAL_CONFLICT");
  });

  it("終了日が開始日より前なら 400", async () => {
    const response = await POST(
      postRequest({
        resource: "sleep_goal",
        goal: { targetSleepMinutes: 420, startDate: "2026-09-10", endDate: "2026-09-01" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("既定投入は両カタログの RPC を呼び、outcome=seeded を返す", async () => {
    const fake = mockSupabase({
      rpc: {
        seed_default_beverage_types: { data: beverageTypeRows.slice(0, 1), error: null },
        seed_default_symptom_types: { data: symptomTypeRows, error: null },
      },
    });

    const response = await POST(postRequest({ resource: "seed_defaults" }));
    expect(response.status).toBe(200);

    const data = await readData(response);
    expect(data.outcome).toBe("seeded");
    expect(fake.rpcCalls).toContain("seed_default_beverage_types");
    expect(fake.rpcCalls).toContain("seed_default_symptom_types");
  });

  it("既定カタログのキーをカスタム種別に使うと 400", async () => {
    const response = await POST(
      postRequest({
        resource: "beverage_type",
        type: { beverageKey: "coffee", displayName: "偽コーヒー", defaultUnit: "ml" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("WELLNESS_TYPE_KEY_RESERVED");
  });

  it("is_default はクライアントから書かせない（INSERT の列に含めない）", async () => {
    const fake = mockSupabase({
      responses: {
        "insert:beverage_types": [{ data: beverageTypeRows[2], error: null }],
      },
    });

    await POST(
      postRequest({
        resource: "beverage_type",
        type: { beverageKey: "smoothie", displayName: "スムージー", defaultUnit: "ml" },
      }),
    );

    const insert = fake.operations.find((operation) => operation.kind === "insert");
    expect(insert?.values).not.toHaveProperty("is_default");
  });

  it("既定種別の変更・アーカイブは 400", async () => {
    const response = await POST(
      postRequest({
        resource: "beverage_type",
        type: {
          id: WATER_TYPE_ID,
          expectedRowVersion: 1,
          displayName: "偽装",
          defaultUnit: "ml",
          archived: true,
        },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("カスタム種別のアーカイブは archived_at を立てる", async () => {
    const fake = mockSupabase({
      responses: {
        "update:beverage_types": [
          {
            data: { ...beverageTypeRows[2], archived_at: "2026-09-05T00:00:00+00:00" },
            error: null,
          },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "beverage_type",
        type: {
          id: CUSTOM_TYPE_ID,
          expectedRowVersion: 3,
          displayName: "スムージー",
          defaultUnit: "ml",
          archived: true,
        },
      }),
    );

    expect(response.status).toBe(200);
    const update = fake.operations.find((operation) => operation.kind === "update");
    expect(update?.values?.archived_at).toBeTypeOf("string");
    expect(update?.filters).toEqual([
      { op: "eq", column: "id", value: CUSTOM_TYPE_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 3 },
    ]);
  });

  it("項目キーの重複は 409 WELLNESS_TYPE_CONFLICT", async () => {
    mockSupabase({
      responses: {
        "insert:symptom_types": [
          { data: null, error: uniqueViolation("symptom_types_owner_key_key") },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "symptom_type",
        type: { symptomKey: "eye_strain", displayName: "目の疲れ" },
      }),
    );
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_TYPE_CONFLICT");
  });

  it("カスタム症状の上限超過は 400 WELLNESS_TYPE_LIMIT_REACHED", async () => {
    mockSupabase({
      responses: {
        "insert:symptom_types": [
          {
            data: null,
            error: {
              code: "23514",
              message: "custom symptom types are limited to 30 per owner",
              details: "",
            },
          },
        ],
      },
    });

    const response = await POST(
      postRequest({
        resource: "symptom_type",
        type: { symptomKey: "eye_strain", displayName: "目の疲れ" },
      }),
    );
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("WELLNESS_TYPE_LIMIT_REACHED");
  });
});

/* -------------------------------------------------------------------------- */

describe("DELETE /api/wellness（実装仕様書 5.5節 / 6.4節）", () => {
  it("resource ごとに対象テーブルを選び、版番号を WHERE に含める", async () => {
    const fake = mockSupabase({
      responses: { "delete:hydration_entries": [{ data: { id: ENTRY_ID }, error: null }] },
    });

    const response = await DELETE(
      deleteRequest({ resource: "hydration", id: ENTRY_ID, expectedRowVersion: 4 }),
    );

    expect(response.status).toBe(200);
    expect(await readData(response)).toEqual({ resource: "hydration", deletedId: ENTRY_ID });

    const remove = fake.operations.find((operation) => operation.kind === "delete");
    expect(remove?.table).toBe("hydration_entries");
    expect(remove?.filters).toEqual([
      { op: "eq", column: "id", value: ENTRY_ID },
      { op: "eq", column: "owner_id", value: DEFAULT_USER_ID },
      { op: "eq", column: "row_version", value: 4 },
    ]);
  });

  it("0件削除は 409（存在しない行と版番号違いを区別しない）", async () => {
    mockSupabase({ responses: { "delete:sleep_entries": [{ data: null, error: null }] } });

    const response = await DELETE(deleteRequest({ resource: "sleep", id: ENTRY_ID }));
    expect(response.status).toBe(409);
    expect((await readError(response)).error.code).toBe("WELLNESS_CONFLICT");
  });

  it("種別は削除できない（アーカイブのみ）", async () => {
    const response = await DELETE(deleteRequest({ resource: "beverage_type", id: WATER_TYPE_ID }));
    expect(response.status).toBe(400);
    expect((await readError(response)).error.code).toBe("INVALID_REQUEST");
  });

  it("冪等キーは受け付けない（削除の再送はエラーになる）", async () => {
    const response = await DELETE(
      deleteRequest({ resource: "sleep", id: ENTRY_ID, clientMutationId: MUTATION_ID }),
    );
    expect(response.status).toBe(400);
  });
});

/* -------------------------------------------------------------------------- */

/**
 * 応答が `src/features/wellness/schema.ts` の**レスポンススキーマそのもの**を
 * 通ることを確かめる。フロントエンドは同じスキーマで受けるため、ここがずれると
 * 画面側で解釈に失敗する（契約の往復検証）。
 */
describe("応答が契約スキーマを満たす（フロントが同じスキーマで受ける）", () => {
  it("GET: 3リソースとも wellnessListResponseSchema を満たす", async () => {
    const cases: readonly { query: string; responses: FakeResponseScript }[] = [
      {
        query: "?resource=sleep",
        responses: {
          "select:sleep_entries": [{ data: [sleepEntryRow()], error: null }],
          "select:sleep_goals": [{ data: [sleepGoalRow()], error: null }],
        },
      },
      {
        query: "?resource=hydration",
        responses: {
          "select:hydration_entries": [{ data: [hydrationEntryRow()], error: null }],
        },
      },
      {
        query: "?resource=condition",
        responses: {
          "select:condition_entries": [{ data: [conditionEntryRow()], error: null }],
          "select:condition_entry_symptoms": [
            {
              data: [
                {
                  id: "7e2d3c4b-5a69-4788-9900-aabbccddeeff",
                  entry_id: ENTRY_ID,
                  symptom_type_id: HEADACHE_TYPE_ID,
                  severity: 3,
                  note: null,
                },
              ],
              error: null,
            },
          ],
        },
      },
    ];

    for (const testCase of cases) {
      mockSupabase({ responses: testCase.responses });
      const body = await (await GET(getRequest(testCase.query))).json();
      const parsed = wellnessListResponseSchema.safeParse(body);
      expect(parsed.success, `${testCase.query}: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      );
    }
  });

  it("POST: 各リソースの応答が saveWellnessResponseSchema を満たす", async () => {
    const cases: readonly {
      body: unknown;
      responses?: FakeResponseScript;
      rpc?: FakeSupabaseOptions["rpc"];
    }[] = [
      {
        body: { resource: "sleep", entry: validSleepEntry },
        responses: { "insert:sleep_entries": [{ data: sleepEntryRow(), error: null }] },
      },
      {
        body: {
          resource: "hydration",
          entry: {
            beverageTypeId: WATER_TYPE_ID,
            recordedAt: "2026-09-02T09:00:00Z",
            unit: "l",
            amount: 1.5,
          },
        },
        responses: { "insert:hydration_entries": [{ data: hydrationEntryRow(), error: null }] },
      },
      {
        // 体調は本体と症状リンクをまとめて書く DB 関数を通る（1トランザクション）。
        body: {
          resource: "condition",
          clientMutationId: MUTATION_ID,
          entry: { recordedAt: "2026-09-02T08:00:00Z" },
        },
        rpc: { save_condition_entry: { data: [conditionEntryRow()], error: null } },
      },
      {
        body: {
          resource: "sleep_goal",
          goal: { targetSleepMinutes: 420, startDate: "2026-09-01" },
        },
        responses: { "insert:sleep_goals": [{ data: sleepGoalRow(), error: null }] },
      },
      {
        body: {
          resource: "beverage_type",
          type: { beverageKey: "smoothie", displayName: "スムージー", defaultUnit: "ml" },
        },
        responses: { "insert:beverage_types": [{ data: beverageTypeRows[2], error: null }] },
      },
      {
        body: {
          resource: "symptom_type",
          type: { symptomKey: "eye_strain", displayName: "目の疲れ" },
        },
        responses: { "insert:symptom_types": [{ data: symptomTypeRows[0], error: null }] },
      },
    ];

    for (const testCase of cases) {
      mockSupabase({ responses: testCase.responses, rpc: testCase.rpc });
      const body = await (await POST(postRequest(testCase.body))).json();
      const parsed = saveWellnessResponseSchema.safeParse(body);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
    }
  });

  it("POST seed_defaults の応答が saveWellnessResponseSchema を満たす", async () => {
    mockSupabase({
      rpc: {
        seed_default_beverage_types: { data: beverageTypeRows, error: null },
        seed_default_symptom_types: { data: symptomTypeRows, error: null },
      },
    });

    const body = await (await POST(postRequest({ resource: "seed_defaults" }))).json();
    const parsed = saveWellnessResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it("DELETE の応答が deleteWellnessResponseSchema を満たす", async () => {
    mockSupabase({
      responses: { "delete:sleep_entries": [{ data: { id: ENTRY_ID }, error: null }] },
    });

    const body = await (await DELETE(deleteRequest({ resource: "sleep", id: ENTRY_ID }))).json();
    const parsed = deleteWellnessResponseSchema.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });
});
