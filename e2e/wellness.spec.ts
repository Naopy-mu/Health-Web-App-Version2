import { test, expect, type Page } from "@playwright/test";

/**
 * 睡眠・水分・体調ページの happy-path / 競合 E2E。
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

async function signIn(page: Page, next = "/sleep"): Promise<void> {
  await page.goto(`/auth?next=${next}`);
  const signInSection = page.getByRole("region", { name: "メールアドレスでログイン" });
  await signInSection.getByLabel("メールアドレス").fill(EMAIL);
  await signInSection.getByLabel("パスワード").fill(PASSWORD);
  await signInSection.getByRole("button", { name: "ログイン" }).click();
  await page.waitForURL((url) => url.pathname === next && url.search === "");
}

type WellnessResource = "sleep" | "hydration" | "condition";

async function cleanupEntries(page: Page, resource: WellnessResource): Promise<void> {
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
    const response = await page.request.get(`/api/wellness?${params.toString()}`, {
      headers: { Origin: ORIGIN },
    });
    if (!response.ok()) {
      break;
    }
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
    const response = await page.request.delete("/api/wellness", {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      data: { resource, id: entry.id, expectedRowVersion: entry.rowVersion },
    });
    // 削除済みや競合は無視する
    if (!response.ok()) {
      const body = await response.json().catch(() => ({}));
      console.warn(`cleanup ${resource} ${entry.id}:`, body);
    }
  }
}

async function cleanupAll(page: Page): Promise<void> {
  await cleanupEntries(page, "sleep");
  await cleanupEntries(page, "hydration");
  await cleanupEntries(page, "condition");
  await cleanupGoals(page, "sleep_goal");
  await cleanupGoals(page, "hydration_goal");
}

async function cleanupGoals(page: Page, resource: "sleep_goal" | "hydration_goal"): Promise<void> {
  if (!EMAIL || !PASSWORD) {
    return;
  }
  const listResource = resource === "sleep_goal" ? "sleep" : "hydration";
  const response = await page.request.get(
    `/api/wellness?resource=${listResource}&order=desc&limit=500`,
    { headers: { Origin: ORIGIN } },
  );
  if (!response.ok()) {
    return;
  }
  const json = (await response.json()) as {
    data: {
      sleepGoals: { id: string; rowVersion: number }[];
      hydrationGoals: { id: string; rowVersion: number }[];
    };
  };
  const goals = resource === "sleep_goal" ? json.data.sleepGoals : json.data.hydrationGoals;
  for (const goal of goals) {
    const deleteResponse = await page.request.delete("/api/wellness", {
      headers: { Origin: ORIGIN, "Content-Type": "application/json" },
      data: { resource, id: goal.id, expectedRowVersion: goal.rowVersion },
    });
    if (!deleteResponse.ok()) {
      const body = await deleteResponse.json().catch(() => ({}));
      console.warn(`cleanup ${resource} ${goal.id}:`, body);
    }
  }
}

function uniqueSuffix() {
  return `${Date.now()}-${Math.floor(Math.random() * 10000)}`;
}

function toDateTimeLocalInput(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

test.describe("Wellness happy path", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async ({ page }) => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }
    await signIn(page, "/sleep");
    await cleanupAll(page);
  });

  test("睡眠記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    await page.goto("/sleep");
    await expect(page.getByRole("heading", { name: "睡眠", exact: true })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    const sleepAt = new Date(Date.now() - 1000 * 60 * 60 * 2);
    const bedAt = new Date(sleepAt.getTime() - 1000 * 60 * 30);
    const wakeAt = new Date(sleepAt.getTime() + 1000 * 60 * 60 * 7);
    const outOfBedAt = new Date(wakeAt.getTime() + 1000 * 60 * 15);

    // 追加
    await page.getByLabel("就床").fill(toDateTimeLocalInput(bedAt));
    await page.getByLabel("入眠").fill(toDateTimeLocalInput(sleepAt));
    await page.getByLabel("起床", { exact: true }).fill(toDateTimeLocalInput(wakeAt));
    await page.getByLabel("離床").fill(toDateTimeLocalInput(outOfBedAt));
    await page.getByLabel("睡眠の質（1〜5）").fill("4");
    await page.getByRole("button", { name: "記録する" }).click();
    await expect(page.getByText("4 / —")).toBeVisible();

    // 編集
    const row = page.locator("tr").filter({ hasText: "4 / —" });
    await row.getByRole("button", { name: "編集" }).click();
    await expect(page.getByRole("heading", { name: "睡眠記録を編集" })).toBeVisible();
    await page.getByLabel("睡眠の質（1〜5）").fill("5");
    await page.getByRole("button", { name: "更新する" }).click();
    await expect(page.getByText("5 / —")).toBeVisible();

    // 削除
    page.on("dialog", (dialog) => dialog.accept());
    const editedRow = page.locator("tr").filter({ hasText: "5 / —" });
    await editedRow.getByRole("button", { name: "削除" }).click();
    await expect(page.getByText("5 / —")).not.toBeVisible();
  });

  test("水分記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    await page.goto("/hydration");
    await expect(page.getByRole("heading", { name: "水分", exact: true })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    const recordedAt = new Date(Date.now() - 1000 * 60 * 60 * 3);

    await page.getByLabel("量").fill("250");
    await page.getByLabel("日時").fill(toDateTimeLocalInput(recordedAt));
    await page.getByRole("button", { name: "記録する" }).click();
    const listRegion = page.getByRole("region", { name: "水分記録一覧" });
    await expect(listRegion.getByRole("cell", { name: "250ml", exact: true })).toBeVisible();

    const row = listRegion.locator("tr").filter({ hasText: "250ml" });
    await row.getByRole("button", { name: "編集" }).click();
    await expect(page.getByRole("heading", { name: "水分記録を編集" })).toBeVisible();
    await page.getByLabel("量").fill("500");
    await page.getByRole("button", { name: "更新する" }).click();
    await expect(listRegion.getByRole("cell", { name: "500ml", exact: true })).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    const editedRow = listRegion.locator("tr").filter({ hasText: "500ml" });
    await editedRow.getByRole("button", { name: "削除" }).click();
    await expect(listRegion.getByRole("cell", { name: "500ml", exact: true })).not.toBeVisible();
  });

  test("水分目標を作成・削除できる", async ({ page }) => {
    await page.goto("/hydration");
    await expect(page.getByRole("heading", { name: "水分", exact: true })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    await page.getByRole("tab", { name: "目標" }).click();
    await expect(page.getByRole("heading", { name: "新規目標" })).toBeVisible();

    const startDate = new Date().toISOString().slice(0, 10);
    await page.getByLabel("目標量（ml）").fill("1800");
    await page.getByLabel("開始日").fill(startDate);
    await page.getByRole("button", { name: "目標を設定する" }).click();
    const goalList = page.getByRole("region", { name: "目標一覧" });
    await expect(goalList.getByRole("cell", { name: "1800ml", exact: true })).toBeVisible();

    const goalRow = goalList.locator("tr").filter({ hasText: "1800ml" });
    await goalRow.getByRole("button", { name: "削除" }).click();
    await expect(goalList.getByRole("cell", { name: "1800ml", exact: true })).not.toBeVisible();
  });

  test("飲み物種別を作成・アーカイブ・解除できる", async ({ page }) => {
    await page.goto("/hydration");
    await expect(page.getByRole("heading", { name: "水分", exact: true })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    await page.getByRole("tab", { name: "飲み物種別" }).click();
    await expect(page.getByRole("heading", { name: "カスタム飲み物種別を追加" })).toBeVisible();

    const suffix = uniqueSuffix();
    const key = `custom_bev_${suffix.replace(/[-]/g, "_")}`;
    const displayName = `カスタム飲み物${suffix}`;

    await page.getByLabel("項目キー").fill(key);
    await page.getByLabel("表示名").fill(displayName);
    await page.getByLabel("既定単位").selectOption("ml");
    await page.getByRole("button", { name: "追加する" }).click();
    await expect(page.getByText(displayName)).toBeVisible();

    // アーカイブ
    const activeList = page.getByRole("region", { name: "飲み物種別一覧" });
    const row = activeList.locator("tr").filter({ hasText: displayName });
    await row.getByRole("button", { name: "アーカイブ" }).click();
    await expect(page.getByRole("heading", { name: "アーカイブ済み飲み物種別" })).toBeVisible();
    const archivedList = page.getByRole("region", { name: "アーカイブ済み飲み物種別" });
    await expect(archivedList.getByRole("cell", { name: displayName, exact: true })).toBeVisible();

    // 解除
    const archivedRow = archivedList.locator("tr").filter({ hasText: displayName });
    await archivedRow.getByRole("button", { name: "解除" }).click();
    await expect(activeList.getByRole("cell", { name: displayName, exact: true })).toBeVisible();
  });

  test("体調記録を追加・一覧表示・編集・削除できる", async ({ page }) => {
    await page.goto("/condition");
    await expect(page.getByRole("heading", { name: "体調", exact: true })).toBeVisible();
    await expect(page.getByText("読み込み中…")).toBeHidden({ timeout: 45000 });

    const suffix = uniqueSuffix();
    const recordedAt = new Date(Date.now() - 1000 * 60 * 60 * 4);
    const symptomText = `のどの痛み, 鼻水-${suffix}`;

    await page.getByLabel("日時").fill(toDateTimeLocalInput(recordedAt));
    await page.getByRole("spinbutton", { name: "総合" }).fill("7");
    await page.getByRole("spinbutton", { name: "疲労" }).fill("3");
    await page.getByRole("spinbutton", { name: "活力" }).fill("8");
    await page.getByRole("spinbutton", { name: "ストレス" }).fill("2");
    await page.getByRole("spinbutton", { name: "痛み" }).fill("1");
    await page.getByRole("spinbutton", { name: "気分" }).fill("8");
    await page.getByLabel("体温（℃）").fill("36.5");
    await page.getByLabel("自由記述症状（カンマ区切り、10件まで）").fill(symptomText);
    await page.getByRole("button", { name: "記録する" }).click();
    await expect(page.getByText(symptomText)).toBeVisible();

    const row = page.locator("tr").filter({ hasText: symptomText });
    await row.getByRole("button", { name: "編集" }).click();
    await expect(page.getByRole("heading", { name: "体調記録を編集" })).toBeVisible();
    await page.getByLabel("総合").fill("8");
    await page.getByRole("button", { name: "更新する" }).click();
    await expect(page.getByText(symptomText)).toBeVisible();

    page.on("dialog", (dialog) => dialog.accept());
    const editedRow = page.locator("tr").filter({ hasText: symptomText });
    await editedRow.getByRole("button", { name: "削除" }).click();
    await expect(page.getByText(symptomText)).not.toBeVisible();
  });
});

test.describe("Wellness conflict recovery", () => {
  test.describe.configure({ mode: "serial" });

  test.beforeEach(async () => {
    if (!EMAIL || !PASSWORD) {
      test.skip(true, "E2E_TEST_EMAIL / E2E_TEST_PASSWORD が未設定です");
    }
  });

  test("睡眠記録の 409 競合後に最新値を取得して再試行できる", async ({ browser }) => {
    const pageA = await browser.newPage();
    const pageB = await browser.newPage();
    await signIn(pageA, "/sleep");
    await signIn(pageB, "/sleep");

    await cleanupEntries(pageA, "sleep");
    await cleanupEntries(pageB, "sleep");

    await expect(pageA.getByRole("heading", { name: "睡眠", exact: true })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "睡眠", exact: true })).toBeVisible();

    await expect(pageA.getByText("読み込み中…")).toBeHidden({ timeout: 15000 });
    await expect(pageB.getByText("読み込み中…")).toBeHidden({ timeout: 15000 });

    const sleepAt = new Date(Date.now() - 1000 * 60 * 60 * 5);
    const bedAt = new Date(sleepAt.getTime() - 1000 * 60 * 30);
    const wakeAt = new Date(sleepAt.getTime() + 1000 * 60 * 60 * 7);
    const outOfBedAt = new Date(wakeAt.getTime() + 1000 * 60 * 15);

    // pageA で追加
    await pageA.getByLabel("就床").fill(toDateTimeLocalInput(bedAt));
    await pageA.getByLabel("入眠").fill(toDateTimeLocalInput(sleepAt));
    await pageA.getByLabel("起床", { exact: true }).fill(toDateTimeLocalInput(wakeAt));
    await pageA.getByLabel("離床").fill(toDateTimeLocalInput(outOfBedAt));
    await pageA.getByLabel("睡眠の質（1〜5）").fill("4");
    await pageA.getByRole("button", { name: "記録する" }).click();
    await expect(pageA.getByText("4 / —")).toBeVisible();

    // pageB でも表示されるまで待つ
    await pageB.reload();
    await expect(pageB.getByText("4 / —")).toBeVisible({ timeout: 15000 });

    // 両方で編集モードに入る
    await pageA
      .locator("tr")
      .filter({ hasText: "4 / —" })
      .getByRole("button", { name: "編集" })
      .click();
    await pageB
      .locator("tr")
      .filter({ hasText: "4 / —" })
      .getByRole("button", { name: "編集" })
      .click();
    await expect(pageA.getByRole("heading", { name: "睡眠記録を編集" })).toBeVisible();
    await expect(pageB.getByRole("heading", { name: "睡眠記録を編集" })).toBeVisible();

    // pageA で更新
    await pageA.getByLabel("睡眠の質（1〜5）").fill("5");
    await pageA.getByRole("button", { name: "更新する" }).click();
    await expect(pageA.getByText("5 / —")).toBeVisible();

    // pageB では古い rowVersion のまま更新しようとすると 409
    await pageB.getByLabel("睡眠の質（1〜5）").fill("3");
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(pageB.getByText("他の画面や操作でデータが更新されました")).toBeVisible({
      timeout: 15000,
    });
    await pageB.getByRole("button", { name: "更新する" }).click();
    await expect(pageB.getByText("3 / —")).toBeVisible({ timeout: 15000 });

    // 後片付け
    await pageA.reload();
    await expect(pageA.getByText("3 / —")).toBeVisible({ timeout: 15000 });
    pageA.on("dialog", (dialog) => dialog.accept());
    await pageA
      .locator("tr")
      .filter({ hasText: "3 / —" })
      .getByRole("button", { name: "削除" })
      .click();
    await expect(pageA.getByText("3 / —")).not.toBeVisible();

    await pageA.close();
    await pageB.close();
  });
});
