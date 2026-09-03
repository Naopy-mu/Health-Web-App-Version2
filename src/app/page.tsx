import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content">
      <h1>Health Web App</h1>
      <p>Phase 0: プロジェクト初期化・共通基盤のみ。画面と機能は後続フェーズで実装する。</p>
      <p>
        <Link href="/measurements">身体測定</Link>
      </p>
    </main>
  );
}
