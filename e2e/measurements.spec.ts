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
  await page.getByLabel("メールアドレス").fill(EMAIL);
  await page.getByLabel("パスワード").fill(PASSWORD);
  await page.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL("**/measurements");
}

test.describe("Measurements happy path", () => {
  test.beforeEach(async ({ page }) => {
    await signIn(page);
    await expect(page.getByRole("heading", { name: "身体測定" })).toBeVisible();
  });

  test("記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    // 追加
    await page.getByLabel("値").fill("63");
    await page.getByRole("button", { name: "記録する" }).click();
    await expect(page.getByText("63kg")).toBeVisible();

    // 編集
    const row = page.locator("tr").filter({ hasText: "63kg" });
    await row.getByRole("button", { name: "編集" }).click();
    await expect(page.getByRole("heading", { name: "記録を編集" })).toBeVisible();

    const valueInput = page.getByLabel("値");
    await valueInput.fill("61");
    await page.getByRole("button", { name: "更新する" }).click();
    await expect(page.getByText("61kg")).toBeVisible();
    await expect(page.getByText("63kg")).not.toBeVisible();

    // 削除
    page.on("dialog", (dialog) => dialog.accept());
    const editedRow = page.locator("tr").filter({ hasText: "61kg" });
    await editedRow.getByRole("button", { name: "削除" }).click();
    await expect(page.getByText("61kg")).not.toBeVisible();
  });
});
