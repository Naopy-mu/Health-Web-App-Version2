import { test, expect, type Page } from "@playwright/test";

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

test.describe("Measurements happy path", () => {
  // 同じテストアカウントを共有するため、並列実行はしない
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "身体測定" })).toBeVisible();
  });

  test("記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    // 種別一覧の読み込み完了を待つ（種別がないとフォーム送信できない）
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 15000 });
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
});
