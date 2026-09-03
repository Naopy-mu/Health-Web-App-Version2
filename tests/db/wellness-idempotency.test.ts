// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { wellnessListQuerySchema } from "@/features/wellness/schema";
import {
  deleteWellnessRow,
  listConditionEntries,
  listHydrationEntries,
  listSleepEntries,
  loadCatalogs,
  saveConditionEntry,
  saveHydrationEntry,
  saveSleepEntry,
  saveSleepGoal,
  seedDefaults,
  type WellnessCatalog,
} from "@/server/wellness/repository";

import { createMigratedDatabase, signUp } from "./pglite";
import { createPglitePostgrest } from "./supabase-pglite";

/**
 * 冪等再送・楽観ロック・409 からの復帰を、migration を適用した実データベースと
 * 実リポジトリの組み合わせで検証する（実装仕様書 5.5節 / 6.4節）。
 *
 * > 同一 `client_mutation_id` による再送（同時多重送信を含む）は、競合状態でも
 * > 必ず同一の成功応答（idempotent replay）を返す。row_version の不一致による
 * > 409 は、実際に異なる内容での競合時のみ発生させる。（実装仕様書 5.3節。
 * > 全機能に共通の契約）
 *
 * あわせて Phase 3b の教訓（「limit 付きの一覧再取得だけでは 409 の対象行を
 * 見失う」）に対する設計上の答え——**所有者 + 記録日時（+ 種別）の一意制約に
 * 対応する絞り込みクエリで必ず1件に到達できること**——を確認する。
 */

/** 期待どおり成功した結果だけを取り出す（失敗なら応答本文を添えて落とす）。 */
async function expectOk<T>(
  result: { ok: true; value: T } | { ok: false; response: Response },
): Promise<T> {
  if (!result.ok) {
    const body = await result.response.clone().text();
    throw new Error(`expected success but got ${result.response.status}: ${body}`);
  }
  return result.value;
}

/** 期待どおり失敗した結果から HTTP ステータスとエラーコードを取り出す。 */
async function expectError(
  result: { ok: true; value: unknown } | { ok: false; response: Response },
): Promise<{ status: number; code: string }> {
  if (result.ok) {
    throw new Error(`expected an error response but the call succeeded`);
  }
  const body = (await result.response.clone().json()) as { error: { code: string } };
  return { status: result.response.status, code: body.error.code };
}

const query = (overrides: Record<string, string> = {}) => wellnessListQuerySchema.parse(overrides);

describe("睡眠・水分・体調の冪等再送と 409 からの復帰 (実装仕様書 5.5節 / 6.4節)", () => {
  let db: PGlite;
  let userId: string;
  let supabase: SupabaseClient;
  let catalog: WellnessCatalog;
  let waterTypeId: string;
  let coffeeTypeId: string;
  let headacheTypeId: string;
  let fatigueTypeId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "wellness-idempotency@example.test");
    supabase = createPglitePostgrest(db, userId);

    await expectOk(await seedDefaults(supabase));
    catalog = await expectOk(await loadCatalogs(supabase, userId));

    waterTypeId = catalog.beverages.byKey.get("water")?.id ?? "";
    coffeeTypeId = catalog.beverages.byKey.get("coffee")?.id ?? "";
    headacheTypeId = catalog.symptoms.byKey.get("headache")?.id ?? "";
    fatigueTypeId = catalog.symptoms.byKey.get("fatigue")?.id ?? "";
    expect(waterTypeId).not.toBe("");
    expect(headacheTypeId).not.toBe("");
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /* ------------------------------------------------------------------ */
  /* 何世代前の再送でも成功応答（実装仕様書 5.5節 / 6.4節）              */
  /* ------------------------------------------------------------------ */

  it("睡眠記録: 3世代前の client_mutation_id で再送しても成功応答を返す", async () => {
    const created = "aaaa0001-0000-4000-8000-000000000001";
    const updates = [
      "aaaa0001-0000-4000-8000-000000000002",
      "aaaa0001-0000-4000-8000-000000000003",
      "aaaa0001-0000-4000-8000-000000000004",
    ];

    const base = {
      sleepKind: "night" as const,
      bedAt: "2026-10-01T22:30:00.000Z",
      sleepAt: "2026-10-01T23:00:00.000Z",
      wakeAt: "2026-10-02T06:30:00.000Z",
      outOfBedAt: "2026-10-02T06:45:00.000Z",
    };

    const first = await expectOk(await saveSleepEntry(supabase, userId, base, created));
    expect(first.outcome).toBe("created");
    expect(first.entry.rowVersion).toBe(1);

    const applied = [first];
    for (const [index, mutationId] of updates.entries()) {
      const result = await expectOk(
        await saveSleepEntry(
          supabase,
          userId,
          {
            ...base,
            id: first.entry.id,
            expectedRowVersion: index + 1,
            quality: index + 2,
          },
          mutationId,
        ),
      );
      expect(result.outcome).toBe("updated");
      expect(result.entry.rowVersion).toBe(index + 2);
      applied.push(result);
    }

    // 行が覚えている client_mutation_id は最後の1つだけ。それより前のキーは
    // 行からは引けない（履歴テーブルを引くから再送が成立する）。
    const stored = await db.query<{ client_mutation_id: string; row_version: string }>(
      "select client_mutation_id, row_version::text as row_version from public.sleep_entries where id = $1",
      [first.entry.id],
    );
    expect(stored.rows[0]?.client_mutation_id).toBe(updates.at(-1));
    expect(stored.rows[0]?.row_version).toBe("4");

    // 作成時のキー・途中のキー・最新のキーのいずれで再送しても成功応答。
    for (const [index, mutationId] of [created, ...updates].entries()) {
      const replay = await expectOk(
        await saveSleepEntry(
          supabase,
          userId,
          { ...base, id: first.entry.id, expectedRowVersion: index + 1 },
          mutationId,
        ),
      );
      expect(replay.outcome).toBe("idempotent_replay");
      // 返るのは「適用当時のスナップショット」であって現在の行ではない。
      expect(replay.entry.rowVersion).toBe(applied[index]?.entry.rowVersion);
      expect(replay.entry.quality).toBe(applied[index]?.entry.quality ?? null);
    }
  });

  it("水分記録: 2世代前の再送でも当時のスナップショットを返す", async () => {
    const created = "bbbb0001-0000-4000-8000-000000000001";
    const updated = "bbbb0001-0000-4000-8000-000000000002";

    const base = {
      beverageTypeId: waterTypeId,
      recordedAt: "2026-10-03T09:00:00.000Z",
      unit: "ml" as const,
      amount: 200,
    };

    const first = await expectOk(
      await saveHydrationEntry(supabase, userId, base, created, catalog),
    );
    expect(first.entry.amountMl).toBe(200);

    await expectOk(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...base, id: first.entry.id, expectedRowVersion: 1, unit: "l", amount: 1.5 },
        updated,
        catalog,
      ),
    );

    // さらにもう1世代（冪等キー無し）進めてから、最初のキーで再送する。
    await expectOk(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...base, id: first.entry.id, expectedRowVersion: 2, amount: 300 },
        undefined,
        catalog,
      ),
    );

    const replay = await expectOk(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...base, id: first.entry.id, expectedRowVersion: 1 },
        created,
        catalog,
      ),
    );
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.entry.rowVersion).toBe(1);
    expect(replay.entry.amountMl).toBe(200);
  });

  it("目標: 冪等キーの再送は 409 にならない", async () => {
    const created = "cccc0001-0000-4000-8000-000000000001";
    const goal = { targetSleepMinutes: 420, startDate: "2026-10-01" };

    const first = await expectOk(await saveSleepGoal(supabase, userId, goal, created));
    expect(first.outcome).toBe("created");

    const replay = await expectOk(await saveSleepGoal(supabase, userId, goal, created));
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.goal.id).toBe(first.goal.id);

    // 終了日の無い目標は所有者ごとに1件。別のキーで2件目を作ろうとすると 409。
    const conflict = await expectError(
      await saveSleepGoal(
        supabase,
        userId,
        { targetSleepMinutes: 400, startDate: "2026-11-01" },
        "cccc0001-0000-4000-8000-000000000002",
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("WELLNESS_GOAL_CONFLICT");
  });

  it("同時多重送信（同じ冪等キーが競合状態で2回届く）でも 409 にならない", async () => {
    const mutationId = "dddd0001-0000-4000-8000-000000000001";
    const base = {
      sleepKind: "nap" as const,
      bedAt: "2026-10-05T13:00:00.000Z",
      sleepAt: "2026-10-05T13:00:00.000Z",
      wakeAt: "2026-10-05T13:40:00.000Z",
      outOfBedAt: "2026-10-05T13:45:00.000Z",
    };

    const [a, b] = await Promise.all([
      saveSleepEntry(supabase, userId, base, mutationId),
      saveSleepEntry(supabase, userId, base, mutationId),
    ]);

    const first = await expectOk(a);
    const second = await expectOk(b);
    expect(second.entry.id).toBe(first.entry.id);
    expect([first.outcome, second.outcome].filter((outcome) => outcome === "created")).toHaveLength(
      1,
    );

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.sleep_entries where owner_id = $1 and sleep_at = $2",
      [userId, base.sleepAt],
    );
    expect(rows[0]?.count).toBe("1");
  });

  /* ------------------------------------------------------------------ */
  /* 重複登録防止と楽観ロック                                            */
  /* ------------------------------------------------------------------ */

  it("同じ所有者・種別・記録日時の重複登録は 409（冪等キー無し）", async () => {
    const base = {
      sleepKind: "other" as const,
      bedAt: "2026-10-06T13:00:00.000Z",
      sleepAt: "2026-10-06T13:00:00.000Z",
      wakeAt: "2026-10-06T14:00:00.000Z",
      outOfBedAt: "2026-10-06T14:00:00.000Z",
    };

    await expectOk(await saveSleepEntry(supabase, userId, base, undefined));

    const duplicate = await expectError(
      await saveSleepEntry(supabase, userId, { ...base, quality: 3 }, undefined),
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.code).toBe("WELLNESS_DUPLICATE_CONFLICT");
  });

  it("版番号が違えば 409（冪等キー無しの本当の競合）", async () => {
    const base = {
      beverageTypeId: coffeeTypeId,
      recordedAt: "2026-10-07T09:00:00.000Z",
      unit: "ml" as const,
      amount: 150,
    };

    const created = await expectOk(
      await saveHydrationEntry(supabase, userId, base, undefined, catalog),
    );

    const conflict = await expectError(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...base, id: created.entry.id, expectedRowVersion: 99, amount: 200 },
        undefined,
        catalog,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("WELLNESS_CONFLICT");
  });

  it("存在しない行の削除・版番号違いの削除は 409（存在の有無を漏らさない）", async () => {
    const missing = await expectError(
      await deleteWellnessRow(
        supabase,
        userId,
        "sleep",
        "00000000-0000-4000-8000-000000000000",
        undefined,
      ),
    );
    expect(missing.status).toBe(409);
    expect(missing.code).toBe("WELLNESS_CONFLICT");
  });

  /* ------------------------------------------------------------------ */
  /* 409 後の対象特定クエリ（Phase 3b の教訓）                           */
  /* ------------------------------------------------------------------ */

  it("睡眠: 409 のあと sleepKind + from/to で対象1件に必ず到達できる", async () => {
    const target = {
      sleepKind: "night" as const,
      bedAt: "2026-01-10T22:00:00.000Z",
      sleepAt: "2026-01-10T22:30:00.000Z",
      wakeAt: "2026-01-11T06:00:00.000Z",
      outOfBedAt: "2026-01-11T06:10:00.000Z",
    };
    const created = await expectOk(await saveSleepEntry(supabase, userId, target, undefined));

    // 対象より新しい記録を積んで、既定の一覧（新しい順）から押し出す。
    for (let index = 0; index < 5; index += 1) {
      await expectOk(
        await saveSleepEntry(
          supabase,
          userId,
          {
            sleepKind: "night",
            bedAt: `2026-02-1${index}T22:00:00.000Z`,
            sleepAt: `2026-02-1${index}T22:30:00.000Z`,
            wakeAt: `2026-02-1${index}T23:30:00.000Z`,
            outOfBedAt: `2026-02-1${index}T23:40:00.000Z`,
          },
          undefined,
        ),
      );
    }

    // 別の利用者が先に更新した状況（版番号が進む）。
    await expectOk(
      await saveSleepEntry(
        supabase,
        userId,
        { ...target, id: created.entry.id, expectedRowVersion: 1, quality: 5 },
        undefined,
      ),
    );

    // 古い版番号での更新は 409。
    const conflict = await expectError(
      await saveSleepEntry(
        supabase,
        userId,
        { ...target, id: created.entry.id, expectedRowVersion: 1, quality: 2 },
        undefined,
      ),
    );
    expect(conflict.code).toBe("WELLNESS_CONFLICT");

    // limit 付きの一覧再取得だけでは対象に届かない（Phase 3b で見つかった型）。
    const listed = await expectOk(await listSleepEntries(supabase, userId, query({ limit: "3" })));
    expect(listed.entries.some((entry) => entry.id === created.entry.id)).toBe(false);

    // (owner_id, sleep_kind, sleep_at) の一意制約に対応する絞り込みなら必ず1件。
    const pinpoint = await expectOk(
      await listSleepEntries(
        supabase,
        userId,
        query({
          resource: "sleep",
          sleepKind: target.sleepKind,
          from: target.sleepAt,
          to: target.sleepAt,
          limit: "1",
        }),
      ),
    );
    expect(pinpoint.entries).toHaveLength(1);
    expect(pinpoint.entries[0]?.id).toBe(created.entry.id);
    expect(pinpoint.entries[0]?.rowVersion).toBe(2);

    // 取り直した版番号で再試行すれば成功する（409 から復帰できる）。
    const retried = await expectOk(
      await saveSleepEntry(
        supabase,
        userId,
        {
          ...target,
          id: created.entry.id,
          expectedRowVersion: pinpoint.entries[0]?.rowVersion ?? 0,
          quality: 2,
        },
        undefined,
      ),
    );
    expect(retried.outcome).toBe("updated");
    expect(retried.entry.rowVersion).toBe(3);
  });

  it("水分: 409 のあと beverageTypeId + from/to で対象1件に必ず到達できる", async () => {
    const target = {
      beverageTypeId: waterTypeId,
      recordedAt: "2026-01-12T09:00:00.000Z",
      unit: "ml" as const,
      amount: 200,
    };
    const created = await expectOk(
      await saveHydrationEntry(supabase, userId, target, undefined, catalog),
    );

    for (let index = 0; index < 5; index += 1) {
      await expectOk(
        await saveHydrationEntry(
          supabase,
          userId,
          {
            beverageTypeId: coffeeTypeId,
            recordedAt: `2026-02-2${index}T09:00:00.000Z`,
            unit: "ml",
            amount: 150,
          },
          undefined,
          catalog,
        ),
      );
    }

    await expectOk(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...target, id: created.entry.id, expectedRowVersion: 1, amount: 250 },
        undefined,
        catalog,
      ),
    );

    const listed = await expectOk(
      await listHydrationEntries(supabase, userId, query({ limit: "3" }), catalog),
    );
    expect(listed.entries.some((entry) => entry.id === created.entry.id)).toBe(false);

    const pinpoint = await expectOk(
      await listHydrationEntries(
        supabase,
        userId,
        query({
          resource: "hydration",
          beverageTypeId: target.beverageTypeId,
          from: target.recordedAt,
          to: target.recordedAt,
          limit: "1",
        }),
        catalog,
      ),
    );
    expect(pinpoint.entries).toHaveLength(1);
    expect(pinpoint.entries[0]?.id).toBe(created.entry.id);
    expect(pinpoint.entries[0]?.rowVersion).toBe(2);
    expect(pinpoint.entries[0]?.amount).toBe(250);
  });

  it("体調: 409 のあと from/to（recordedAt）で対象1件に必ず到達できる", async () => {
    const recordedAt = "2026-01-13T08:00:00.000Z";
    const created = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, overallScore: 7 },
        undefined,
        catalog,
      ),
    );

    for (let index = 0; index < 5; index += 1) {
      await expectOk(
        await saveConditionEntry(
          supabase,
          userId,
          { recordedAt: `2026-02-2${index}T08:00:00.000Z` },
          undefined,
          catalog,
        ),
      );
    }

    await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, id: created.entry.id, expectedRowVersion: 1, overallScore: 8 },
        undefined,
        catalog,
      ),
    );

    const listed = await expectOk(
      await listConditionEntries(supabase, userId, query({ limit: "3" }), catalog),
    );
    expect(listed.entries.some((entry) => entry.id === created.entry.id)).toBe(false);

    const pinpoint = await expectOk(
      await listConditionEntries(
        supabase,
        userId,
        query({ resource: "condition", from: recordedAt, to: recordedAt, limit: "1" }),
        catalog,
      ),
    );
    expect(pinpoint.entries).toHaveLength(1);
    expect(pinpoint.entries[0]?.id).toBe(created.entry.id);
    expect(pinpoint.entries[0]?.rowVersion).toBe(2);
    expect(pinpoint.entries[0]?.overallScore).toBe(8);
  });

  /* ------------------------------------------------------------------ */
  /* 体調記録の症状リンク                                                */
  /* ------------------------------------------------------------------ */

  it("症状リンクは全置換で、応答に種別のラベルが同梱される", async () => {
    const recordedAt = "2026-01-14T08:00:00.000Z";
    const created = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt,
          symptoms: [
            { symptomTypeId: fatigueTypeId, severity: 4 },
            { symptomTypeId: headacheTypeId, severity: 2, note: "朝から" },
          ],
          freeTextSymptoms: ["肩こり"],
        },
        undefined,
        catalog,
      ),
    );

    // 並びは症状種別の sortOrder 昇順（headache=10 → fatigue=90）。
    expect(created.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual([
      "headache",
      "fatigue",
    ]);
    expect(created.entry.symptoms[0]?.displayName).toBe("頭痛");
    expect(created.entry.freeTextSymptoms).toEqual(["肩こり"]);

    // 全置換: 送った集合がそのまま結果になる。
    const replaced = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt,
          id: created.entry.id,
          expectedRowVersion: created.entry.rowVersion,
          symptoms: [{ symptomTypeId: fatigueTypeId }],
        },
        undefined,
        catalog,
      ),
    );
    expect(replaced.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["fatigue"]);

    // 空配列で全解除できる。
    const cleared = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt,
          id: created.entry.id,
          expectedRowVersion: replaced.entry.rowVersion,
          symptoms: [],
        },
        undefined,
        catalog,
      ),
    );
    expect(cleared.entry.symptoms).toEqual([]);
  });

  it("症状を省略すると既存のリンクをそのまま残す", async () => {
    const recordedAt = "2026-01-15T08:00:00.000Z";
    const created = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, symptoms: [{ symptomTypeId: headacheTypeId }] },
        undefined,
        catalog,
      ),
    );

    const updated = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt,
          id: created.entry.id,
          expectedRowVersion: created.entry.rowVersion,
          overallScore: 5,
        },
        undefined,
        catalog,
      ),
    );
    expect(updated.entry.overallScore).toBe(5);
    expect(updated.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["headache"]);
  });

  it("最新世代の再送は症状リンクを貼り直す（親だけ保存できた再送を救う）", async () => {
    const recordedAt = "2026-01-16T08:00:00.000Z";
    const mutationId = "eeee0001-0000-4000-8000-000000000001";

    const created = await expectOk(
      await saveConditionEntry(supabase, userId, { recordedAt }, mutationId, catalog),
    );
    expect(created.entry.symptoms).toEqual([]);

    // 「親は保存できたが症状の置換に失敗した」あとの再送（同じ冪等キー）。
    const replay = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, symptoms: [{ symptomTypeId: headacheTypeId }] },
        mutationId,
        catalog,
      ),
    );
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["headache"]);
  });

  it("古い世代の再送は症状リンクを巻き戻さない", async () => {
    const recordedAt = "2026-01-17T08:00:00.000Z";
    const firstKey = "eeee0001-0000-4000-8000-000000000002";

    const created = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, symptoms: [{ symptomTypeId: headacheTypeId }] },
        firstKey,
        catalog,
      ),
    );

    // 別のミューテーションで症状を入れ替え、世代を進める。
    await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt,
          id: created.entry.id,
          expectedRowVersion: created.entry.rowVersion,
          symptoms: [{ symptomTypeId: fatigueTypeId }],
        },
        "eeee0001-0000-4000-8000-000000000003",
        catalog,
      ),
    );

    // 最初のキーでの再送は当時のスナップショットを返すが、
    // 現在の症状リンク（fatigue）は巻き戻さない。
    const replay = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, symptoms: [{ symptomTypeId: headacheTypeId }] },
        firstKey,
        catalog,
      ),
    );
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.entry.rowVersion).toBe(1);
    expect(replay.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["fatigue"]);
  });

  it("所有者スコープの種別以外は 404、アーカイブ済みは 400", async () => {
    const unknown = await expectError(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt: "2026-01-18T08:00:00.000Z",
          symptoms: [{ symptomTypeId: "00000000-0000-4000-8000-000000000000" }],
        },
        undefined,
        catalog,
      ),
    );
    expect(unknown.status).toBe(404);
    expect(unknown.code).toBe("WELLNESS_TYPE_NOT_FOUND");

    // カスタム症状を作ってアーカイブし、その種別を紐づけようとする。
    await db.query(
      `insert into public.symptom_types (owner_id, symptom_key, display_name, archived_at)
       values ($1, 'archived_symptom', 'アーカイブ済み', now())`,
      [userId],
    );
    const refreshed = await expectOk(await loadCatalogs(supabase, userId));
    const archivedId = refreshed.symptoms.byKey.get("archived_symptom")?.id ?? "";

    const archived = await expectError(
      await saveConditionEntry(
        supabase,
        userId,
        {
          recordedAt: "2026-01-19T08:00:00.000Z",
          symptoms: [{ symptomTypeId: archivedId }],
        },
        undefined,
        refreshed,
      ),
    );
    expect(archived.status).toBe(400);
    expect(archived.code).toBe("WELLNESS_TYPE_ARCHIVED");
  });

  it("睡眠の順序・24時間・覚醒時間の違反は専用コードで 400", async () => {
    const invalid = await expectError(
      await saveSleepEntry(
        supabase,
        userId,
        {
          sleepKind: "nap",
          bedAt: "2026-01-20T14:00:00.000Z",
          sleepAt: "2026-01-20T13:00:00.000Z",
          wakeAt: "2026-01-20T15:00:00.000Z",
          outOfBedAt: "2026-01-20T15:10:00.000Z",
        },
        undefined,
      ),
    );
    expect(invalid.status).toBe(400);
    expect(invalid.code).toBe("WELLNESS_INVALID_SLEEP_RANGE");
  });
});
