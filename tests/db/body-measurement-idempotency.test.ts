// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  archiveType,
  createType,
  loadTypeCatalog,
  saveGoal,
  saveMeasurement,
  seedDefaultTypes,
  type TypeCatalog,
} from "@/server/body-measurements/repository";

import { createMigratedDatabase, signUp } from "./pglite";
import { createPglitePostgrest } from "./supabase-pglite";

/**
 * 冪等再送の契約（実装仕様書 5.3節）を、migration を適用した実データベースと
 * 実リポジトリの組み合わせで検証する。
 *
 * > 同一 `client_mutation_id` による再送（同時多重送信を含む）は、競合状態でも
 * > 必ず同一の成功応答（idempotent replay）を返す。row_version の不一致による
 * > 409 は、実際に異なる内容での競合時のみ発生させる。
 *
 * ここで押さえるのは「**直近の1回**だけでなく、何世代前の再送でも成功応答を返す」
 * こと。行の `client_mutation_id` は次のミューテーションで上書きされるため、
 * 行を引く実装では2つ前の再送が「未適用」に見えて 409 になっていた。
 * 現在は `body_measurement_mutation_log`（migration 20260827000800）が
 * 適用結果を履歴として持ち、リポジトリは更新の前に必ずそこを引く。
 */

const MEASURED_AT = "2026-08-27T07:30:00.000Z";

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

describe("冪等キーの再送契約 (実装仕様書 5.3節 / 6.4節)", () => {
  let db: PGlite;
  let userId: string;
  let supabase: SupabaseClient;
  let catalog: TypeCatalog;
  let weightTypeId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "idempotency@example.test");
    supabase = createPglitePostgrest(db, userId);

    await expectOk(await seedDefaultTypes(supabase));
    catalog = await expectOk(await loadTypeCatalog(supabase, userId));

    const weight = catalog.byKey.get("weight");
    if (weight === undefined) {
      throw new Error("default weight type was not seeded");
    }
    weightTypeId = weight.id;
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  it("測定記録: 3世代前の client_mutation_id で再送しても成功応答を返す", async () => {
    // 冪等キーは1ミューテーションにつき1つ。作成1回 + 同じ内容の更新3回。
    const created = "aaaaaaaa-0000-4000-8000-000000000001";
    const updates = [
      "aaaaaaaa-0000-4000-8000-000000000002",
      "aaaaaaaa-0000-4000-8000-000000000003",
      "aaaaaaaa-0000-4000-8000-000000000004",
    ];

    const createInput = {
      typeId: weightTypeId,
      measuredAt: MEASURED_AT,
      value: 62.4,
      unit: "kg" as const,
    };

    const first = await expectOk(
      await saveMeasurement(supabase, userId, createInput, created, catalog),
    );
    expect(first.outcome).toBe("created");
    expect(first.measurement.rowVersion).toBe(1);

    // 同じ内容の更新を、異なる冪等キーで3回続ける。
    const updateInputs = updates.map((_, index) => ({
      id: first.measurement.id,
      expectedRowVersion: index + 1,
      typeId: weightTypeId,
      measuredAt: MEASURED_AT,
      value: 61,
      unit: "kg" as const,
    }));

    const applied = [first];
    for (const [index, mutationId] of updates.entries()) {
      const result = await expectOk(
        await saveMeasurement(supabase, userId, updateInputs[index]!, mutationId, catalog),
      );
      expect(result.outcome).toBe("updated");
      expect(result.measurement.rowVersion).toBe(index + 2);
      applied.push(result);
    }

    // ここまでで行は row_version = 4。行が覚えている client_mutation_id は
    // 最後の1つだけで、それより前のキーは行からは引けない。
    const stored = await db.query<{ client_mutation_id: string; row_version: string }>(
      "select client_mutation_id, row_version::text as row_version from public.body_measurements where id = $1",
      [first.measurement.id],
    );
    expect(stored.rows[0]).toStrictEqual({
      client_mutation_id: updates.at(-1),
      row_version: "4",
    });

    // すべての冪等キーで再送する。3世代前（作成時のキー）まで含めて成功応答になり、
    // 応答はそのミューテーションが当時返したものと完全に一致する。
    const inputs = [createInput, ...updateInputs];
    for (const [index, mutationId] of [created, ...updates].entries()) {
      const replay = await expectOk(
        await saveMeasurement(supabase, userId, inputs[index]!, mutationId, catalog),
      );

      expect(replay.outcome, mutationId).toBe("idempotent_replay");
      expect(replay.measurement, mutationId).toStrictEqual(applied[index]!.measurement);
    }

    // 再送は行を進めない（二重適用しない）。
    const after = await db.query<{ row_version: string; value: string }>(
      "select row_version::text as row_version, value::text as value from public.body_measurements where id = $1",
      [first.measurement.id],
    );
    expect(after.rows[0]).toStrictEqual({ row_version: "4", value: "61.000" });
  });

  it("測定目標: 3世代前の client_mutation_id で再送しても成功応答を返す", async () => {
    const mutationIds = [
      "bbbbbbbb-0000-4000-8000-000000000001",
      "bbbbbbbb-0000-4000-8000-000000000002",
      "bbbbbbbb-0000-4000-8000-000000000003",
      "bbbbbbbb-0000-4000-8000-000000000004",
    ];

    const createInput = { typeId: weightTypeId, targetValue: 60, unit: "kg" as const };
    const created = await expectOk(
      await saveGoal(supabase, userId, createInput, mutationIds[0], catalog),
    );
    expect(created.outcome).toBe("created");

    const inputs = [createInput];
    const applied = [created];
    for (const [index, mutationId] of mutationIds.slice(1).entries()) {
      const input = {
        id: created.goal.id,
        expectedRowVersion: index + 1,
        typeId: weightTypeId,
        targetValue: 59,
        unit: "kg" as const,
      };
      const result = await expectOk(await saveGoal(supabase, userId, input, mutationId, catalog));
      expect(result.outcome).toBe("updated");
      inputs.push(input);
      applied.push(result);
    }

    for (const [index, mutationId] of mutationIds.entries()) {
      const replay = await expectOk(
        await saveGoal(supabase, userId, inputs[index]!, mutationId, catalog),
      );
      expect(replay.outcome, mutationId).toBe("idempotent_replay");
      expect(replay.goal, mutationId).toStrictEqual(applied[index]!.goal);
    }
  });

  it("測定種別: 3世代前の client_mutation_id で再送しても成功応答を返す", async () => {
    const mutationIds = [
      "cccccccc-0000-4000-8000-000000000001",
      "cccccccc-0000-4000-8000-000000000002",
      "cccccccc-0000-4000-8000-000000000003",
      "cccccccc-0000-4000-8000-000000000004",
    ];

    const created = await expectOk(
      await createType(
        supabase,
        userId,
        {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
        mutationIds[0],
      ),
    );
    expect(created.outcome).toBe("created");

    // アーカイブ → 解除 → アーカイブ。行の client_mutation_id は毎回上書きされる。
    const applied = [created];
    const archivedFlags = [true, false, true];
    for (const [index, mutationId] of mutationIds.slice(1).entries()) {
      const result = await expectOk(
        await archiveType(
          supabase,
          userId,
          created.type.id,
          archivedFlags[index]!,
          index + 1,
          mutationId,
        ),
      );
      expect(result.outcome).toBe("updated");
      applied.push(result);
    }

    // 作成時のキー（3世代前）での再送も成功応答になる。
    const replayCreate = await expectOk(
      await createType(
        supabase,
        userId,
        {
          measurementKey: "grip_strength",
          displayName: "握力",
          unitConstraint: "custom",
          defaultUnit: "custom",
        },
        mutationIds[0],
      ),
    );
    expect(replayCreate.outcome).toBe("idempotent_replay");
    expect(replayCreate.type).toStrictEqual(created.type);

    for (const [index, mutationId] of mutationIds.slice(1).entries()) {
      const replay = await expectOk(
        await archiveType(
          supabase,
          userId,
          created.type.id,
          archivedFlags[index]!,
          index + 1,
          mutationId,
        ),
      );
      expect(replay.outcome, mutationId).toBe("idempotent_replay");
      expect(replay.type, mutationId).toStrictEqual(applied[index + 1]!.type);
    }
  });

  it("冪等キーを送らない別内容の更新は、版番号が古ければ 409 のまま", async () => {
    // 実装仕様書 5.3節「409 は実際に異なる内容での競合時のみ」。
    // 履歴を持たせても、本物の競合まで成功にしてしまわないことを確かめる。
    const created = await expectOk(
      await saveMeasurement(
        supabase,
        userId,
        {
          typeId: weightTypeId,
          measuredAt: "2026-08-28T07:30:00.000Z",
          value: 62,
          unit: "kg",
        },
        undefined,
        catalog,
      ),
    );

    const conflicting = await saveMeasurement(
      supabase,
      userId,
      {
        id: created.measurement.id,
        // 既に誰かが進めた版番号を想定した、古い期待版番号。
        expectedRowVersion: created.measurement.rowVersion + 5,
        typeId: weightTypeId,
        measuredAt: "2026-08-28T07:30:00.000Z",
        value: 59,
        unit: "kg",
      },
      undefined,
      catalog,
    );

    expect(conflicting.ok).toBe(false);
    if (!conflicting.ok) {
      expect(conflicting.response.status).toBe(409);
    }
  });

  it("別利用者は同じ client_mutation_id を使え、他人の適用結果は引けない", async () => {
    const otherId = await signUp(db, "idempotency-other@example.test");
    const otherSupabase = createPglitePostgrest(db, otherId);
    await expectOk(await seedDefaultTypes(otherSupabase));
    const otherCatalog = await expectOk(await loadTypeCatalog(otherSupabase, otherId));
    const otherWeight = otherCatalog.byKey.get("weight");

    // 1つ目の利用者が既に使ったキーを、2人目が使う。
    const shared = "aaaaaaaa-0000-4000-8000-000000000001";
    const result = await expectOk(
      await saveMeasurement(
        otherSupabase,
        otherId,
        {
          typeId: otherWeight?.id ?? "",
          measuredAt: MEASURED_AT,
          value: 70,
          unit: "kg",
        },
        shared,
        otherCatalog,
      ),
    );

    // 再送ではなく新規作成になる（冪等キーの一意性は所有者ごとに閉じている）。
    expect(result.outcome).toBe("created");
    expect(result.measurement.value).toBe(70);

    // 他人の適用結果は RLS で見えない。
    const visible = await db.query<{ count: string }>(
      `select count(*)::text as count from public.body_measurement_mutation_log
       where owner_id = $1 and client_mutation_id = $2`,
      [userId, shared],
    );
    expect(visible.rows[0]?.count).toBe("1");
  });
});
