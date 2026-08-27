/**
 * `/demo` ローカルデモ（実装仕様書 3.1節 / 4章）。
 *
 * > `/demo` で利用でき、Supabase・外部APIの設定なしに動作する。
 * > 有効化フラグ: `NEXT_PUBLIC_DEMO_MODE_ENABLED`。
 *
 * フラグが無効なら 404 とし、到達不能な画面を残さない（実装仕様書 11章）。
 */

import Link from "next/link";
import { notFound } from "next/navigation";
import type { Metadata } from "next";

import styles from "@/features/auth/auth.module.css";
import { DemoWorkspace } from "@/features/demo/demo-workspace";
import { isDemoModeEnabled, isSupabaseConfigured } from "@/lib/supabase/config";

export const metadata: Metadata = {
  title: "デモモード | Health Web App",
};

/**
 * 表示内容が実行時の環境変数（Supabase設定・デモモードの有効化フラグ）に
 * 依存するため、ビルド時の値で静的化させない（実装仕様書 3.1節・3.3節）。
 */
export const dynamic = "force-dynamic";

export default function DemoPage() {
  if (!isDemoModeEnabled()) {
    notFound();
  }

  return (
    <main className={styles.page} id="main-content">
      <h1>デモモード</h1>
      <p className={styles.lead}>
        アカウント登録なしでお試しいただけます。入力した内容は
        <strong>このブラウザの中（IndexedDB）にだけ保存</strong>
        され、サーバーや外部サービスへは一切送信されません。ブラウザのデータを
        消去すると内容も失われます。
      </p>

      <DemoWorkspace />

      {isSupabaseConfigured() ? (
        <nav aria-label="次の操作">
          <ul className={styles.links}>
            <li>
              <Link href="/auth">アカウントを作って記録を保存する</Link>
            </li>
          </ul>
        </nav>
      ) : null}
    </main>
  );
}
