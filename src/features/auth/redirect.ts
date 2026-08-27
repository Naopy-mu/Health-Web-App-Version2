/**
 * ログイン後の遷移先 `next` の検証（実装仕様書 5.1節、オープンリダイレクト対策）。
 *
 * > ログイン後の遷移先 `next` は**アプリ内の相対パスのみ許可**し、`//`、
 * > バックスラッシュ、NUL、外部オリジンを含む値は既定の `/auth/session` へ丸める。
 *
 * 「丸める」＝ 拒否してエラーにするのではなく、常に安全な既定値を返す。
 * 呼び出し側が戻り値をそのまま `Location` に載せても外部へ飛ばない、という
 * 一点だけを保証する関数にしてある。
 */

/** 実装仕様書 4章: ログイン後の着地点。 */
export const DEFAULT_AUTH_REDIRECT_PATH = "/auth/session";

/** ログイン画面（未認証時のリダイレクト先）。 */
export const SIGN_IN_PATH = "/auth";

/** `next` として受け付ける最大長。異常に長い値は組み立てミスか攻撃とみなす。 */
const MAX_NEXT_PATH_LENGTH = 1024;

/**
 * 制御文字（NUL・タブ・改行を含む C0 と DEL）。
 * ブラウザやプロキシがこれらを剥がして解釈を変えることがあるため一律で拒否する。
 */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/** 形式検査の基準にする、実在しないオリジン。 */
const VALIDATION_BASE_ORIGIN = "https://health-web-app.invalid";

/**
 * パーセントエンコードを1段だけ解いた文字列を返す。壊れたエスケープは `null`。
 * `/%2f%2fevil.example` のように、デコード後に `//` へ化ける値を弾くために使う。
 */
const decodeOnce = (value: string): string | null => {
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
};

const hasForbiddenShape = (value: string): boolean =>
  value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTERS.test(value);

/**
 * `value` がアプリ内の相対パスとして安全なときのみ `true`。
 */
export function isSafeNextPath(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }

  if (value.length === 0 || value.length > MAX_NEXT_PATH_LENGTH) {
    return false;
  }

  // 先頭が `/` でなければ、絶対URL（`https://evil.example`）・スキーム
  // （`javascript:`）・相対パス（`../`）のいずれかであり、いずれも許可しない。
  if (!value.startsWith("/")) {
    return false;
  }

  if (hasForbiddenShape(value)) {
    return false;
  }

  const decoded = decodeOnce(value);
  if (decoded === null || hasForbiddenShape(decoded)) {
    return false;
  }

  // 最終確認。任意のベースURLへ解決してもオリジンが変わらないことを確かめる。
  // ここまでの形式検査を通り抜ける実装差があっても、この比較で外部オリジンは落ちる。
  try {
    const resolved = new URL(value, VALIDATION_BASE_ORIGIN);
    return resolved.origin === VALIDATION_BASE_ORIGIN;
  } catch {
    return false;
  }
}

/**
 * 安全なアプリ内パスを返す。危険・不正な値は `/auth/session` へ丸める。
 */
export function sanitizeNextPath(value: unknown): string {
  return isSafeNextPath(value) ? value : DEFAULT_AUTH_REDIRECT_PATH;
}

/**
 * `/auth?next=<検証済みパス>` を組み立てる（未認証時のリダイレクト先）。
 * `next` は必ず `sanitizeNextPath` を通してから載せる。
 */
export function buildSignInPath(next: unknown): string {
  const params = new URLSearchParams({ next: sanitizeNextPath(next) });
  return `${SIGN_IN_PATH}?${params.toString()}`;
}
