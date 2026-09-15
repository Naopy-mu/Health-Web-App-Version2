// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildSupplementRefetchQuery,
  interpretSupplementRefetch,
} from "@/features/supplements/conflict";
import { supplementListQuerySchema } from "@/features/supplements/schema";
import {
  deleteSupplementRow,
  listIntakes,
  listLots,
  listSchedules,
  loadCatalog,
  recordIntake,
  saveLot,
  saveProduct,
  saveSchedule,
  voidIntake,
  type SupplementCatalog,
} from "@/server/supplements/repository";

import { createMigratedDatabase, signUp } from "./pglite";
import { createPglitePostgrest } from "./supabase-pglite";

/**
 * 冪等再送・楽観ロック・409 からの復帰を、migration を適用した実データベースと
 * 実リポジトリの組み合わせで検証する（実装仕様書 5.6節 / 6.4節）。
 *
 * > 同一 `client_mutation_id` による再送（同時多重送信を含む）は、競合状態でも
 * > 必ず同一の成功応答（idempotent replay）を返す。row_version の不一致による
 * > 409 は、実際に異なる内容での競合時のみ発生させる。（実装仕様書 5.3節。
 * > 全機能に共通の契約）
 *
 * サプリメントには**2種類の冪等キー**がある（docs/api/supplements.md 1.5節）。
 *   - `idempotencyKey`（8〜200文字）: 服用固有の業務キー。二重の在庫消費を防ぐ
 *   - `clientMutationId`（UUID）: 共通のオフライン再送キー。履歴は
 *     `supplement_mutation_log` に残り、**何世代前の再送でも**同じ応答を返す
 *
 * あわせて Phase 3b / 4-1a の教訓（「409 の対象は主キーで特定する」）を確認する。
 */

async function expectOk<T>(
  result: { ok: true; value: T } | { ok: false; response: Response },
): Promise<T> {
  if (!result.ok) {
    const body = await result.response.clone().text();
    throw new Error(`expected success but got ${result.response.status}: ${body}`);
  }
  return result.value;
}

async function expectError(
  result: { ok: true; value: unknown } | { ok: false; response: Response },
): Promise<{ status: number; code: string }> {
  if (result.ok) {
    throw new Error("expected an error response but the call succeeded");
  }
  const body = (await result.response.clone().json()) as { error: { code: string } };
  return { status: result.response.status, code: body.error.code };
}

const query = (overrides: Record<string, string> = {}) =>
  supplementListQuerySchema.parse(overrides);

let uuidSeed = 0;
const cmid = (): string => {
  uuidSeed += 1;
  return `bbbb0001-0000-4000-8000-${String(uuidSeed).padStart(12, "0")}`;
};

let intakeSeed = 0;
const intakeKey = (): string => {
  intakeSeed += 1;
  return `idem-intake-${String(intakeSeed).padStart(6, "0")}`;
};

describe("サプリメントの冪等再送と 409 からの復帰 (実装仕様書 5.6節 / 6.4節)", () => {
  let db: PGlite;
  let userId: string;
  let supabase: SupabaseClient;
  let catalog: SupplementCatalog;
  let productId: string;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "supplements-idempotency@example.test");
    supabase = createPglitePostgrest(db, userId);

    const empty = await expectOk(await loadCatalog(supabase, userId));
    const created = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          productKey: "idem_product",
          name: "冪等性検査用サプリ",
          category: "vitamin",
          form: "tablet",
          defaultAmount: 1,
          defaultUnit: "tablet",
          lowStockThreshold: 3,
        },
        undefined,
        empty,
      ),
    );
    productId = created.product.id;

    catalog = await expectOk(await loadCatalog(supabase, userId));
    await expectOk(
      await saveLot(
        supabase,
        userId,
        { productId, lotCode: "stock", quantity: 100, expiresOn: "2028-01-31" },
        undefined,
        catalog,
      ),
    );
    catalog = await expectOk(await loadCatalog(supabase, userId));
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  const reload = async (): Promise<SupplementCatalog> =>
    expectOk(await loadCatalog(supabase, userId));

  /* ------------------------------------------------------------------ */
  /* 商品: 冪等キーの全世代再送                                          */
  /* ------------------------------------------------------------------ */

  it("商品: 何世代前の clientMutationId で再送しても当時の応答が返る", async () => {
    const keyA = cmid();
    const keyB = cmid();
    const keyC = cmid();

    const base = {
      productKey: "generations",
      name: "世代検査サプリ",
      category: "mineral" as const,
      form: "capsule" as const,
      defaultUnit: "capsule" as const,
    };

    const a = await expectOk(await saveProduct(supabase, userId, base, keyA, await reload()));
    expect(a.outcome).toBe("created");
    expect(a.product.rowVersion).toBe(1);

    const b = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          id: a.product.id,
          expectedRowVersion: 1,
          ...base,
          productKey: undefined,
          name: "世代検査サプリB",
        },
        keyB,
        await reload(),
      ),
    );
    expect(b.outcome).toBe("updated");
    expect(b.product.rowVersion).toBe(2);

    const c = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          id: a.product.id,
          expectedRowVersion: 2,
          ...base,
          productKey: undefined,
          name: "世代検査サプリC",
        },
        keyC,
        await reload(),
      ),
    );
    expect(c.outcome).toBe("updated");
    expect(c.product.rowVersion).toBe(3);

    // 2世代前（A）の再送でも 409 にならず、**当時の行**（row_version=1、名前も当時）が返る。
    const replayA = await expectOk(await saveProduct(supabase, userId, base, keyA, await reload()));
    expect(replayA.outcome).toBe("idempotent_replay");
    expect(replayA.product.id).toBe(a.product.id);
    expect(replayA.product.rowVersion).toBe(1);
    expect(replayA.product.name).toBe("世代検査サプリ");

    // 1世代前（B）も同じ。
    const replayB = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          id: a.product.id,
          expectedRowVersion: 1,
          ...base,
          productKey: undefined,
          name: "世代検査サプリB",
        },
        keyB,
        await reload(),
      ),
    );
    expect(replayB.outcome).toBe("idempotent_replay");
    expect(replayB.product.rowVersion).toBe(2);
    expect(replayB.product.name).toBe("世代検査サプリB");

    // 現在の行は C のまま（再送で版番号が巻き戻ったりしていない）。
    const current = await reload();
    expect(current.byId.get(a.product.id)?.rowVersion).toBe(3);
    expect(current.byId.get(a.product.id)?.name).toBe("世代検査サプリC");
  });

  it("商品: 名称の重複は 409、別のキーでの同時多重送信は replay", async () => {
    const key = cmid();
    const input = {
      productKey: "duplicate_probe",
      name: "重複検査サプリ",
      category: "other" as const,
      form: "other" as const,
      defaultUnit: "piece" as const,
    };

    const [a, b] = await Promise.all([
      saveProduct(supabase, userId, input, key, await reload()),
      saveProduct(supabase, userId, input, key, await reload()),
    ]);

    const first = await expectOk(a);
    const second = await expectOk(b);
    expect([first.outcome, second.outcome].filter((o) => o === "created")).toHaveLength(1);
    expect(first.product.id).toBe(second.product.id);

    // 別のキーで同じ名前を作ろうとすると、それは本当の重複競合。
    const conflict = await expectError(
      await saveProduct(
        supabase,
        userId,
        { ...input, productKey: "duplicate_probe_2" },
        cmid(),
        await reload(),
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("SUPPLEMENT_DUPLICATE_CONFLICT");
  });

  /* ------------------------------------------------------------------ */
  /* 服用: 2種類の冪等キー                                               */
  /* ------------------------------------------------------------------ */

  it("服用: 同じ idempotencyKey の再送は在庫を二重に減らさない", async () => {
    const key = intakeKey();
    const before = (await reload()).byId.get(productId)?.stock.remainingTotal ?? 0;

    const input = {
      productId,
      idempotencyKey: key,
      recordedAt: "2026-09-15T09:00:00.000Z",
      amount: 2,
    };

    const first = await expectOk(await recordIntake(supabase, userId, input, undefined, catalog));
    expect(first.outcome).toBe("created");
    expect(first.stock.remainingTotal).toBe(before - 2);

    // 冪等キーだけを頼りにした再送（clientMutationId なし）。
    const replay = await expectOk(await recordIntake(supabase, userId, input, undefined, catalog));
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.intake.id).toBe(first.intake.id);
    expect(replay.stock.remainingTotal).toBe(before - 2);

    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.supplement_intake_logs where idempotency_key = $1",
      [key],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("服用: 同じ idempotencyKey が競合状態で2回届いても在庫は1回分しか減らない", async () => {
    const key = intakeKey();
    const before = (await reload()).byId.get(productId)?.stock.remainingTotal ?? 0;
    const input = {
      productId,
      idempotencyKey: key,
      recordedAt: "2026-09-15T10:00:00.000Z",
      amount: 3,
    };

    const [a, b] = await Promise.all([
      recordIntake(supabase, userId, input, undefined, catalog),
      recordIntake(supabase, userId, input, undefined, catalog),
    ]);

    const first = await expectOk(a);
    const second = await expectOk(b);

    // 片方だけが `created`、もう片方は `idempotent_replay`。
    // 判定は RPC（ロックの内側）が名乗るので、同時でも取り違えない。
    expect([first.outcome, second.outcome].sort()).toStrictEqual(["created", "idempotent_replay"]);
    expect(first.intake.id).toBe(second.intake.id);

    const after = (await reload()).byId.get(productId)?.stock.remainingTotal ?? 0;
    expect(after).toBe(before - 3);
  });

  it("服用: clientMutationId の再送は、記録後に商品をアーカイブしても成功する", async () => {
    // オフラインキューでは「保存に成功 → 応答を受け取れず → その後に商品を
    // アーカイブ → キューが再送」という順序が普通に起こる。適用済みのキーは
    // 何があっても同じ成功応答を返す契約（実装仕様書 6.4節）。
    const archivable = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          productKey: "archive_after_intake",
          name: "記録後アーカイブ検査",
          category: "other",
          form: "other",
          defaultUnit: "piece",
        },
        cmid(),
        await reload(),
      ),
    );
    let current = await reload();
    await expectOk(
      await saveLot(
        supabase,
        userId,
        { productId: archivable.product.id, quantity: 10, expiresOn: "2028-01-31" },
        cmid(),
        current,
      ),
    );
    current = await reload();

    const mutationId = cmid();
    const input = {
      productId: archivable.product.id,
      idempotencyKey: intakeKey(),
      recordedAt: "2026-09-15T11:00:00.000Z",
      amount: 1,
    };

    const saved = await expectOk(await recordIntake(supabase, userId, input, mutationId, current));
    expect(saved.outcome).toBe("created");

    await db.query("update public.supplement_products set archived_at = now() where id = $1", [
      archivable.product.id,
    ]);

    const replay = await expectOk(
      await recordIntake(supabase, userId, input, mutationId, await reload()),
    );
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.intake.id).toBe(saved.intake.id);

    // 未適用のキーはこれまでどおり拒否される（アーカイブ済み商品への新規記録）。
    const rejected = await expectError(
      await recordIntake(
        supabase,
        userId,
        { ...input, idempotencyKey: intakeKey() },
        cmid(),
        await reload(),
      ),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("SUPPLEMENT_PRODUCT_ARCHIVED");
  });

  it("服用: 記録と取消は別世代として記録され、どちらのキーでも当時の応答が返る", async () => {
    const recordKey = cmid();
    const voidKey = cmid();

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId,
          idempotencyKey: intakeKey(),
          recordedAt: "2026-09-15T12:00:00.000Z",
          amount: 1,
        },
        recordKey,
        catalog,
      ),
    );
    expect(saved.outcome).toBe("created");
    expect(saved.intake.status).toBe("taken");

    const voided = await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        voidKey,
        catalog,
      ),
    );
    expect(voided.outcome).toBe("voided");
    expect(voided.intake.status).toBe("voided");

    // 記録時のキーで再送すると、**取消前**のスナップショットが返る。
    const replayRecord = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId,
          idempotencyKey: saved.intake.idempotencyKey,
          recordedAt: "2026-09-15T12:00:00.000Z",
          amount: 1,
        },
        recordKey,
        catalog,
      ),
    );
    expect(replayRecord.outcome).toBe("idempotent_replay");
    expect(replayRecord.intake.status).toBe("taken");
    expect(replayRecord.intake.rowVersion).toBe(saved.intake.rowVersion);

    // 取消時のキーで再送すると、取消後のスナップショットが返る。
    const replayVoid = await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        voidKey,
        catalog,
      ),
    );
    expect(replayVoid.outcome).toBe("idempotent_replay");
    expect(replayVoid.intake.status).toBe("voided");
    expect(replayVoid.intake.rowVersion).toBe(voided.intake.rowVersion);
  });

  it("服用: 版番号が進んだあとの取消は 409（冪等キーを伴わない再試行）", async () => {
    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId,
          idempotencyKey: intakeKey(),
          recordedAt: "2026-09-15T13:00:00.000Z",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );

    await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        undefined,
        catalog,
      ),
    );

    // 別の記録に対して、古い版番号で取り消そうとすると 409。
    const other = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId,
          idempotencyKey: intakeKey(),
          recordedAt: "2026-09-15T13:30:00.000Z",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );
    const conflict = await expectError(
      await voidIntake(
        supabase,
        userId,
        { id: other.intake.id, expectedRowVersion: other.intake.rowVersion + 5 },
        undefined,
        catalog,
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("SUPPLEMENT_CONFLICT");
  });

  /* ------------------------------------------------------------------ */
  /* 409 のあとの対象特定（Phase 3b / 4-1a の教訓）                      */
  /* ------------------------------------------------------------------ */

  it("409 後の対象特定: 主キーの1件取得は日時・商品の絞り込みに依存しない", async () => {
    const schedule = await expectOk(
      await saveSchedule(
        supabase,
        userId,
        {
          productId,
          scheduleKind: "daily",
          timeOfDay: "07:30",
          startDate: "2026-10-01",
          amount: 1,
          unit: "tablet",
        },
        cmid(),
        await reload(),
      ),
    );

    // 古い版番号で更新 → 409。
    const conflict = await expectError(
      await saveSchedule(
        supabase,
        userId,
        {
          id: schedule.schedule.id,
          expectedRowVersion: schedule.schedule.rowVersion + 10,
          productId,
          scheduleKind: "daily",
          timeOfDay: "07:30",
          startDate: "2026-10-01",
          amount: 2,
          unit: "tablet",
        },
        cmid(),
        await reload(),
      ),
    );
    expect(conflict.status).toBe(409);
    expect(conflict.code).toBe("SUPPLEMENT_CONFLICT");

    // 復帰手順: 編集開始時の `id` で1件取得する。
    const refetch = buildSupplementRefetchQuery({
      resource: "schedule",
      id: schedule.schedule.id,
      productId,
      scheduleKind: "daily",
      startDate: "2026-10-01",
    });
    expect(refetch.strategy).toBe("id");

    const found = await expectOk(
      await listSchedules(
        supabase,
        userId,
        query(Object.fromEntries(refetch.params)),
        await reload(),
      ),
    );
    const outcome = interpretSupplementRefetch(refetch.strategy, found.entries);
    expect(outcome.kind).toBe("found");
    if (outcome.kind !== "found") {
      throw new Error("unreachable");
    }

    // 取り直した版番号で再試行すると通る。
    const retried = await expectOk(
      await saveSchedule(
        supabase,
        userId,
        {
          id: schedule.schedule.id,
          expectedRowVersion: outcome.entry.rowVersion,
          productId,
          scheduleKind: "daily",
          timeOfDay: "07:30",
          startDate: "2026-10-01",
          amount: 2,
          unit: "tablet",
        },
        cmid(),
        await reload(),
      ),
    );
    expect(retried.outcome).toBe("updated");
    expect(retried.schedule.amount).toBe(2);
  });

  it("409 後の対象特定: 主キーで引いた0件は「本当に削除された」を意味する", async () => {
    const schedule = await expectOk(
      await saveSchedule(
        supabase,
        userId,
        {
          productId,
          scheduleKind: "once",
          timeOfDay: "21:00",
          startDate: "2026-11-11",
          amount: 1,
          unit: "tablet",
        },
        cmid(),
        await reload(),
      ),
    );

    await expectOk(
      await deleteSupplementRow(supabase, userId, "schedule", schedule.schedule.id, undefined),
    );

    const refetch = buildSupplementRefetchQuery({
      resource: "schedule",
      id: schedule.schedule.id,
      productId,
      scheduleKind: "once",
      startDate: "2026-11-11",
    });
    const found = await expectOk(
      await listSchedules(
        supabase,
        userId,
        query(Object.fromEntries(refetch.params)),
        await reload(),
      ),
    );
    expect(interpretSupplementRefetch(refetch.strategy, found.entries)).toStrictEqual({
      kind: "deleted",
    });
  });

  it("409 後の対象特定: 日時・商品を書き換えられても id なら必ず到達できる", async () => {
    // 競合した側が「その予定の開始日と商品」を変更していた場合、識別子で
    // 引き直すと0件になり「削除された」と誤判定してしまう。`id` なら到達できる。
    const other = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          productKey: "moved_target",
          name: "移動先サプリ",
          category: "other",
          form: "other",
          defaultUnit: "piece",
        },
        cmid(),
        await reload(),
      ),
    );

    const schedule = await expectOk(
      await saveSchedule(
        supabase,
        userId,
        {
          productId,
          scheduleKind: "daily",
          timeOfDay: "06:00",
          startDate: "2026-12-01",
          amount: 1,
          unit: "tablet",
        },
        cmid(),
        await reload(),
      ),
    );

    // 別端末が識別子ごと書き換える。
    await expectOk(
      await saveSchedule(
        supabase,
        userId,
        {
          id: schedule.schedule.id,
          expectedRowVersion: schedule.schedule.rowVersion,
          productId: other.product.id,
          scheduleKind: "daily",
          timeOfDay: "06:00",
          startDate: "2026-12-20",
          amount: 1,
          unit: "piece",
        },
        cmid(),
        await reload(),
      ),
    );

    // 識別子（商品・開始日）で引き直すと見つからない → 「削除された」と断定しない。
    const byIdentifier = buildSupplementRefetchQuery({
      resource: "schedule",
      productId,
      scheduleKind: "daily",
      startDate: "2026-12-01",
    });
    expect(byIdentifier.strategy).toBe("identifier");
    const identifierResult = await expectOk(
      await listSchedules(
        supabase,
        userId,
        query(Object.fromEntries(byIdentifier.params)),
        await reload(),
      ),
    );
    expect(
      interpretSupplementRefetch(byIdentifier.strategy, identifierResult.entries, {
        resource: "schedule",
        productId,
        scheduleKind: "daily",
        startDate: "2026-12-01",
      }),
    ).toStrictEqual({ kind: "unresolved" });

    // `id` なら必ず1件に到達する。
    const byId = buildSupplementRefetchQuery({
      resource: "schedule",
      id: schedule.schedule.id,
      productId,
      scheduleKind: "daily",
      startDate: "2026-12-01",
    });
    const idResult = await expectOk(
      await listSchedules(supabase, userId, query(Object.fromEntries(byId.params)), await reload()),
    );
    const outcome = interpretSupplementRefetch(byId.strategy, idResult.entries);
    expect(outcome.kind).toBe("found");
    if (outcome.kind === "found") {
      expect(outcome.entry.startDate).toBe("2026-12-20");
      expect(outcome.entry.productId).toBe(other.product.id);
    }
  });

  it("409 後の対象特定: 在庫ロット・服用記録も id で1件取得できる", async () => {
    const lot = await expectOk(
      await saveLot(
        supabase,
        userId,
        { productId, lotCode: "refetch", quantity: 5, expiresOn: "2028-06-30" },
        cmid(),
        await reload(),
      ),
    );

    const lotPage = await expectOk(
      await listLots(supabase, userId, query({ resource: "lot", id: lot.lot.id }), await reload()),
    );
    expect(lotPage.entries.map((entry) => entry.id)).toStrictEqual([lot.lot.id]);

    const intake = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId,
          idempotencyKey: intakeKey(),
          recordedAt: "2026-09-15T14:00:00.000Z",
          amount: 1,
        },
        cmid(),
        await reload(),
      ),
    );

    const intakePage = await expectOk(
      await listIntakes(
        supabase,
        userId,
        query({ resource: "intake", id: intake.intake.id }),
        await reload(),
      ),
    );
    expect(intakePage.entries.map((entry) => entry.id)).toStrictEqual([intake.intake.id]);
    expect(intakePage.nextCursor).toBeNull();
  });

  it("id と他の絞り込みの併用はスキーマが拒否する（1件取得は他条件に依存しない）", () => {
    expect(() =>
      supplementListQuerySchema.parse({
        resource: "intake",
        id: "11111111-1111-4111-8111-111111111111",
        productId: "22222222-2222-4222-8222-222222222222",
      }),
    ).toThrow();

    expect(() =>
      supplementListQuerySchema.parse({
        resource: "intake",
        id: "11111111-1111-4111-8111-111111111111",
        from: "2026-09-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  /* ------------------------------------------------------------------ */
  /* 在庫ロットの冪等再送                                                */
  /* ------------------------------------------------------------------ */

  it("在庫ロット: 冪等キーの再送で在庫が二重に増えない", async () => {
    const key = cmid();
    const before = (await reload()).byId.get(productId)?.stock.remainingTotal ?? 0;
    const input = {
      productId,
      lotCode: "idem-lot",
      quantity: 20,
      expiresOn: "2028-12-31",
    };

    const first = await expectOk(await saveLot(supabase, userId, input, key, await reload()));
    expect(first.outcome).toBe("created");
    expect(first.stock.remainingTotal).toBe(before + 20);

    const replay = await expectOk(await saveLot(supabase, userId, input, key, await reload()));
    expect(replay.outcome).toBe("idempotent_replay");
    expect(replay.lot.id).toBe(first.lot.id);
    // 再送でも在庫は増えない（現在の在庫を載せる）。
    expect(replay.stock.remainingTotal).toBe(before + 20);
  });

  it("在庫ロット: 残量の省略は「触らない」（更新のたびに満タンへ戻らない）", async () => {
    const created = await expectOk(
      await saveLot(
        supabase,
        userId,
        { productId, lotCode: "keep-remaining", quantity: 10, expiresOn: "2029-01-31" },
        cmid(),
        await reload(),
      ),
    );

    await db.query(
      "update public.supplement_inventory_lots set remaining_quantity = 4 where id = $1",
      [created.lot.id],
    );
    const { rows } = await db.query<{ row_version: string }>(
      "select row_version::text from public.supplement_inventory_lots where id = $1",
      [created.lot.id],
    );

    const updated = await expectOk(
      await saveLot(
        supabase,
        userId,
        {
          id: created.lot.id,
          expectedRowVersion: Number(rows[0]?.row_version),
          productId,
          lotCode: "keep-remaining",
          quantity: 10,
          expiresOn: "2029-01-31",
          note: "メモを直しただけ",
        },
        cmid(),
        await reload(),
      ),
    );

    expect(updated.outcome).toBe("updated");
    expect(updated.lot.remainingQuantity).toBe(4);
  });
});
