import { test, expect, type APIRequestContext, type Page } from "@playwright/test";

/**
 * 身体測定ページの happy-path E2E。
 *
 * 実行には予め作成済みのテストアカウントが必要。
 * ローカル Supabase 等でアカウントを用意し、以下の環境変数を設定してください:
 *   E2E_TEST_EMAIL
 *   E2E_TEST_PASSWORD
 * 変数が未設定の場合はテストをスキップします。
 */

const EMAIL = process.env.E2E_TEST_EMAIL ?? "";
const PASSWORD = process.env.E2E_TEST_PASSWORD ?? "";

async function signIn(page: Page): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
  }

  await page.goto("/auth?next=/measurements");
  const signInSection = page.getByRole("region", { name: "メールアドレスでログイン" });
  await signInSection.getByLabel("メールアドレス").fill(EMAIL);
  await signInSection.getByLabel("パスワード").fill(PASSWORD);
  await signInSection.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/measurements");
}

/**
 * テストで作成した測定記録をすべて削除する（SF-6）。
 * ページングで全件取得し、rowVersion を指定して DELETE する。
 */
async function cleanupMeasurements(request: APIRequestContext): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    return;
  }

  const all: { id: string; rowVersion: number }[] = [];
  let cursor: string | undefined;
  do {
    const params = new URLSearchParams({ order: "desc", limit: "500" });
    if (cursor) {
      params.set("cursor", cursor);
    }
    const response = await request.get(`/api/measurements?${params.toString()}`);
    if (!response.ok()) {
      break;
    }
    const json = (await response.json()) as {
      data: {
        measurements: { id: string; rowVersion: number }[];
        page: { nextCursor: string | null };
      };
    };
    all.push(...json.data.measurements);
    cursor = json.data.page.nextCursor ?? undefined;
  } while (cursor);

  for (const measurement of all) {
    await request.delete("/api/measurements", {
      data: {
        measurementId: measurement.id,
        expectedRowVersion: measurement.rowVersion,
      },
    });
  }
}

test.describe("Measurements happy path", () => {
  // 同じテストアカウントを共有するため、並列実行はしない
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "身体測定" })).toBeVisible();
  });

  test.afterEach(async ({ request }) => {
    await cleanupMeasurements(request);
  });

  test("記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    // 種別一覧の読み込み完了を待つ（種別がないとフォーム送信できない）
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });
    await expect(page.getByLabel("測定種別")).toBeEnabled();

    // 他テスト実行の残留データと重複しないよう一意な値・日時を使用する
    const initialValue = String(80 + Math.floor(Math.random() * 19));
    const editedValue = String(60 + Math.floor(Math.random() * 19));
    const measuredAt = new Date(Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 30))
      .toISOString()
      .slice(0, 16);

    // 追加
    await page.getByLabel("日時").fill(measuredAt);
    await page.getByLabel("値").fill(initialValue);
    await page.getByRole("button", { name: "記録する" }).click();
    await expect(page.getByRole("cell", { name: `${initialValue}kg` })).toBeVisible();

    // 編集
    const row = page.locator("tr").filter({ hasText: `${initialValue}kg` });
    await row.getByRole("button", { name: "編集" }).click();
    await expect(page.getByRole("heading", { name: "記録を編集" })).toBeVisible();

    const valueInput = page.getByLabel("値");
    await valueInput.fill(editedValue);
    await page.getByRole("button", { name: "更新する" }).click();
    await expect(page.getByRole("cell", { name: `${editedValue}kg` })).toBeVisible();
    await expect(page.getByRole("cell", { name: `${initialValue}kg` })).not.toBeVisible();

    // 削除
    page.on("dialog", (dialog) => dialog.accept());
    const editedRow = page.locator("tr").filter({ hasText: `${editedValue}kg` });
    await editedRow.getByRole("button", { name: "削除" }).click();
    await expect(page.getByRole("cell", { name: `${editedValue}kg` })).not.toBeVisible();
  });

  test("409 競合後に最新値を取得して再試行できる", async ({ browser }) => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }

    // 2 つのタブで同じアカウントにログイン
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await signIn(pageA);
    await signIn(pageB);

    await expect(pageA.getByRole("heading", { name: "身体測定" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "身体測定" })).toBeVisible();

    // 読み込み完了を待つ
    await expect(pageA.getByText("読み込み中…")).toBeHidden({ timeout: 15000 });
    await expect(pageB.getByText("読み込み中…")).toBeHidden({ timeout: 15000 });

    // 一意な値・日時
    const initialValue = String(50 + Math.floor(Math.random() * 19));
    const valueA = String(60 + Math.floor(Math.random() * 19));
    const valueB = String(70 + Math.floor(Math.random() * 19));
    const measuredAt = new Date(Date.now() - Math.floor(Math.random() * 1000 * 60 * 60 * 24 * 30))
      .toISOString()
      .slice(0, 16);

    // pageA で記録を追加
    await pageA.getByLabel("日時").fill(measuredAt);
    await pageA.getByLabel("値").fill(initialValue);
    await pageA.getByRole("button", { name: "記録する" }).click();
    await expect(pageA.getByRole("cell", { name: `${initialValue}kg` })).toBeVisible();

    // pageB でも同じ行が表示されるまで待つ（別タブでは自動更新されないためリロード）
    await pageB.reload();
    await expect(pageB.getByRole("cell", { name: `${initialValue}kg` })).toBeVisible({
      timeout: 15000,
    });

    // 両方で編集モードに入る
    await pageA
      .locator("tr")
      .filter({ hasText: `${initialValue}kg` })
      .getByRole("button", { name: "編集" })
      .click();
    await pageB
      .locator("tr")
      .filter({ hasText: `${initialValue}kg` })
      .getByRole("button", { name: "編集" })
      .click();
    await expect(pageA.getByRole("heading", { name: "記録を編集" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "記録を編集" })).toBeVisible();

    // pageA で更新（rowVersion が進む）
    await pageA.getByLabel("値").fill(valueA);
    await pageA.getByRole("button", { name: "更新する" }).click();
    await expect(pageA.getByRole("cell", { name: `${valueA}kg` })).toBeVisible();

    // pageB では古い rowVersion のまま更新しようとすると 409
    await pageB.getByLabel("値").fill(valueB);
    await pageB.getByRole("button", { name: "更新する" }).click();

    // 競合バナーが表示され、再試行で成功すること（C1/C2）
    await expect(pageB.getByText("他の画面や操作でデータが更新されました")).toBeVisible({
      timeout: 15000,
    });
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(pageB.getByRole("cell", { name: `${valueB}kg` })).toBeVisible({ timeout: 15000 });

    // 後片付け（pageB の更新後は pageA も最新状態にリロードしてから削除）
    await pageA.reload();
    await expect(pageA.getByRole("cell", { name: `${valueB}kg` })).toBeVisible({ timeout: 15000 });
    pageA.on("dialog", (dialog) => dialog.accept());
    const deleteResponsePromise = pageA.waitForResponse(
      (response) =>
        response.url().includes("/api/measurements") && response.request().method() === "DELETE",
    );
    await pageA
      .locator("tr")
      .filter({ hasText: `${valueB}kg` })
      .getByRole("button", { name: "削除" })
      .click();
    await deleteResponsePromise;
    await expect(pageA.getByRole("cell", { name: `${valueB}kg` })).not.toBeVisible({
      timeout: 15000,
    });

    await pageA.close();
    await pageB.close();
  });
});
