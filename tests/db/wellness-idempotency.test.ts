// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { buildWellnessRefetchQuery, interpretWellnessRefetch } from "@/features/wellness/conflict";
import { wellnessListQuerySchema } from "@/features/wellness/schema";
import {
  deleteWellnessRow,
  getConditionEntryById,
  getSleepEntryById,
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

/** 同時実行テストの待ち合わせ点。片方の進行をもう片方の合図まで止める。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

/**
 * 体調記録の保存は `clientMutationId` が必須（migration 20260903000500 /
 * `docs/api/wellness.md` 6.2節）。テストごとに重複しないキーを配る。
 */
let conditionKeySeed = 0;
const conditionKey = (): string => {
  conditionKeySeed += 1;
  return `dddd0001-0000-4000-8000-${String(conditionKeySeed).padStart(12, "0")}`;
};

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

  it("種別を後からアーカイブしても、適用済みキーの再送は成功応答を返す", async () => {
    // 実装仕様書 8章のオフライン同期では「保存が成功 → 利用者がその種別を
    // アーカイブ → 送信キューに残っていた同じキーが再送される」が普通に起こる。
    // 適用済みの clientMutationId は**現在**の種別の状態に関わらず、当時の
    // 成功応答をそのまま返さなければならない（実装仕様書 6.4節）。
    await db.query(
      `insert into public.beverage_types (owner_id, beverage_key, display_name, default_unit)
       values ($1, 'replay_beverage', '再送用ドリンク', 'ml')`,
      [userId],
    );
    await db.query(
      `insert into public.symptom_types (owner_id, symptom_key, display_name)
       values ($1, 'replay_symptom', '再送用症状')`,
      [userId],
    );

    const before = await expectOk(await loadCatalogs(supabase, userId));
    const beverageTypeId = before.beverages.byKey.get("replay_beverage")?.id ?? "";
    const symptomTypeId = before.symptoms.byKey.get("replay_symptom")?.id ?? "";
    expect(beverageTypeId).not.toBe("");
    expect(symptomTypeId).not.toBe("");

    const hydrationKey = "ffff0001-0000-4000-8000-000000000001";
    const hydrationInput = {
      beverageTypeId,
      recordedAt: "2026-11-02T09:00:00.000Z",
      unit: "ml" as const,
      amount: 250,
    };
    const hydration = await expectOk(
      await saveHydrationEntry(supabase, userId, hydrationInput, hydrationKey, before),
    );
    expect(hydration.outcome).toBe("created");

    const conditionMutationKey = conditionKey();
    const conditionInput = {
      recordedAt: "2026-11-02T21:00:00.000Z",
      overallScore: 7,
      symptoms: [{ symptomTypeId }],
    };
    const condition = await expectOk(
      await saveConditionEntry(supabase, userId, conditionInput, conditionMutationKey, before),
    );
    expect(condition.outcome).toBe("created");

    // 保存後に両方の種別をアーカイブする。
    await db.query("update public.beverage_types set archived_at = now() where id = $1", [
      beverageTypeId,
    ]);
    await db.query("update public.symptom_types set archived_at = now() where id = $1", [
      symptomTypeId,
    ]);

    const after = await expectOk(await loadCatalogs(supabase, userId));
    expect(after.beverages.byId.get(beverageTypeId)?.archivedAt).not.toBeNull();
    expect(after.symptoms.byId.get(symptomTypeId)?.archivedAt).not.toBeNull();

    // 再送はアーカイブ済み判定に弾かれず、当時のスナップショットを返す。
    const hydrationReplay = await expectOk(
      await saveHydrationEntry(supabase, userId, hydrationInput, hydrationKey, after),
    );
    expect(hydrationReplay.outcome).toBe("idempotent_replay");
    expect(hydrationReplay.entry.id).toBe(hydration.entry.id);
    expect(hydrationReplay.entry.rowVersion).toBe(hydration.entry.rowVersion);
    expect(hydrationReplay.entry.amountMl).toBe(hydration.entry.amountMl);

    const conditionReplay = await expectOk(
      await saveConditionEntry(supabase, userId, conditionInput, conditionMutationKey, after),
    );
    expect(conditionReplay.outcome).toBe("idempotent_replay");
    expect(conditionReplay.entry.id).toBe(condition.entry.id);
    expect(conditionReplay.entry.rowVersion).toBe(condition.entry.rowVersion);
    expect(conditionReplay.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual([
      "replay_symptom",
    ]);

    // 未適用のキーによる新規登録は、これまでどおりアーカイブ済みで 400。
    const rejectedHydration = await expectError(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...hydrationInput, recordedAt: "2026-11-03T09:00:00.000Z" },
        "ffff0001-0000-4000-8000-000000000002",
        after,
      ),
    );
    expect(rejectedHydration.status).toBe(400);
    expect(rejectedHydration.code).toBe("WELLNESS_TYPE_ARCHIVED");

    const rejectedCondition = await expectError(
      await saveConditionEntry(
        supabase,
        userId,
        { ...conditionInput, recordedAt: "2026-11-03T21:00:00.000Z" },
        conditionKey(),
        after,
      ),
    );
    expect(rejectedCondition.status).toBe(400);
    expect(rejectedCondition.code).toBe("WELLNESS_TYPE_ARCHIVED");
  });

  it("同時実行: 冪等ログを引いた直後に先行リクエストの保存と種別アーカイブが確定しても replay", async () => {
    // 再送側がログを引き終えた**直後**に、先行リクエストの保存と種別の
    // アーカイブが確定すると、再送側の INSERT はアーカイブのガードトリガーに
    // 掴まって 23514（CHECK 制約違反）になる。一意制約違反（23505）だけを
    // 引き直しの合図にしていると、適用済みのキーなのに 400
    // `WELLNESS_TYPE_ARCHIVED` を返してしまい、「適用済みの clientMutationId は
    // 何世代前でも同じ成功応答を返す」契約（実装仕様書 6.4節）が破れる。
    await db.query(
      `insert into public.beverage_types (owner_id, beverage_key, display_name, default_unit)
       values ($1, 'race_beverage', '競合再現用ドリンク', 'ml')`,
      [userId],
    );

    const before = await expectOk(await loadCatalogs(supabase, userId));
    const beverageTypeId = before.beverages.byKey.get("race_beverage")?.id ?? "";
    expect(beverageTypeId).not.toBe("");

    const mutationId = "ffff0002-0000-4000-8000-000000000001";
    const input = {
      beverageTypeId,
      recordedAt: "2026-11-05T09:00:00.000Z",
      unit: "ml" as const,
      amount: 300,
    };

    // 待ち合わせ点は2つ。
    //   1. 再送側が冪等ログを引き終えた（＝「未適用」と判断した直後）
    //   2. 先行リクエストの保存と種別アーカイブが確定した
    const lookupDone = deferred();
    const leaderDone = deferred();

    let interrupted = false;
    const resendClient = createPglitePostgrest(db, userId, {
      afterQuery: async (sql) => {
        if (interrupted || !sql.includes("wellness_mutation_log")) {
          return;
        }
        interrupted = true;
        lookupDone.resolve();
        await leaderDone.promise;
      },
    });

    const leader = (async () => {
      await lookupDone.promise;
      const saved = await expectOk(
        await saveHydrationEntry(supabase, userId, input, mutationId, before),
      );
      await db.query("update public.beverage_types set archived_at = now() where id = $1", [
        beverageTypeId,
      ]);
      leaderDone.resolve();
      return saved;
    })();

    // 2つのリクエストを同時に走らせる。再送側は上の待ち合わせで、
    // 「ログ検索は終わったが INSERT はこれから」という窓に置かれる。
    const [first, resent] = await Promise.all([
      leader,
      saveHydrationEntry(resendClient, userId, input, mutationId, before),
    ]);

    expect(interrupted).toBe(true);
    expect(first.outcome).toBe("created");

    const replayed = await expectOk(resent);
    expect(replayed.outcome).toBe("idempotent_replay");
    expect(replayed.entry.id).toBe(first.entry.id);
    expect(replayed.entry.rowVersion).toBe(first.entry.rowVersion);
    expect(replayed.entry.amountMl).toBe(first.entry.amountMl);

    // 記録は1件だけ（再送で二重に入っていない）。
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.hydration_entries
       where owner_id = $1 and beverage_type_id = $2`,
      [userId, beverageTypeId],
    );
    expect(rows[0]?.count).toBe("1");

    // 未適用のキーは引き直しても見つからないので、従来どおりのエラーを返す。
    // （カタログはアーカイブ前のものなので、判定はDBのガードトリガーが行う。）
    const rejected = await expectError(
      await saveHydrationEntry(
        supabase,
        userId,
        { ...input, recordedAt: "2026-11-05T10:00:00.000Z" },
        "ffff0002-0000-4000-8000-000000000002",
        before,
      ),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("WELLNESS_TYPE_ARCHIVED");
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
        conditionKey(),
        catalog,
      ),
    );

    for (let index = 0; index < 5; index += 1) {
      await expectOk(
        await saveConditionEntry(
          supabase,
          userId,
          { recordedAt: `2026-02-2${index}T08:00:00.000Z` },
          conditionKey(),
          catalog,
        ),
      );
    }

    await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, id: created.entry.id, expectedRowVersion: 1, overallScore: 8 },
        conditionKey(),
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
  /* 識別子そのものが競合更新で変わった場合の対象特定                    */
  /*                                                                     */
  /* 記録日時・種別による絞り込みは「その識別子がまだ同じ」ことを前提に  */
  /* している。競合した側の更新がその識別子自体を書き換えていると0件に   */
  /* なり、行が残っているのに「削除された」と誤判定してしまう。          */
  /* 主キー（id）は行の生存期間中ずっと変わらないので前提が要らない。    */
  /* ------------------------------------------------------------------ */

  it("睡眠: 651件規模でも、識別子（種別・入眠日時）を変えた競合更新のあと id で最新へ到達できる", async () => {
    const bulkUser = await signUp(db, "wellness-pinpoint-sleep@example.test");
    const bulk = createPglitePostgrest(db, bulkUser);

    // 対象より新しい記録を650件積む（合計651件）。既定の一覧（新しい順）でも
    // 一覧の最大ページ（500件）でも対象には届かない規模。
    await db.query(
      `insert into public.sleep_entries
         (owner_id, sleep_kind, bed_at, sleep_at, wake_at, out_of_bed_at)
       select $1, 'night',
              timestamptz '2027-01-01T22:00:00Z' + (n || ' days')::interval,
              timestamptz '2027-01-01T22:30:00Z' + (n || ' days')::interval,
              timestamptz '2027-01-02T06:00:00Z' + (n || ' days')::interval,
              timestamptz '2027-01-02T06:10:00Z' + (n || ' days')::interval
       from generate_series(1, 650) as n`,
      [bulkUser],
    );

    const original = {
      sleepKind: "night" as const,
      bedAt: "2026-12-01T22:00:00.000Z",
      sleepAt: "2026-12-01T22:30:00.000Z",
      wakeAt: "2026-12-02T06:00:00.000Z",
      outOfBedAt: "2026-12-02T06:10:00.000Z",
    };
    const created = await expectOk(await saveSleepEntry(bulk, bulkUser, original, undefined));

    const total = await db.query<{ count: string }>(
      "select count(*)::text as count from public.sleep_entries where owner_id = $1",
      [bulkUser],
    );
    expect(total.rows[0]?.count).toBe("651");

    // 競合した側の更新が、**識別子そのもの**（種別と入眠日時）を書き換える。
    const moved = await expectOk(
      await saveSleepEntry(
        bulk,
        bulkUser,
        {
          ...original,
          id: created.entry.id,
          expectedRowVersion: created.entry.rowVersion,
          sleepKind: "nap",
          bedAt: "2026-12-01T23:00:00.000Z",
          sleepAt: "2026-12-01T23:30:00.000Z",
        },
        undefined,
      ),
    );
    expect(moved.entry.rowVersion).toBe(2);

    // 編集を続けていた側は古い版番号で 409 になる。
    const conflict = await expectError(
      await saveSleepEntry(
        bulk,
        bulkUser,
        { ...original, id: created.entry.id, expectedRowVersion: 1, quality: 3 },
        undefined,
      ),
    );
    expect(conflict.code).toBe("WELLNESS_CONFLICT");

    // 旧方式（編集開始時の永続値＝種別・入眠日時で絞り込む）は0件になる。
    // 行はまだあるのに「削除された」と誤判定してしまう型。
    const byIdentifier = await expectOk(
      await listSleepEntries(
        bulk,
        bulkUser,
        query({
          resource: "sleep",
          sleepKind: original.sleepKind,
          from: original.sleepAt,
          to: original.sleepAt,
          limit: "1",
        }),
      ),
    );
    expect(byIdentifier.entries).toHaveLength(0);

    // 一覧の最大ページでも対象には届かない（651件のうち最も古い1件）。
    const widest = await expectOk(
      await listSleepEntries(bulk, bulkUser, query({ resource: "sleep", limit: "500" })),
    );
    expect(widest.entries.some((entry) => entry.id === created.entry.id)).toBe(false);

    // 主キーによる1件取得なら、識別子が変わっていても最新の状態へ到達できる。
    const byId = await expectOk(await getSleepEntryById(bulk, bulkUser, created.entry.id));
    expect(byId.entries).toHaveLength(1);
    expect(byId.entries[0]?.id).toBe(created.entry.id);
    expect(byId.entries[0]?.rowVersion).toBe(2);
    expect(byId.entries[0]?.sleepKind).toBe("nap");
    expect(byId.entries[0]?.sleepAt).toBe("2026-12-01T23:30:00.000Z");
    expect(byId.nextCursor).toBeNull();

    // 取り直した版番号で再試行すれば 409 から復帰できる。
    const retried = await expectOk(
      await saveSleepEntry(
        bulk,
        bulkUser,
        {
          ...original,
          id: created.entry.id,
          expectedRowVersion: byId.entries[0]?.rowVersion ?? 0,
          sleepKind: "nap",
          bedAt: "2026-12-01T23:00:00.000Z",
          sleepAt: "2026-12-01T23:30:00.000Z",
          quality: 3,
        },
        undefined,
      ),
    );
    expect(retried.outcome).toBe("updated");
    expect(retried.entry.rowVersion).toBe(3);

    // 本当に削除されたときだけ0件になる（「識別子が変わった」場合と区別できる）。
    await expectOk(await deleteWellnessRow(bulk, bulkUser, "sleep", created.entry.id, undefined));
    const afterDelete = await expectOk(await getSleepEntryById(bulk, bulkUser, created.entry.id));
    expect(afterDelete.entries).toHaveLength(0);
  }, 60_000);

  it("体調: 記録日時を変えた競合更新のあとも id で最新へ到達できる", async () => {
    const recordedAt = "2026-11-01T08:00:00.000Z";
    const created = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, overallScore: 6 },
        conditionKey(),
        catalog,
      ),
    );

    // 競合した側が記録日時（＝一意制約の識別子）を書き換える。
    await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        {
          id: created.entry.id,
          expectedRowVersion: created.entry.rowVersion,
          recordedAt: "2026-11-01T20:00:00.000Z",
          overallScore: 9,
        },
        conditionKey(),
        catalog,
      ),
    );

    // 編集開始時の記録日時で引くと0件（行は残っているのに見失う）。
    const byIdentifier = await expectOk(
      await listConditionEntries(
        supabase,
        userId,
        query({ resource: "condition", from: recordedAt, to: recordedAt, limit: "1" }),
        catalog,
      ),
    );
    expect(byIdentifier.entries).toHaveLength(0);

    const byId = await expectOk(
      await getConditionEntryById(supabase, userId, created.entry.id, catalog),
    );
    expect(byId.entries).toHaveLength(1);
    expect(byId.entries[0]?.rowVersion).toBe(2);
    expect(byId.entries[0]?.overallScore).toBe(9);
    expect(byId.entries[0]?.recordedAt).toBe("2026-11-01T20:00:00.000Z");
  });

  it("対象特定クエリは id があれば必ず主キー取得を選ぶ（0件の意味が変わるため）", () => {
    const withId = buildWellnessRefetchQuery({
      resource: "sleep",
      id: "aaaa0002-0000-4000-8000-000000000001",
      sleepKind: "night",
      sleepAt: "2026-12-01T22:30:00.000Z",
    });
    expect(withId.strategy).toBe("id");
    expect(withId.params.get("id")).toBe("aaaa0002-0000-4000-8000-000000000001");
    // 併用すると API が 400 を返すため、絞り込みは載せない。
    expect(withId.params.get("sleepKind")).toBeNull();
    expect(withId.params.get("from")).toBeNull();

    // id がまだ無い（新規作成の重複競合）ときだけ識別子で引く。
    const withoutId = buildWellnessRefetchQuery({
      resource: "sleep",
      sleepKind: "night",
      sleepAt: "2026-12-01T22:30:00.000Z",
    });
    expect(withoutId.strategy).toBe("identifier");
    expect(withoutId.params.get("sleepKind")).toBe("night");

    // 0件の解釈: 主キーなら「削除された」と断定でき、識別子では断定できない。
    expect(interpretWellnessRefetch("id", []).kind).toBe("deleted");
    expect(interpretWellnessRefetch("identifier", []).kind).toBe("unresolved");
    expect(interpretWellnessRefetch("identifier", ["row"]).kind).toBe("found");
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
        conditionKey(),
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
        conditionKey(),
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
        conditionKey(),
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
        conditionKey(),
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
        conditionKey(),
        catalog,
      ),
    );
    expect(updated.entry.overallScore).toBe(5);
    expect(updated.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["headache"]);
  });

  it("症状リンクの失敗は本体ごと巻き戻る（1トランザクション）", async () => {
    const recordedAt = "2026-01-16T08:00:00.000Z";
    const key = "eeee0001-0000-4000-8000-000000000001";

    // カタログには載っているが、DB からは消えている症状種別を用意する
    // （カタログを読んでから他の操作で消えた、という競合の再現）。
    await db.query(
      `insert into public.symptom_types (owner_id, symptom_key, display_name)
       values ($1, 'vanishing_symptom', '消える症状')`,
      [userId],
    );
    const stale = await expectOk(await loadCatalogs(supabase, userId));
    const vanishingId = stale.symptoms.byKey.get("vanishing_symptom")?.id ?? "";
    expect(vanishingId).not.toBe("");
    await db.query("delete from public.symptom_types where id = $1", [vanishingId]);

    // 症状リンクの登録で落ちる。本体の作成も同じトランザクションなので巻き戻る。
    const failed = await expectError(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, overallScore: 7, symptoms: [{ symptomTypeId: vanishingId }] },
        key,
        stale,
      ),
    );
    expect(failed.status).toBe(404);

    // 本体だけが確定した中途半端な状態が残っていない。
    const orphan = await db.query<{ count: string }>(
      `select count(*)::text as count from public.condition_entries
       where owner_id = $1 and recorded_at = $2`,
      [userId, recordedAt],
    );
    expect(orphan.rows[0]?.count).toBe("0");

    // 冪等キーの適用結果も残っていない（残ると再送が「適用済み」に化ける）。
    const logged = await db.query<{ count: string }>(
      `select count(*)::text as count from public.wellness_mutation_log
       where owner_id = $1 and client_mutation_id = $2`,
      [userId, key],
    );
    expect(logged.rows[0]?.count).toBe("0");

    // 同じ冪等キーのまま安全に再試行できる（未適用なので新規作成になる）。
    const retried = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, overallScore: 7, symptoms: [{ symptomTypeId: headacheTypeId }] },
        key,
        catalog,
      ),
    );
    expect(retried.outcome).toBe("created");
    expect(retried.entry.symptoms.map((symptom) => symptom.symptomKey)).toEqual(["headache"]);

    // もう一度同じキーで送れば、409 ではなく当時の応答が返る。
    const replay = await expectOk(
      await saveConditionEntry(
        supabase,
        userId,
        { recordedAt, overallScore: 7, symptoms: [{ symptomTypeId: headacheTypeId }] },
        key,
        catalog,
      ),
    );
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.entry.id).toBe(retried.entry.id);
    expect(replay.entry.rowVersion).toBe(retried.entry.rowVersion);
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
        conditionKey(),
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
        conditionKey(),
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
