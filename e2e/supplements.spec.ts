import { test, expect, type Page } from "@playwright/test";

/**
 * サプリメントページの happy-path / 競合 E2E。
 *
 * 実行には予め作成済みのテストアカウントが必要。
 * ローカル Supabase 等でアカウントを用意し、以下の環境変数を設定してください:
 *   E2E_TEST_EMAIL
 *   E2E_TEST_PASSWORD
 */

const EMAIL = process.env.E2E_TEST_EMAIL ?? "";
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "";
const ORIGIN = process.env.PLAYWRIGHT_BASE_URL ?? "http://localhost:3000";

test("E2E 実行前提（資格情報設定）", () => {
  expect(EMAIL && PASSWORD, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD を設定してください").toBeTruthy();
});

async function signIn(page: Page, next = "/supplements"): Promise<void> {
  await page.goto(`/auth?next=${next}`);
  const signInSection = page.getByRole("region", { name: "メールアドレスでログイン" });
  await signInSection.getByLabel("メールアドレス").fill(EMAIL);
  await signInSection.getByLabel("パスワード").fill(PASSWORD);
  await signInSection.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL((url) => url.pathname === next && url.search === "");
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function cleanupProducts(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    return;
  }
  const response = await page.request.get(
    "/api/supplements?resource=product&order=desc&limit=500",
    {
      headers: { Origin: ORIGIN },
    },
  );
  expect(response, "cleanup GET /api/supplements?resource=product").toBeOK();
  const json = (await response.json()) as {
    data: {
      products: {
        id: string;
        rowVersion: number;
        name: string;
        category: string;
        form: string;
        defaultUnit: string;
        archivedAt: string | null;
      }[];
    };
  };
  for (const product of json.data.products) {
    if (product.archivedAt !== null) {
      continue;
    }
    const archiveResponse = await page.request.post("/api/supplements", {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      data: {
        resource: "product",
        clientMutationId: crypto.randomUUID(),
        product: {
          id: product.id,
          expectedRowVersion: product.rowVersion,
          name: product.name,
          category: product.category,
          form: product.form,
          defaultUnit: product.defaultUnit,
          archived: true,
        },
      },
    });
    expect(archiveResponse, `cleanup archive product ${product.id}`).toBeOK();
  }
}

async function cleanupEntries(page: Page, resource: "schedule" | "lot" | "intake"): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    return;
  }
  const all: { id: string; rowVersion: number }[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ resource, order: "desc", limit: "500" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await page.request.get(`/api/supplements?${params.toString()}`, {
      headers: { Origin: ORIGIN },
    });
    expect(response, `cleanup GET /api/supplements?${params.toString()}`).toBeOK();
    const json = (await response.json()) as {
      data: {
        entries: { id: string; rowVersion: number }[];
        page: { nextCursor: string | null };
      };
    };
    all.push(...json.data.entries);
    cursor = json.data.page.nextCursor ?? undefined;
  } while (cursor);

  for (const entry of all) {
    const deleteResponse = await page.request.delete("/api/supplements", {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      data: { resource, id: entry.id, expectedRowVersion: entry.rowVersion },
    });
    expect(deleteResponse, `cleanup DELETE /api/supplements ${resource} ${entry.id}`).toBeOK();
  }
}

async function cleanupAll(page: Page): Promise<void> {
  await cleanupEntries(page, "intake");
  await cleanupEntries(page, "schedule");
  await cleanupEntries(page, "lot");
  await cleanupProducts(page);
}

test.describe("Supplements happy path", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }
    await signIn(page, "/supplements/products");
    await cleanupAll(page);
  });

  test("商品・摂取予定・在庫を登録し、服用を記録して取消できる", async ({ page }) => {
    const suffix = uniqueSuffix();
    const productKey = `e2e_vitc_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E ビタミンC ${suffix}`;

    // 商品登録
    await page.goto("/supplements/products");
    await expect(page.getByRole("heading", { name: "サプリメント 商品管理" })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    await page.getByLabel("商品名").fill(productName);
    await page.getByLabel("商品キー").fill(productKey);
    await page.getByLabel("既定量（任意）").fill("2");
    await page.getByLabel("単位").selectOption("tablet");
    await page.getByRole("button", { name: "登録する" }).click();
    await expect(page.getByRole("cell", { name: productName, exact: true })).toBeVisible();

    // 摂取予定登録
    await page.goto("/supplements/schedules");
    await expect(page.getByRole("heading", { name: "サプリメント 摂取予定" })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    await page.getByLabel("商品").selectOption({ label: productName });
    await page.getByLabel("時刻").fill("08:00");
    await page.getByLabel("量").fill("2");
    await page.getByLabel("単位").selectOption("tablet");
    await page.getByRole("button", { name: "登録する" }).click();
    const scheduleRow = page.locator("tr").filter({ hasText: productName });
    await expect(scheduleRow.getByText("08:00")).toBeVisible();

    // 在庫ロット登録
    await page.goto("/supplements/inventory");
    await expect(page.getByRole("heading", { name: "サプリメント 在庫" })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    await page.getByLabel("商品").selectOption({ label: productName });
    await page.getByLabel("数量").fill("30");
    await page.getByRole("button", { name: "登録する" }).nth(1).click();
    const lotRow = page.locator("tr").filter({ hasText: productName });
    await expect(lotRow.getByText("30")).toBeVisible();

    // 服用記録
    await page.getByLabel("商品").first().selectOption({ label: productName });
    await page.getByLabel("量").first().fill("2");
    await page.getByLabel("単位").first().selectOption("tablet");
    await page.getByRole("button", { name: "記録する" }).first().click();
    await expect(page.getByText("在庫合計:")).toBeVisible();
    await expect(page.getByText("28錠")).toBeVisible();

    // 取消
    await page.goto("/supplements/history");
    await expect(page.getByRole("heading", { name: "サプリメント 服用履歴" })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    page.on("dialog", (dialog) => dialog.accept("誤って記録"));
    const historyRow = page.locator("tr").filter({ hasText: productName });
    await historyRow.getByRole("button", { name: "取消" }).click();
    await expect(page.getByText("取消済み")).toBeVisible();

    // 後片付け
    await page.goto("/supplements/inventory");
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    page.on("dialog", (dialog) => dialog.accept());
    await lotRow.getByRole("button", { name: "削除" }).click();
    await expect(lotRow).not.toBeVisible();

    await page.goto("/supplements/schedules");
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    page.on("dialog", (dialog) => dialog.accept());
    await scheduleRow.getByRole("button", { name: "削除" }).click();
    await expect(scheduleRow).not.toBeVisible();
  });
});

test.describe("Supplements conflict recovery", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async () => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }
  });

  test("摂取予定の 409 競合後に最新値を取得して再試行できる", async ({ browser }) => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await signIn(pageA, "/supplements/products");
    await signIn(pageB, "/supplements/products");
    await cleanupAll(pageA);
    await cleanupAll(pageB);

    const suffix = uniqueSuffix();
    const productKey = `e2e_conflict_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E 競合 ${suffix}`;

    // 商品作成
    await pageA.goto("/supplements/products");
    await expect(pageA.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    await pageA.getByLabel("商品名").fill(productName);
    await pageA.getByLabel("商品キー").fill(productKey);
    await pageA.getByLabel("単位").selectOption("tablet");
    await pageA.getByRole("button", { name: "登録する" }).click();
    await expect(pageA.getByRole("cell", { name: productName, exact: true })).toBeVisible();

    // 予定作成
    await pageA.goto("/supplements/schedules");
    await expect(pageA.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    await pageA.getByLabel("商品").selectOption({ label: productName });
    await pageA.getByLabel("時刻").fill("08:00");
    await pageA.getByLabel("量").fill("2");
    await pageA.getByRole("button", { name: "登録する" }).click();
    const scheduleRowA = pageA.locator("tr").filter({ hasText: productName });
    await expect(scheduleRowA.getByText("08:00")).toBeVisible();

    await pageB.goto("/supplements/schedules");
    await expect(pageB.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    const scheduleRowB = pageB.locator("tr").filter({ hasText: productName });
    await expect(scheduleRowB.getByText("08:00")).toBeVisible({ timeout: 15000 });

    // 両方で編集モードに入る
    await scheduleRowA.getByRole("button", { name: "編集" }).click();
    await scheduleRowB.getByRole("button", { name: "編集" }).click();
    await expect(pageA.getByRole("heading", { name: "摂取予定を編集" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "摂取予定を編集" })).toBeVisible();

    // pageA で量を変更
    await pageA.getByLabel("量").fill("3");
    await pageA.getByRole("button", { name: "更新する" }).click();
    await expect(scheduleRowA.getByText("3錠")).toBeVisible();

    // pageB では古い rowVersion のまま更新しようとすると 409
    await pageB.getByLabel("量").fill("4");
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(pageB.getByText("他の操作")).toBeVisible({ timeout: 15000 });

    // 最新値を取得して再試行し成功すること
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(scheduleRowB.getByText("4錠")).toBeVisible({ timeout: 15000 });

    // 後片付け
    await pageA.reload();
    await expect(pageA.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    pageA.on("dialog", (dialog) => dialog.accept());
    await pageA
      .locator("tr")
      .filter({ hasText: productName })
      .getByRole("button", { name: "削除" })
      .click();
    await expect(pageA.locator("tr").filter({ hasText: productName })).not.toBeVisible();

    await pageA.close();
    await pageB.close();
  });
});
