/**
 * `/auth/forgot-password` パスワード再設定要求（実装仕様書 4章 / 5.1節）。
 */

import Link from "next/link";
import type { Metadata } from "next";

import styles from "@/features/auth/auth.module.css";
import { ForgotPasswordForm } from "@/features/auth/components";
import { isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "パスワード再設定 | Health Web App",
};

/**
 * 表示内容が実行時の環境変数（Supabase設定・デモモードの有効化フラグ）に
 * 依存するため、ビルド時の値で静的化させない（実装仕様書 3.1節・3.3節）。
 */
export const dynamic = "force-dynamic";

export default function ForgotPasswordPage() {
  return (
    <main className={styles.page} id="main-content">
      <h1>パスワード再設定</h1>
      <p className={styles.lead}>
        登録済みのメールアドレスへ再設定用のリンクを送ります。リンクを開くと
        新しいパスワードを設定できます。
      </p>

      {isSupabaseConfigured() ? (
        <ForgotPasswordForm />
      ) : (
        <p className={styles.banner} role="status">
          アカウント機能は現在利用できません（Supabaseが未設定です）。
        </p>
      )}

      <nav aria-label="認証の補助リンク">
        <ul className={styles.links}>
          <li>
            <Link href="/auth">ログイン画面へ戻る</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
