import Link from "next/link";

export default function HomePage() {
  return (
    <main id="main-content">
      <h1>Health Web App</h1>
      <p>Phase 4-2b: サプリメントのフロントエンドを実装しました。</p>
      <nav aria-label="記録画面へのリンク">
        <ul>
          <li>
            <Link href="/measurements">身体測定</Link>
          </li>
          <li>
            <Link href="/sleep">睡眠</Link>
          </li>
          <li>
            <Link href="/hydration">水分</Link>
          </li>
          <li>
            <Link href="/condition">体調</Link>
          </li>
          <li>
            <Link href="/supplements">サプリメント</Link>
          </li>
        </ul>
      </nav>
    </main>
  );
}
