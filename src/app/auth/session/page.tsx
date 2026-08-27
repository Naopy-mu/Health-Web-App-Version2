/**
 * `/auth/session` セッション画面（実装仕様書 4章 / 5.1節）。
 * ログイン後の着地点。セッションの確認とログアウトを行う。
 *
 * 保護ルート（実装仕様書 3.3節）なので、未認証のアクセスは
 * ミドルウェア（`src/lib/supabase/proxy.ts`）が `/auth` へ丸める。
 * ここでの再確認は多層防御であり、ミドルウェアだけに頼らない。
 */

import Link from "next/link";
import { redirect } from "next/navigation";
import type { Metadata } from "next";

import styles from "@/features/auth/auth.module.css";
import { SignOutForm } from "@/features/auth/components";
import { buildSignInPath, DEFAULT_AUTH_REDIRECT_PATH } from "@/features/auth/redirect";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "セッション | Health Web App",
};

/**
 * セッションに依存する画面なので、必ずリクエスト時にレンダリングする。
 * ビルド時に Supabase 未設定だった場合でも静的化させない（実装仕様書 9.2節:
 * 認証情報に依存する応答をキャッシュへ載せない）。
 */
export const dynamic = "force-dynamic";

export default async function AuthSessionPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className={styles.page} id="main-content">
        <h1>セッション</h1>
        <p className={styles.banner} role="status">
          アカウント機能は現在利用できません（Supabaseが未設定です）。
        </p>
      </main>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data } = (await supabase?.auth.getUser()) ?? { data: null };
  const user = data?.user;

  if (!user) {
    redirect(buildSignInPath(DEFAULT_AUTH_REDIRECT_PATH));
  }

  return (
    <main className={styles.page} id="main-content">
      <h1>セッション</h1>
      <p className={styles.lead}>ログインしています。</p>

      <section className={styles.card} aria-labelledby="session-detail-heading">
        <h2 className={styles.cardTitle} id="session-detail-heading">
          現在のセッション
        </h2>
        {/* 実装仕様書 9.2節: トークン・秘密値は画面へ出さない。識別に必要な最小限のみ。 */}
        <dl className={styles.definitionList}>
          <dt>メールアドレス</dt>
          <dd>{user.email ?? "（未設定）"}</dd>
          <dt>認証方法</dt>
          <dd>{user.app_metadata?.provider ?? "不明"}</dd>
          <dt>最終ログイン</dt>
          <dd>
            {user.last_sign_in_at ? (
              <time dateTime={user.last_sign_in_at}>
                {new Date(user.last_sign_in_at).toISOString()}
              </time>
            ) : (
              "不明"
            )}
          </dd>
        </dl>
        <SignOutForm />
      </section>

      <nav aria-label="次の操作">
        <ul className={styles.links}>
          <li>
            <Link href="/">ホームへ</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
