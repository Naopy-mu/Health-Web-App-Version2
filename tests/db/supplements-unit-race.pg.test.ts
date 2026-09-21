// @vitest-environment node
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  createMigratedPostgresDatabase,
  dropPostgresDatabase,
  PsqlSession,
  RACE_PG_CONTAINER,
  runPsql,
  settleOrBlock,
} from "./postgres-docker";

/**
 * 商品の既定単位の変更と、同じ商品への在庫ロット作成の同時実行
 * （migration 20260921000300 / 実装仕様書 5.6節）。
 *
 * 不変条件: **在庫ロットの単位は、常に商品の `default_unit` と一致する。**
 *
 * 両側のトリガー（`tg_supplement_lot_guard` / `tg_supplement_product_unit_guard`）は
 * 相手のテーブルを読んで検査するが、READ COMMITTED では相手の**未コミット**の
 * 変更が見えない。直列化しないと、
 *
 *   T1: 商品の default_unit を tablet → g（検査時点でロット0件）
 *   T2: 同じ商品へ tablet のロットを作成（検査時点で商品はまだ tablet）
 *
 * が両方とも検査を通ってコミットされ、商品 = g / ロット = tablet が残る。
 *
 * PGlite では2本の接続を持てず再現できないため、実 PostgreSQL（Docker）で
 * 独立した2つのセッションを本当に競合させる。`RACE_PG_CONTAINER` が
 * 未設定なら飛ばす（手順は tests/README.md）。
 */

const DATABASE = "supplements_unit_race";

/** 指定した商品で、単位が商品と食い違っているロットの件数（不変条件が守られていれば常に0）。 */
function countUnitMismatches(...productIds: string[]): number {
  return Number(
    runPsql(
      DATABASE,
      `select count(*)
         from public.supplement_inventory_lots l
         join public.supplement_products p
           on p.id = l.product_id and p.owner_id = l.owner_id
        where l.unit <> p.default_unit
          and p.id in (${productIds.map((id) => `'${id}'`).join(", ")});`,
    ).trim(),
  );
}

describe.skipIf(RACE_PG_CONTAINER === "")(
  "実 PostgreSQL: 既定単位の変更とロット作成の同時実行 (migration 20260921000300)",
  () => {
    let userId: string;
    let first: PsqlSession;
    let second: PsqlSession;
    let productSeed = 0;

    /** 在庫ロットの無い tablet の商品を新しく作り、その ID を返す。 */
    const createProduct = async (): Promise<string> => {
      productSeed += 1;
      await first.beginAs(userId);
      const inserted = await first.send(
        `insert into public.supplement_products
           (owner_id, product_key, name, category, form, default_amount, default_unit)
         values ('${userId}', 'race_${String(productSeed)}', '競合確認${String(productSeed)}',
                 'vitamin', 'tablet', 1, 'tablet')
         returning id;`,
      );
      expect(inserted.error).toBeNull();
      expect((await first.send("commit;")).error).toBeNull();
      return inserted.output.split("\n")[0]?.trim() ?? "";
    };

    const changeUnitToGram = (productId: string) =>
      first.send(
        `update public.supplement_products set default_unit = 'g'
          where id = '${productId}' and owner_id = '${userId}';`,
      );

    const insertTabletLot = (productId: string) =>
      second.send(
        `insert into public.supplement_inventory_lots
           (owner_id, product_id, quantity, remaining_quantity, unit)
         values ('${userId}', '${productId}', 30, 30, 'tablet');`,
      );

    beforeAll(() => {
      createMigratedPostgresDatabase(DATABASE);
      userId = runPsql(
        DATABASE,
        "insert into auth.users (email) values ('unit-race@example.test') returning id;",
      )
        .split("\n")[0]!
        .trim();
    }, 120_000);

    beforeEach(() => {
      first = new PsqlSession(DATABASE, "unit_race_t1");
      second = new PsqlSession(DATABASE, "unit_race_t2");
      return async () => {
        await Promise.all([first.close(), second.close()]);
      };
    });

    afterAll(() => {
      dropPostgresDatabase(DATABASE);
    });

    it("単位変更が先: 後から来たロット作成は変更の確定を待ち、新しい単位で拒否される", async () => {
      const productId = await createProduct();

      // T1: 単位を g へ変更（まだコミットしない）。この時点でロットは0件なので通る。
      await first.beginAs(userId);
      expect((await changeUnitToGram(productId)).error).toBeNull();

      // T2: 同じ商品へ tablet のロットを作る。T1 が確定するまで待たされるべき。
      await second.beginAs(userId);
      const lotInsert = insertTabletLot(productId);
      expect(await settleOrBlock(DATABASE, second, lotInsert)).toBe("blocked");

      // T1 を確定させると、T2 は確定後の単位（g）を読み直して拒否される。
      expect((await first.send("commit;")).error).toBeNull();
      const lotResult = await lotInsert;
      await second.send("commit;");

      // 直列化されていないと、ロット作成が古い単位（tablet）のまま通って食い違いが残る。
      expect({ lotError: lotResult.error, mismatches: countUnitMismatches(productId) }).toEqual({
        lotError: expect.stringContaining("must match the supplement product default unit"),
        mismatches: 0,
      });
    }, 60_000);

    it("ロット作成が先: 後から来た単位変更はロットの確定を待ち、ロットがあるので拒否される", async () => {
      const productId = await createProduct();

      // T2: tablet のロットを作る（まだコミットしない）。商品は tablet なので通る。
      await second.beginAs(userId);
      expect((await insertTabletLot(productId)).error).toBeNull();

      // T1: 同じ商品の単位を g へ。T2 が確定するまで待たされるべき。
      await first.beginAs(userId);
      const unitChange = changeUnitToGram(productId);
      expect(await settleOrBlock(DATABASE, first, unitChange)).toBe("blocked");

      // T2 を確定させると、T1 はロットを観測して拒否される。
      expect((await second.send("commit;")).error).toBeNull();
      const unitResult = await unitChange;
      await first.send("commit;");

      expect({ unitError: unitResult.error, mismatches: countUnitMismatches(productId) }).toEqual({
        unitError: expect.stringContaining("default unit while inventory lots exist"),
        mismatches: 0,
      });
    }, 60_000);

    it("ロット作成がガードを抜けた直後に単位変更が割り込んでもデッドロックしない", async () => {
      // 単位変更（UPDATE）は、トリガーより**先に**商品の行ロックを取る。ロット作成が
      // advisory lock だけを持った状態で単位変更が商品行を掴むと、
      //   ロット作成: advisory 保持 → 外部キー検査で商品行（KEY SHARE）を待つ
      //   単位変更  : 商品行 保持 → advisory を待つ
      // と獲得順が逆になり、デッドロック（40P01）になる。ロット側のガードは
      // advisory の前に商品行へ KEY SHARE を取り、獲得順を「商品行 → advisory」に揃える。
      //
      // その隙間を決め打ちで再現するため、ガードの**後**に発火する一時停止用の
      // トリガーをテスト用データベースにだけ足す（トリガーは名前順に発火する）。
      // 管理セッションが握っているロックが外れるまで、ロット作成はガードを抜けた
      // 位置で止まる。
      const PAUSE_KEY = 424242;
      runPsql(
        DATABASE,
        `create or replace function public.test_pause_after_lot_guard()
         returns trigger language plpgsql as $$
         begin
           perform pg_catalog.pg_advisory_xact_lock(${String(PAUSE_KEY)});
           return new;
         end;
         $$;
         create trigger supplement_inventory_lots_zz_test_pause
         before insert on public.supplement_inventory_lots
         for each row execute function public.test_pause_after_lot_guard();`,
      );
      const pause = new PsqlSession(DATABASE, "unit_race_pause");
      try {
        const productId = await createProduct();
        expect((await pause.send("begin;")).error).toBeNull();
        expect(
          (await pause.send(`select pg_advisory_xact_lock(${String(PAUSE_KEY)});`)).error,
        ).toBeNull();

        // T2: ロット作成。ガードを通過し、一時停止用トリガーで止まる。
        await second.beginAs(userId);
        const lotInsert = insertTabletLot(productId);
        expect(await settleOrBlock(DATABASE, second, lotInsert)).toBe("blocked");

        // T1: その隙に同じ商品の単位を変更する。T2 の確定を待つはず。
        await first.beginAs(userId);
        const unitChange = changeUnitToGram(productId);
        expect(await settleOrBlock(DATABASE, first, unitChange)).toBe("blocked");

        // 一時停止を解く。T2 は最後まで進んでコミットでき、T1 はロットを観測して拒否される。
        expect((await pause.send("commit;")).error).toBeNull();
        const lotResult = await lotInsert;
        expect(lotResult.error).toBeNull();
        expect((await second.send("commit;")).error).toBeNull();
        const unitResult = await unitChange;
        expect(unitResult.error).not.toContain("deadlock");
        expect(unitResult.error).toContain("default unit while inventory lots exist");
        await first.send("commit;");

        expect(countUnitMismatches(productId)).toBe(0);
      } finally {
        // 失敗時にロットの表を掴んだまま残らないよう、先に両方を巻き戻してから外す。
        await pause.close();
        await Promise.all([first.send("rollback;"), second.send("rollback;")]);
        runPsql(
          DATABASE,
          `set lock_timeout = '10s';
           drop trigger supplement_inventory_lots_zz_test_pause on public.supplement_inventory_lots;
           drop function public.test_pause_after_lot_guard();`,
        );
      }
    }, 60_000);

    it("直列化されるのは同じ商品どうしだけ（別の商品へのロット作成は待たされない）", async () => {
      const changing = await createProduct();
      const other = await createProduct();

      await first.beginAs(userId);
      expect((await changeUnitToGram(changing)).error).toBeNull();

      await second.beginAs(userId);
      const lotInsert = insertTabletLot(other);
      expect(await settleOrBlock(DATABASE, second, lotInsert)).toBe("finished");
      expect((await lotInsert).error).toBeNull();

      expect((await second.send("commit;")).error).toBeNull();
      expect((await first.send("commit;")).error).toBeNull();
      expect(countUnitMismatches(changing, other)).toBe(0);
    }, 60_000);
  },
);
