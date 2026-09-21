// @vitest-environment node
import type { PGlite } from "@electric-sql/pglite";
import type { SupabaseClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { planFefoConsumption, sortLotsByFefo } from "@/features/supplements/units";
import {
  loadCatalog,
  recordIntake,
  saveLot,
  saveProduct,
  voidIntake,
  type SupplementCatalog,
} from "@/server/supplements/repository";

import { createMigratedDatabase, signUp } from "./pglite";
import { createPglitePostgrest } from "./supabase-pglite";

/**
 * FEFO（First-Expired-First-Out）在庫消費と取消復元
 * （実装仕様書 5.6節 / migration 20260915000400）。
 *
 * > 服用時は期限が近いロットから消費（FEFO）し、負在庫となる操作は原子的RPC
 * > （`record_supplement_intake` / `void_supplement_intake`）が拒否する。
 *
 * migration を適用した実データベースへ実リポジトリを通して書き、
 *   - 複数ロットにまたがる消費の配分
 *   - 期限が同じ場合の優先順位（開封済み → 購入が古い → 登録が古い）
 *   - 在庫不足の拒否と**巻き戻り**（記録もロットも残らないこと）
 *   - 負在庫を作ろうとする操作が CHECK 制約でも止まること
 *   - 取消による**正確な**在庫復元（ロット単位で消費した量だけ戻す）
 * を確認する。
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
    throw new Error("expected an error response but the call succeeded");
  }
  const body = (await result.response.clone().json()) as { error: { code: string } };
  return { status: result.response.status, code: body.error.code };
}

/** 同時実行テストの待ち合わせ点。片方の進行をもう片方の合図まで止める。 */
function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve = (): void => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve: () => resolve() };
}

let keySeed = 0;
const intakeKey = (label: string): string => {
  keySeed += 1;
  return `fefo-${label}-${String(keySeed).padStart(6, "0")}`;
};

describe("FEFO 在庫消費と取消復元 (実装仕様書 5.6節)", () => {
  let db: PGlite;
  let userId: string;
  let supabase: SupabaseClient;
  let productSeed = 0;

  beforeAll(async () => {
    db = await createMigratedDatabase();
    userId = await signUp(db, "supplements-fefo@example.test");
    supabase = createPglitePostgrest(db, userId);
  }, 60_000);

  afterAll(async () => {
    await db?.close();
  });

  /** 検査ごとに独立した商品を作る（在庫が混ざらないように）。 */
  const freshProduct = async (): Promise<{ id: string; catalog: SupplementCatalog }> => {
    productSeed += 1;
    const key = `fefo_product_${productSeed}`;
    const catalog = await expectOk(await loadCatalog(supabase, userId));
    const created = await expectOk(
      await saveProduct(
        supabase,
        userId,
        {
          productKey: key,
          name: `FEFO検査商品${productSeed}`,
          category: "vitamin",
          form: "tablet",
          defaultAmount: 1,
          defaultUnit: "tablet",
          lowStockThreshold: 5,
        },
        undefined,
        catalog,
      ),
    );
    return {
      id: created.product.id,
      catalog: await expectOk(await loadCatalog(supabase, userId)),
    };
  };

  const addLot = async (
    productId: string,
    catalog: SupplementCatalog,
    lot: {
      lotCode: string;
      quantity: number;
      expiresOn?: string | null;
      openedOn?: string | null;
      purchasedOn?: string | null;
    },
  ): Promise<string> => {
    const saved = await expectOk(
      await saveLot(
        supabase,
        userId,
        {
          productId,
          lotCode: lot.lotCode,
          quantity: lot.quantity,
          expiresOn: lot.expiresOn ?? null,
          openedOn: lot.openedOn ?? null,
          purchasedOn: lot.purchasedOn ?? null,
        },
        undefined,
        catalog,
      ),
    );
    return saved.lot.id;
  };

  /** ロットの残量を `lotCode` で読む（並びは lotCode 昇順）。 */
  const remainingByCode = async (productId: string): Promise<Record<string, number>> => {
    const { rows } = await db.query<{ lot_code: string; remaining_quantity: string }>(
      `select lot_code, remaining_quantity::text
         from public.supplement_inventory_lots
        where owner_id = $1 and product_id = $2
        order by lot_code`,
      [userId, productId],
    );
    return Object.fromEntries(rows.map((row) => [row.lot_code, Number(row.remaining_quantity)]));
  };

  /* ------------------------------------------------------------------ */
  /* 基本の FEFO                                                         */
  /* ------------------------------------------------------------------ */

  it("期限が近いロットから消費し、足りなければ次のロットへ繰り越す", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "late", quantity: 10, expiresOn: "2027-06-30" });
    await addLot(id, catalog, { lotCode: "early", quantity: 3, expiresOn: "2026-12-31" });
    await addLot(id, catalog, { lotCode: "middle", quantity: 4, expiresOn: "2027-01-31" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("multi-lot"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 5,
        },
        undefined,
        catalog,
      ),
    );

    expect(saved.outcome).toBe("created");
    expect(saved.intake.consumedQuantity).toBe(5);
    // early(3) を使い切り、middle から 2 を引く。late には触らない。
    expect(await remainingByCode(id)).toStrictEqual({ early: 0, middle: 2, late: 10 });
    expect(saved.stock.remainingTotal).toBe(12);
  });

  it("使用期限が未設定のロットは最後に回す（期限のあるものを先に使い切る）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "no_expiry", quantity: 10, expiresOn: null });
    await addLot(id, catalog, { lotCode: "has_expiry", quantity: 2, expiresOn: "2028-01-31" });

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("nulls-last"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 3,
        },
        undefined,
        catalog,
      ),
    );

    expect(await remainingByCode(id)).toStrictEqual({ has_expiry: 0, no_expiry: 9 });
  });

  it("期限が同じなら開封済みを先に使い切る", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, {
      lotCode: "sealed",
      quantity: 5,
      expiresOn: "2027-03-31",
      purchasedOn: "2026-01-01",
    });
    await addLot(id, catalog, {
      lotCode: "opened",
      quantity: 5,
      expiresOn: "2027-03-31",
      purchasedOn: "2026-02-01",
      openedOn: "2026-08-01",
    });

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("opened-first"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 5,
        },
        undefined,
        catalog,
      ),
    );

    // 開封済み（opened）を使い切る。購入は sealed の方が古いが、開封済みが優先。
    expect(await remainingByCode(id)).toStrictEqual({ opened: 0, sealed: 5 });
  });

  it("期限も開封状態も同じなら購入が古いロットから使う", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, {
      lotCode: "newer",
      quantity: 5,
      expiresOn: "2027-03-31",
      purchasedOn: "2026-05-01",
    });
    await addLot(id, catalog, {
      lotCode: "older",
      quantity: 5,
      expiresOn: "2027-03-31",
      purchasedOn: "2026-01-01",
    });

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("older-first"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 2,
        },
        undefined,
        catalog,
      ),
    );

    expect(await remainingByCode(id)).toStrictEqual({ older: 3, newer: 5 });
  });

  it("すべての識別要素が同じでも登録順で決まる（並びが実行ごとに変わらない）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "first", quantity: 2, expiresOn: "2027-03-31" });
    await addLot(id, catalog, { lotCode: "second", quantity: 2, expiresOn: "2027-03-31" });

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("created-at-tiebreak"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 3,
        },
        undefined,
        catalog,
      ),
    );

    expect(await remainingByCode(id)).toStrictEqual({ first: 0, second: 1 });
  });

  it("フロント用の見積もり（planFefoConsumption）がサーバーと同じ配分を出す", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "late", quantity: 10, expiresOn: "2027-06-30" });
    await addLot(id, catalog, { lotCode: "early", quantity: 3, expiresOn: "2026-12-31" });

    // ロットを「フロントが受け取る形」に寄せて読む（`saveLot` の応答と同じ値）。
    const { rows } = await db.query<{
      id: string;
      lot_code: string;
      remaining_quantity: string;
      expires_on: Date | null;
      opened_on: Date | null;
      purchased_on: Date | null;
      created_at: Date;
    }>(
      `select id, lot_code, remaining_quantity::text, expires_on, opened_on, purchased_on, created_at
         from public.supplement_inventory_lots where owner_id = $1 and product_id = $2`,
      [userId, id],
    );
    const before = rows.map((row) => ({
      id: row.id,
      lotCode: row.lot_code,
      remainingQuantity: Number(row.remaining_quantity),
      expiresOn: row.expires_on?.toISOString().slice(0, 10) ?? null,
      openedOn: row.opened_on?.toISOString().slice(0, 10) ?? null,
      purchasedOn: row.purchased_on?.toISOString().slice(0, 10) ?? null,
      createdAt: row.created_at.toISOString(),
    }));

    const plan = planFefoConsumption(before, 5);
    expect(plan.shortfall).toBe(0);
    const planned = plan.steps.map((step) => [
      before.find((lot) => lot.id === step.lotId)?.lotCode,
      step.quantity,
    ]);
    expect(planned).toStrictEqual([
      ["early", 3],
      ["late", 2],
    ]);
    // 並び順の助け（sortLotsByFefo）も同じ順序を返す。
    expect(sortLotsByFefo(before).map((lot) => lot.lotCode)).toStrictEqual(["early", "late"]);

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("plan-matches"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 5,
        },
        undefined,
        catalog,
      ),
    );
    expect(await remainingByCode(id)).toStrictEqual({ early: 0, late: 8 });
  });

  /* ------------------------------------------------------------------ */
  /* 負在庫の拒否（実装仕様書 5.6節）                                    */
  /* ------------------------------------------------------------------ */

  it("在庫が足りない服用は 409 で拒否され、記録もロットも一切変わらない", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "only", quantity: 4, expiresOn: "2027-01-31" });

    const rejected = await expectError(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("insufficient"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 5,
        },
        undefined,
        catalog,
      ),
    );

    expect(rejected.status).toBe(409);
    expect(rejected.code).toBe("SUPPLEMENT_INSUFFICIENT_STOCK");

    // 原子性: 記録は残らず、在庫も減っていない。
    expect(await remainingByCode(id)).toStrictEqual({ only: 4 });
    const { rows } = await db.query<{ count: string }>(
      "select count(*)::text as count from public.supplement_intake_logs where product_id = $1",
      [id],
    );
    expect(rows[0]?.count).toBe("0");

    // 在庫の動きにも「消費しようとした」跡は残らない。
    const { rows: movements } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.supplement_inventory_movements
        where product_id = $1 and movement_kind = 'intake_consume'`,
      [id],
    );
    expect(movements[0]?.count).toBe("0");
  });

  it("在庫が1件も無い商品への服用も 409 で拒否される", async () => {
    const { id, catalog } = await freshProduct();

    const rejected = await expectError(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("no-lots"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );
    expect(rejected.status).toBe(409);
    expect(rejected.code).toBe("SUPPLEMENT_INSUFFICIENT_STOCK");
  });

  it("スキップは在庫を減らさずに記録できる（在庫が空でも成立する）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "kept", quantity: 2, expiresOn: "2027-01-31" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("skipped"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          status: "skipped",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );

    expect(saved.intake.status).toBe("skipped");
    expect(saved.intake.consumedQuantity).toBe(0);
    expect(await remainingByCode(id)).toStrictEqual({ kept: 2 });
  });

  it("consumeQuantity に 0 を指定すると在庫を引かずに記録だけ残せる", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "untouched", quantity: 2, expiresOn: "2027-01-31" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("zero-consume"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 1,
          consumeQuantity: 0,
        },
        undefined,
        catalog,
      ),
    );

    expect(saved.intake.status).toBe("taken");
    expect(saved.intake.consumedQuantity).toBe(0);
    expect(await remainingByCode(id)).toStrictEqual({ untouched: 2 });
  });

  it("服用の単位が在庫の単位と違うときは換算量の明示を求める（400）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "mg_probe", quantity: 10, expiresOn: "2027-01-31" });

    const rejected = await expectError(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("unit-mismatch"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 500,
          unit: "mg",
        },
        undefined,
        catalog,
      ),
    );
    expect(rejected.status).toBe(400);
    expect(rejected.code).toBe("SUPPLEMENT_UNIT_MISMATCH");

    // 換算量を明示すればその量だけ引かれる。
    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("unit-mismatch-ok"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 500,
          unit: "mg",
          consumeQuantity: 2,
        },
        undefined,
        catalog,
      ),
    );
    expect(saved.intake.consumedQuantity).toBe(2);
    expect(await remainingByCode(id)).toStrictEqual({ mg_probe: 8 });
  });

  it("同時実行: 残量を超える2件の服用が同時に届いても、通るのは1件だけ", async () => {
    // PGlite は接続が1本なので、2つのトランザクションを本当に並行はできない。
    // その代わり「片方が冪等ログを引き終えた直後に、もう片方の消費を最後まで
    // 確定させる」という割り込みを差し込み、**在庫を観測したあとに別の消費が
    // 確定した**状況を作る。
    //
    // 在庫の判定と減算を API 側で（読んでから引く形で）やっていると、ここで
    // 両方が「3錠ある」と観測して両方成功し、残量が -1 になる。実際には判定も
    // 減算も `record_supplement_intake` の内側（所有者ロックの内側）で起きるため、
    // 後から入った側は最新の残量を見て 409 になる。
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "contested", quantity: 3, expiresOn: "2027-01-31" });

    const lookupDone = deferred();
    const leaderDone = deferred();

    // カタログの読み込みでは割り込まない（本番でも RPC 直前の窓が問題なので）。
    let armed = false;
    let interrupted = false;
    const follower = createPglitePostgrest(db, userId, {
      afterQuery: async (sql) => {
        if (!armed || interrupted || !sql.includes("supplement_mutation_log")) {
          return;
        }
        interrupted = true;
        lookupDone.resolve();
        await leaderDone.promise;
      },
    });

    const followerCatalog = await expectOk(await loadCatalog(follower, userId));
    armed = true;

    const leader = (async () => {
      await lookupDone.promise;
      const saved = await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("race-leader"),
          recordedAt: "2026-09-15T10:00:00.000Z",
          amount: 2,
        },
        undefined,
        catalog,
      );
      leaderDone.resolve();
      return saved;
    })();

    const [first, second] = await Promise.all([
      leader,
      recordIntake(
        follower,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("race-follower"),
          recordedAt: "2026-09-15T10:00:01.000Z",
          amount: 2,
        },
        // 冪等キーを付けると、RPC を呼ぶ前に冪等ログを引く。そこが割り込み点。
        "aaaa0001-0000-4000-8000-000000000001",
        followerCatalog,
      ),
    ]);

    expect(interrupted).toBe(true);

    const leaderResult = await expectOk(first);
    expect(leaderResult.intake.consumedQuantity).toBe(2);

    const followerError = await expectError(second);
    expect(followerError.status).toBe(409);
    expect(followerError.code).toBe("SUPPLEMENT_INSUFFICIENT_STOCK");

    // 残量は 1（3 - 2）。負在庫にはならない。
    expect(await remainingByCode(id)).toStrictEqual({ contested: 1 });
  });

  /* ------------------------------------------------------------------ */
  /* 取消による在庫復元（実装仕様書 5.6節）                              */
  /* ------------------------------------------------------------------ */

  it("取消は消費したロットへ消費した量だけ正確に戻す（複数ロットにまたがっても）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "early", quantity: 3, expiresOn: "2026-12-31" });
    await addLot(id, catalog, { lotCode: "late", quantity: 10, expiresOn: "2027-06-30" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("void-restore"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 5,
        },
        undefined,
        catalog,
      ),
    );
    expect(await remainingByCode(id)).toStrictEqual({ early: 0, late: 8 });

    const voided = await expectOk(
      await voidIntake(
        supabase,
        userId,
        {
          id: saved.intake.id,
          expectedRowVersion: saved.intake.rowVersion,
          reason: "飲み忘れ訂正",
        },
        undefined,
        catalog,
      ),
    );

    expect(voided.outcome).toBe("voided");
    expect(voided.intake.status).toBe("voided");
    expect(voided.intake.voidedAt).not.toBeNull();
    expect(voided.intake.voidReason).toBe("飲み忘れ訂正");
    // 記録当時の消費量はそのまま残す（在庫は movements の復元行で戻る）。
    expect(voided.intake.consumedQuantity).toBe(5);

    // **元のロットへ元の量だけ**戻る（late へまとめて 5 戻すのではない）。
    expect(await remainingByCode(id)).toStrictEqual({ early: 3, late: 10 });
    expect(voided.stock.remainingTotal).toBe(13);

    const { rows } = await db.query<{
      movement_kind: string;
      quantity_delta: string;
      lot_code: string;
    }>(
      `select m.movement_kind, m.quantity_delta::text, l.lot_code
         from public.supplement_inventory_movements m
         join public.supplement_inventory_lots l on l.id = m.lot_id
        where m.intake_log_id = $1
        order by m.created_at, l.lot_code`,
      [saved.intake.id],
    );
    expect(
      rows.map((row) => [row.movement_kind, row.lot_code, Number(row.quantity_delta)]),
    ).toStrictEqual([
      ["intake_consume", "early", -3],
      ["intake_consume", "late", -2],
      ["intake_void_restore", "early", 3],
      ["intake_void_restore", "late", 2],
    ]);
  });

  it("取消したぶんの在庫はすぐ再利用できる（同じ量をもう一度飲める）", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "single", quantity: 2, expiresOn: "2027-01-31" });

    const first = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("reuse-1"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 2,
        },
        undefined,
        catalog,
      ),
    );
    expect(await remainingByCode(id)).toStrictEqual({ single: 0 });

    await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: first.intake.id, expectedRowVersion: first.intake.rowVersion },
        undefined,
        catalog,
      ),
    );

    const second = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("reuse-2"),
          recordedAt: "2026-09-15T10:00:00.000Z",
          amount: 2,
        },
        undefined,
        catalog,
      ),
    );
    expect(second.intake.consumedQuantity).toBe(2);
    expect(await remainingByCode(id)).toStrictEqual({ single: 0 });
  });

  it("取消済みの記録をもう一度取り消しても在庫は二重に戻らない", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "guarded", quantity: 5, expiresOn: "2027-01-31" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("double-void"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 3,
        },
        undefined,
        catalog,
      ),
    );

    const firstVoid = await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        undefined,
        catalog,
      ),
    );
    expect(firstVoid.outcome).toBe("voided");
    expect(await remainingByCode(id)).toStrictEqual({ guarded: 5 });

    // 2回目は「もう取消済み」として同じ行を返す。版番号は進めない。
    const secondVoid = await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        undefined,
        catalog,
      ),
    );
    expect(secondVoid.outcome).toBe("idempotent_replay");
    expect(secondVoid.intake.rowVersion).toBe(firstVoid.intake.rowVersion);
    expect(await remainingByCode(id)).toStrictEqual({ guarded: 5 });

    // 復元の動きも1回ぶんだけ。
    const { rows } = await db.query<{ count: string }>(
      `select count(*)::text as count from public.supplement_inventory_movements
        where intake_log_id = $1 and movement_kind = 'intake_void_restore'`,
      [saved.intake.id],
    );
    expect(rows[0]?.count).toBe("1");
  });

  it("消費後に残量を手動で減らしていた場合、復元はロットの初期数量で頭打ちになる", async () => {
    const { id, catalog } = await freshProduct();
    const lotId = await addLot(id, catalog, {
      lotCode: "adjusted",
      quantity: 10,
      expiresOn: "2027-01-31",
    });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("capped-restore"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 4,
        },
        undefined,
        catalog,
      ),
    );
    expect(await remainingByCode(id)).toStrictEqual({ adjusted: 6 });

    // 利用者が「数え直したら8錠あった」と手動で増やす（消費分がまだ戻っていない状態）。
    await db.query(
      "update public.supplement_inventory_lots set remaining_quantity = 8 where id = $1",
      [lotId],
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

    // 8 + 4 = 12 だが、ロットに入っていた量（10）を超えては戻さない。
    expect(await remainingByCode(id)).toStrictEqual({ adjusted: 10 });

    // 監査証跡には「実際に戻した量（2）」が残る。
    const { rows } = await db.query<{ quantity_delta: string }>(
      `select quantity_delta::text from public.supplement_inventory_movements
        where intake_log_id = $1 and movement_kind = 'intake_void_restore'`,
      [saved.intake.id],
    );
    expect(rows.map((row) => Number(row.quantity_delta))).toStrictEqual([2]);
  });

  it("スキップした記録の取消は在庫を動かさない", async () => {
    const { id, catalog } = await freshProduct();
    await addLot(id, catalog, { lotCode: "still", quantity: 3, expiresOn: "2027-01-31" });

    const saved = await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("void-skipped"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          status: "skipped",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );

    const voided = await expectOk(
      await voidIntake(
        supabase,
        userId,
        { id: saved.intake.id, expectedRowVersion: saved.intake.rowVersion },
        undefined,
        catalog,
      ),
    );
    expect(voided.outcome).toBe("voided");
    expect(await remainingByCode(id)).toStrictEqual({ still: 3 });
  });

  it("服用に使われたロットは削除できない（取消の復元先を守る）", async () => {
    const { id, catalog } = await freshProduct();
    const lotId = await addLot(id, catalog, {
      lotCode: "used",
      quantity: 3,
      expiresOn: "2027-01-31",
    });

    await expectOk(
      await recordIntake(
        supabase,
        userId,
        {
          productId: id,
          idempotencyKey: intakeKey("lot-in-use"),
          recordedAt: "2026-09-15T09:00:00.000Z",
          amount: 1,
        },
        undefined,
        catalog,
      ),
    );

    const { deleteSupplementRow } = await import("@/server/supplements/repository");
    const rejected = await expectError(
      await deleteSupplementRow(supabase, userId, "lot", lotId, undefined),
    );
    expect(rejected.status).toBe(409);
    expect(rejected.code).toBe("SUPPLEMENT_LOT_IN_USE");
  });

  it("服用に使われていないロットは削除できる（打ち間違えの取り消し）", async () => {
    const { id, catalog } = await freshProduct();
    const lotId = await addLot(id, catalog, {
      lotCode: "typo",
      quantity: 3,
      expiresOn: "2027-01-31",
    });

    const { deleteSupplementRow } = await import("@/server/supplements/repository");
    const deleted = await expectOk(
      await deleteSupplementRow(supabase, userId, "lot", lotId, undefined),
    );
    expect(deleted.deletedId).toBe(lotId);
    expect(await remainingByCode(id)).toStrictEqual({});
  });
});
