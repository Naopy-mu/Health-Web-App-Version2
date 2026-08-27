/**
 * `/auth` ログイン画面（実装仕様書 4章 / 5.1節）。
 * メール+パスワード、サインアップ、Magic Link、Googleログインの導線を置く。
 */

import Link from "next/link";
import type { Metadata } from "next";

import styles from "@/features/auth/auth.module.css";
import {
  GoogleSignInForm,
  MagicLinkForm,
  SignInForm,
  SignUpForm,
} from "@/features/auth/components";
import { sanitizeNextPath } from "@/features/auth/redirect";
import { isDemoModeEnabled, isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "ログイン | Health Web App",
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

const firstValue = (value: string | string[] | undefined): string | undefined =>
  Array.isArray(value) ? value[0] : value;

export default async function AuthPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams;
  // 実装仕様書 5.1節: 受け取った `next` は必ず検証し、不正なら /auth/session へ丸める。
  const next = sanitizeNextPath(firstValue(params.next));
  const accountServiceAvailable = isSupabaseConfigured();
  const demoAvailable = isDemoModeEnabled();

  return (
    <main className={styles.page} id="main-content">
      <h1>ログイン</h1>

      {accountServiceAvailable ? (
        <>
          <p className={styles.lead}>
            記録をアカウントに保存して、複数の端末から利用できるようにします。
          </p>
          <SignInForm next={next} />
          <MagicLinkForm next={next} />
          <GoogleSignInForm next={next} />
          <SignUpForm next={next} />
          <nav aria-label="認証の補助リンク">
            <ul className={styles.links}>
              <li>
                <Link href="/auth/forgot-password">パスワードをお忘れの場合</Link>
              </li>
              {demoAvailable ? (
                <li>
                  <Link href="/demo">アカウントなしで試す（デモモード）</Link>
                </li>
              ) : null}
            </ul>
          </nav>
        </>
      ) : (
        // 実装仕様書 3.3節: 未設定時はデモモードへの導線を示す。
        <>
          <p className={styles.banner} role="status">
            アカウント機能は現在利用できません（Supabaseが未設定です）。
          </p>
          {demoAvailable ? (
            <p className={styles.lead}>
              資格情報なしで動作する
              <Link href="/demo">デモモード</Link>
              では、ブラウザ内にだけデータを保存してお試しいただけます。
            </p>
          ) : (
            <p className={styles.lead}>
              デモモードも無効化されています。環境設定をご確認ください。
            </p>
          )}
        </>
      )}
    </main>
  );
}
