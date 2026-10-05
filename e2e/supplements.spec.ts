import { test, expect, type Page, type APIResponse } from "@playwright/test";

/**
 * サプリメント機能の E2E。
 *
 * 実行には .env.local の E2E_TEST_EMAIL / E2E_TEST_PASSWORD が必要。
 * ローカル Supabase（http://127.0.0.1:54321）が起動している前提。
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
  await page.waitForURL((url) => url.pathname === next && url.search === "", { timeout: 15000 });
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

async function apiRequest(
  page: Page,
  method: string,
  url: string,
  body?: unknown,
): Promise<APIResponse> {
  const headers: Record<string, string> = { Origin: ORIGIN };
  if (body !== undefined) {
    headers["Content-Type"] = "application/json";
  }
  return page.request.fetch(url, {
    method,
    headers,
    data: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

async function listAll(
  page: Page,
  resource: "schedule" | "lot" | "intake",
): Promise<{ id: string; rowVersion: number; status?: string }[]> {
  const all: { id: string; rowVersion: number; status?: string }[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ resource, order: "desc", limit: "500" });
    if (cursor) params.set("cursor", cursor);
    const response = await apiRequest(page, "GET", `/api/supplements?${params.toString()}`);
    expect(response, `cleanup GET ${resource}`).toBeOK();
    const json = (await response.json()) as {
      data: {
        entries: { id: string; rowVersion: number; status?: string }[];
        page: { nextCursor: string | null };
      };
    };
    all.push(...json.data.entries);
    cursor = json.data.page.nextCursor ?? undefined;
  } while (cursor);
  return all;
}

async function listProducts(page: Page): Promise<
  {
    id: string;
    rowVersion: number;
    name: string;
    brand: string | null;
    category: string;
    form: string;
    defaultAmount: number | null;
    defaultUnit: string;
    amountPerContainer: number | null;
    lowStockThreshold: number | null;
    ingredientNote: string | null;
    safetyNote: string | null;
    url: string | null;
    archivedAt: string | null;
  }[]
> {
  const response = await apiRequest(
    page,
    "GET",
    "/api/supplements?resource=lot&order=desc&limit=500",
  );
  expect(response, "cleanup GET products").toBeOK();
  const json = (await response.json()) as {
    data: {
      products: {
        id: string;
        rowVersion: number;
        name: string;
        brand: string | null;
        category: string;
        form: string;
        defaultAmount: number | null;
        defaultUnit: string;
        amountPerContainer: number | null;
        lowStockThreshold: number | null;
        ingredientNote: string | null;
        safetyNote: string | null;
        url: string | null;
        archivedAt: string | null;
      }[];
    };
  };
  return json.data.products;
}

async function cleanupAll(page: Page): Promise<void> {
  // 服用記録を取消（物理削除はできない）
  const intakes = await listAll(page, "intake");
  for (const intake of intakes) {
    if (intake.status === "voided" || intake.status === "skipped") continue;
    const response = await apiRequest(page, "POST", "/api/supplements", {
      resource: "void_intake",
      clientMutationId: crypto.randomUUID(),
      void: { id: intake.id, expectedRowVersion: intake.rowVersion, reason: "cleanup" },
    });
    expect(response, `cleanup void intake ${intake.id}`).toBeOK();
  }

  // 摂取予定を削除
  const schedules = await listAll(page, "schedule");
  for (const schedule of schedules) {
    const response = await apiRequest(page, "DELETE", "/api/supplements", {
      resource: "schedule",
      id: schedule.id,
      expectedRowVersion: schedule.rowVersion,
    });
    expect(response, `cleanup DELETE schedule ${schedule.id}`).toBeOK();
  }

  // 在庫ロットを削除（服用に使われたものは 409 で残る）
  const lots = await listAll(page, "lot");
  for (const lot of lots) {
    const response = await apiRequest(page, "DELETE", "/api/supplements", {
      resource: "lot",
      id: lot.id,
      expectedRowVersion: lot.rowVersion,
    });
    if (!response.ok()) {
      const body = await response.text().catch(() => "");
      expect(response.status(), `cleanup DELETE lot ${lot.id}: ${body}`).toBe(409);
    }
  }

  // 有効な商品をアーカイブ
  const products = await listProducts(page);
  for (const product of products) {
    if (product.archivedAt !== null) continue;
    const response = await apiRequest(page, "POST", "/api/supplements", {
      resource: "product",
      clientMutationId: crypto.randomUUID(),
      product: {
        id: product.id,
        expectedRowVersion: product.rowVersion,
        name: product.name,
        brand: product.brand,
        category: product.category,
        form: product.form,
        defaultAmount: product.defaultAmount,
        defaultUnit: product.defaultUnit,
        amountPerContainer: product.amountPerContainer,
        lowStockThreshold: product.lowStockThreshold,
        ingredientNote: product.ingredientNote,
        safetyNote: product.safetyNote,
        url: product.url,
        archived: true,
      },
    });
    expect(response, `cleanup archive product ${product.id}`).toBeOK();
  }
}

async function createProduct(
  page: Page,
  options: {
    name: string;
    key: string;
    brand?: string;
    url?: string;
    defaultAmount?: number;
    defaultUnit?: string;
  },
): Promise<void> {
  await page.goto("/supplements/products");
  await expect(page.getByRole("heading", { name: "サプリメント 商品管理" })).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const form = page.getByRole("region", { name: "新規商品" });
  await form.getByLabel("商品名").fill(options.name);
  await form.getByLabel("商品キー").fill(options.key);
  if (options.brand) await form.getByLabel(/ブランド/).fill(options.brand);
  if (options.url) await form.getByLabel(/URL/).fill(options.url);
  if (options.defaultAmount !== undefined) {
    await form.getByLabel("既定量（任意）").fill(String(options.defaultAmount));
  }
  if (options.defaultUnit) {
    await form.getByLabel("単位").selectOption(options.defaultUnit);
  }
  await form.getByRole("button", { name: "登録する" }).click();
  await expect(page.locator("tr").filter({ hasText: options.name })).toBeVisible({
    timeout: 15000,
  });
}

async function createSchedule(
  page: Page,
  productName: string,
  options: { time?: string; amount: number; unit: string; startDate?: string },
): Promise<void> {
  await page.goto("/supplements/schedules");
  await expect(page.getByRole("heading", { name: "サプリメント 摂取予定" })).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const form = page.getByRole("region", { name: "新規摂取予定" });
  await form.getByLabel("商品").selectOption({ label: productName });
  if (options.time) await form.getByLabel("時刻").fill(options.time);
  await form.getByLabel("量").fill(String(options.amount));
  await form.getByLabel("単位").selectOption(options.unit);
  if (options.startDate) await form.getByLabel("開始日").fill(options.startDate);
  await form.getByRole("button", { name: "登録する" }).click();
  const row = page.locator("tr").filter({ hasText: productName });
  await expect(row.getByText(options.time ?? "08:00")).toBeVisible();
}

async function createLot(page: Page, productName: string, quantity: number): Promise<void> {
  await page.goto("/supplements/inventory");
  await expect(page.getByRole("heading", { name: "サプリメント 在庫" })).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const form = page.getByRole("region", { name: "新規在庫ロット" });
  await form.getByLabel("商品").selectOption({ label: productName });
  await form.getByLabel("数量", { exact: true }).fill(String(quantity));
  await form.getByRole("button", { name: "登録する" }).click();
  const row = page.locator("tr").filter({ hasText: productName });
  await expect(row.getByText(new RegExp(`${quantity} / ${quantity}`))).toBeVisible({
    timeout: 15000,
  });
}

async function recordAdhocIntake(
  page: Page,
  productName: string,
  amount: number,
  unit = "tablet",
): Promise<void> {
  await page.goto("/supplements/inventory");
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const form = page.getByRole("region", { name: "新規服用記録" });
  await form.getByLabel("商品").selectOption({ label: productName });
  await form.getByLabel("量", { exact: true }).fill(String(amount));
  await form.getByLabel("単位").selectOption(unit);
  await form.getByRole("button", { name: "記録する" }).click();
}

async function recordScheduledIntake(page: Page, productName: string): Promise<void> {
  await page.goto("/supplements");
  await expect(page.getByRole("heading", { name: "サプリメント" })).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const row = page.getByRole("listitem").filter({ hasText: productName });
  await row.getByRole("button", { name: "記録する" }).click();

  const form = page.getByRole("region", { name: "服用を記録" });
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "記録する" }).click();
  await expect(row.getByText("記録済み")).toBeVisible({ timeout: 15000 });
}

async function voidLatestIntake(page: Page, productName: string): Promise<void> {
  await page.goto("/supplements/history");
  await expect(page.getByRole("heading", { name: "サプリメント 服用履歴" })).toBeVisible();
  await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

  const row = page.locator("tr").filter({ hasText: productName }).first();
  page.once("dialog", (dialog) => dialog.accept("誤って記録"));
  await row.getByRole("button", { name: "取消" }).click();
  await expect(page.getByText("取消済み").first()).toBeVisible({ timeout: 15000 });
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

  test("商品・摂取予定・在庫を登録し、予定から服用を記録して取消できる", async ({ page }) => {
    test.setTimeout(60000);
    const suffix = uniqueSuffix();
    const productKey = `e2e_vitc_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E ビタミンC ${suffix}`;

    await createProduct(page, {
      name: productName,
      key: productKey,
      brand: "E2Eブランド",
      url: "https://example.com/e2e",
      defaultAmount: 2,
      defaultUnit: "tablet",
    });
    await createSchedule(page, productName, { time: "08:00", amount: 2, unit: "tablet" });
    await createLot(page, productName, 30);

    // 在庫不足でないことを確認しつつ、予定から記録
    await recordScheduledIntake(page, productName);

    // サマリー or 在庫で在庫が減っていること
    await page.goto("/supplements/inventory");
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    const lotRow = page.locator("tr").filter({ hasText: productName });
    await expect(lotRow.getByText("28 / 30")).toBeVisible({ timeout: 30000 });

    // 取消
    await voidLatestIntake(page, productName);

    // 取消後は在庫が戻っていること
    await page.goto("/supplements/inventory");
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    await expect(lotRow.getByText("30 / 30")).toBeVisible({ timeout: 30000 });
  });

  test("在庫ページから予定外の服用を記録でき、連続記録は冪等キーが変わる", async ({ page }) => {
    const suffix = uniqueSuffix();
    const productKey = `e2e_adhoc_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E 必要時 ${suffix}`;

    await createProduct(page, {
      name: productName,
      key: productKey,
      defaultAmount: 1,
      defaultUnit: "tablet",
    });
    await createLot(page, productName, 10);

    await recordAdhocIntake(page, productName, 1, "tablet");
    const lotRow = page.locator("tr").filter({ hasText: productName });
    await expect(lotRow.getByText("9 / 10")).toBeVisible({ timeout: 15000 });

    // 同じ値のまま連続で記録 → idempotent_replay 情報表示
    await recordAdhocIntake(page, productName, 1, "tablet");
    await expect(
      page.getByText("同じ記録が既に存在するため、在庫・履歴は追加されていません。"),
    ).toBeVisible();
    await expect(lotRow.getByText("9 / 10")).toBeVisible({ timeout: 15000 });
  });

  test("在庫不足の服用はサーバー側で拒否される", async ({ page }) => {
    const suffix = uniqueSuffix();
    const productKey = `e2e_short_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E 不足 ${suffix}`;

    await createProduct(page, {
      name: productName,
      key: productKey,
      defaultAmount: 1,
      defaultUnit: "tablet",
    });
    await createLot(page, productName, 2);

    const form = page.getByRole("region", { name: "新規服用記録" });
    await form.getByLabel("商品").selectOption({ label: productName });
    await form.getByLabel("量", { exact: true }).fill("5");
    await form.getByLabel("単位").selectOption("tablet");
    await form.getByRole("button", { name: "記録する" }).click();

    await expect(
      form.getByText(
        "在庫が足りないため記録できませんでした。在庫を登録するか、消費量を見直してください。",
      ),
    ).toBeVisible({ timeout: 10000 });
  });

  test("アーカイブ切替でも商品の任意項目が失われない", async ({ page }) => {
    const suffix = uniqueSuffix();
    const productKey = `e2e_archive_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E アーカイブ ${suffix}`;

    await createProduct(page, {
      name: productName,
      key: productKey,
      brand: "E2Eブランド",
      url: "https://example.com/e2e-archive",
      defaultAmount: 3,
      defaultUnit: "capsule",
    });

    const row = page.locator("tr").filter({ hasText: productName });
    await row.getByRole("button", { name: "アーカイブ" }).click();
    await expect(row.getByText("アーカイブ済み")).toBeVisible();

    // アーカイブ解除
    const archivedRow = page.locator("tr").filter({ hasText: productName });
    await archivedRow.getByRole("button", { name: "アーカイブ解除" }).click();

    // 任意項目が残っていることを確認
    await expect(page.getByRole("cell", { name: productName })).toBeVisible();
    await page
      .locator("tr")
      .filter({ hasText: productName })
      .getByRole("button", { name: "編集" })
      .click();
    await expect(page.getByLabel(/ブランド/)).toHaveValue("E2Eブランド");
    await expect(page.getByLabel(/URL/)).toHaveValue("https://example.com/e2e-archive");
  });

  test("服用に使ったロットは削除できない（409）", async ({ page }) => {
    const suffix = uniqueSuffix();
    const productKey = `e2e_lotuse_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E ロット使用 ${suffix}`;

    await createProduct(page, {
      name: productName,
      key: productKey,
      defaultAmount: 1,
      defaultUnit: "tablet",
    });
    await createLot(page, productName, 10);
    await recordAdhocIntake(page, productName, 1, "tablet");

    const row = page.locator("tr").filter({ hasText: productName }).first();
    page.once("dialog", (dialog) => dialog.accept());
    await row.getByRole("button", { name: "削除" }).click();

    await expect(
      page.getByText("このロットは服用の記録に使われているため削除できません").first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(row).toBeVisible();
  });
});

test.describe("Supplements conflict recovery", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }
    await signIn(page, "/supplements/products");
    await cleanupAll(page);
  });

  test("摂取予定の 409 競合後に最新値を取得して再試行できる", async ({ browser }) => {
    test.setTimeout(90000);
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await signIn(pageA, "/supplements/products");
    await signIn(pageB, "/supplements/products");
    await cleanupAll(pageA);
    await cleanupAll(pageB);

    const suffix = uniqueSuffix();
    const productKey = `e2e_conflict_${suffix.replace(/[-]/g, "_")}`;
    const productName = `E2E 競合 ${suffix}`;

    await createProduct(pageA, { name: productName, key: productKey, defaultUnit: "tablet" });
    await createSchedule(pageA, productName, { time: "08:00", amount: 2, unit: "tablet" });

    await pageB.goto("/supplements/schedules");
    await expect(pageB.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    await expect(
      pageB.locator("tr").filter({ hasText: productName }).getByText("08:00"),
    ).toBeVisible({ timeout: 15000 });

    const rowA = pageA.locator("tr").filter({ hasText: productName });
    const rowB = pageB.locator("tr").filter({ hasText: productName });

    await rowA.getByRole("button", { name: "編集" }).click();
    await rowB.getByRole("button", { name: "編集" }).click();
    await expect(pageA.getByRole("heading", { name: "摂取予定を編集" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "摂取予定を編集" })).toBeVisible();

    await pageA.getByLabel("量").fill("3");
    await pageA.getByRole("button", { name: "更新する" }).click();
    await expect(rowA.getByText("3錠")).toBeVisible();

    await pageB.getByLabel("量").fill("4");
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(pageB.getByText("他の画面や操作でデータが更新されました")).toBeVisible({
      timeout: 45000,
    });

    // 最新値を取得して再試行
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(rowB.getByText("4錠")).toBeVisible({ timeout: 45000 });

    await pageA.close();
    await pageB.close();
  });
});
