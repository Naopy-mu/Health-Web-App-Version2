/**
 * `/auth/update-password` 新しいパスワードの設定（実装仕様書 4章 / 5.1節）。
 *
 * 再設定リンク（`/auth/confirm?type=recovery`）で回復セッションが確立された
 * 状態で到達する。保護ルートには含めず、セッションの有無はこの画面で案内する
 * （リンク切れのときに `/auth` へ飛ばすとやり直し方が分からなくなるため）。
 */

import Link from "next/link";
import type { Metadata } from "next";

import styles from "@/features/auth/auth.module.css";
import { UpdatePasswordForm } from "@/features/auth/components";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/features/auth/schema";
import { isSupabaseConfigured } from "@/lib/supabase/config";
import { createSupabaseServerClient } from "@/lib/supabase/server";

export const metadata: Metadata = {
  title: "新しいパスワード | Health Web App",
};

/**
 * セッションに依存する画面なので、必ずリクエスト時にレンダリングする。
 * ビルド時に Supabase 未設定だった場合でも静的化させない（実装仕様書 9.2節:
 * 認証情報に依存する応答をキャッシュへ載せない）。
 */
export const dynamic = "force-dynamic";

export default async function UpdatePasswordPage() {
  if (!isSupabaseConfigured()) {
    return (
      <main className={styles.page} id="main-content">
        <h1>新しいパスワード</h1>
        <p className={styles.banner} role="status">
          アカウント機能は現在利用できません（Supabaseが未設定です）。
        </p>
      </main>
    );
  }

  const supabase = await createSupabaseServerClient();
  const { data } = (await supabase?.auth.getUser()) ?? { data: null };
  const hasSession = Boolean(data?.user);

  return (
    <main className={styles.page} id="main-content">
      <h1>新しいパスワード</h1>
      <p className={styles.lead}>
        パスワードは{PASSWORD_MIN_LENGTH}文字以上{PASSWORD_MAX_LENGTH}
        文字以内で設定してください。確認用と一致している必要があります。
      </p>

      {hasSession ? (
        <UpdatePasswordForm />
      ) : (
        <>
          <p className={styles.banner} role="status">
            再設定用リンクの有効期限が切れているか、リンクから開かれていません。
          </p>
          <nav aria-label="認証の補助リンク">
            <ul className={styles.links}>
              <li>
                <Link href="/auth/forgot-password">再設定用リンクを送り直す</Link>
              </li>
              <li>
                <Link href="/auth">ログイン画面へ戻る</Link>
              </li>
            </ul>
          </nav>
        </>
      )}
    </main>
  );
}
