/**
 * Vitest 専用の `server-only` スタブ（実装仕様書 2.1節末尾）。
 *
 * 本番ビルドでは `import "server-only";` を宣言したモジュールがクライアント
 * コンポーネントから参照された時点でビルドエラーになる。Vitest は Next.js の
 * バンドラーを通らず `server-only` の解決に失敗するため、`vitest.config.ts` の
 * alias でこのファイルへ差し替える。副作用も公開APIも持たせないこと。
 */
export {};
