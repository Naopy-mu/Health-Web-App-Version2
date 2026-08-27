/**
 * Supabase クライアント共通の設定読み出し（実装仕様書 2.1節 / 9.2節 / 13.1節）。
 *
 * ここで参照してよいのは `NEXT_PUBLIC_` 付きの公開可能な設定のみ。
 * `SUPABASE_SECRET_KEY` のようなサーバー専用の秘密値は `admin.ts`
 * （`import "server-only"` 済み）でのみ扱い、このモジュールへ持ち込まない。
 *
 * `process.env.X` を**リテラル参照**しているのは、クライアントバンドルでは
 * ビルド時に値が埋め込まれるため（動的キー参照では置換されない）。
 * 値はモジュール初期化時ではなく呼び出し時に読むので、テストからは
 * `vi.stubEnv` で差し替えられる。
 */

export type SupabaseClientConfig = {
  readonly url: string;
  readonly publishableKey: string;
};

const trimmed = (value: string | undefined): string | undefined => {
  const next = value?.trim();
  return next ? next : undefined;
};

/**
 * ブラウザ／サーバー双方のクライアント生成に必要な公開設定を返す。
 * どちらかが欠けていれば `null`（＝Supabase未設定。実装仕様書 3.3節）。
 */
export function getSupabaseClientConfig(): SupabaseClientConfig | null {
  const url = trimmed(process.env.NEXT_PUBLIC_SUPABASE_URL);
  const publishableKey = trimmed(process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY);

  if (!url || !publishableKey) {
    return null;
  }

  return { url, publishableKey };
}

/**
 * 実装仕様書 3.3節: 未設定時、アカウントAPIは 503 を返しUIはデモモードへ誘導する。
 */
export function isSupabaseConfigured(): boolean {
  return getSupabaseClientConfig() !== null;
}

/**
 * 実装仕様書 3.1節: デモモードの有効化フラグ。`"true"` のときのみ有効。
 */
export function isDemoModeEnabled(): boolean {
  return trimmed(process.env.NEXT_PUBLIC_DEMO_MODE_ENABLED) === "true";
}

/**
 * 実装仕様書 13.1節: リダイレクトと絶対リンクの基準URL。未設定なら `null` を返し、
 * 呼び出し側がリクエスト由来のオリジンへフォールバックする。
 */
export function getConfiguredAppUrl(): string | null {
  const raw = trimmed(process.env.NEXT_PUBLIC_APP_URL);
  if (!raw) {
    return null;
  }

  try {
    const url = new URL(raw);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return null;
    }
    return url.origin;
  } catch {
    return null;
  }
}
