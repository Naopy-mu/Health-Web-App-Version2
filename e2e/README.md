# e2e

Playwright（Chromium / Mobile Safari）のE2Eシナリオを置く（実装仕様書 12章）。
Phase 0 では配置のみで、シナリオは後続フェーズで追加する。

## 実行の前提条件

1. **production build**
   - `next dev` では React Fast Refresh が CSP の `script-src` に `'unsafe-eval'` を要求し、
     ブラウザコンソールで `EvalError` が発生してクライアントが初期化できない（`docs/known-issues.md` P3b-1）。
   - 必ず **`npm run build`** を実行してから E2E を起動すること。
2. **環境変数**
   - 予め作成済みのテストアカウントを用意し、以下を設定すること。
     - `E2E_TEST_EMAIL`
     - `E2E_TEST_PASSWORD`
   - 未設定の場合、前提チェック用テストが **失敗** し、他のテストは skip される。
     CI 環境では未設定を検知できるよう、この挙動により exit 0 にはならない。
3. **サーバー起動**
   - `playwright.config.ts` の `webServer` 設定により、`npx playwright test` 実行時に
     `node --run start` が自動で起動される。
   - 既存の `localhost:3000` サーバーが動作していれば、ローカルではそれを再利用する。
4. **baseURL**
   - 既定は `http://localhost:3000`（`playwright.config.ts`）。
   - `NEXT_PUBLIC_APP_URL` と一致させないと same-origin 検証で API が 403 になるため、
     ローカルでは `localhost` を使うこと。`127.0.0.1` では same-origin 検証に失敗する場合がある。
   - 必要に応じて `PLAYWRIGHT_BASE_URL` で上書き可能。

## 実行コマンド

```bash
npm run build
npx playwright test
```

## 注意事項

- テストアカウントは複数テストで共有するため、`test.describe.configure({ mode: "serial" })` で
  直列実行している。並列実行するとデータの競合が発生しうる。
- テストデータのクリーンアップは `page.request` を使い、ブラウザコンテキストの Cookie を共有する。
  これにより same-origin 検証を通過し、GET/DELETE の応答を `expect(...).toBeOK()` で検証している。
