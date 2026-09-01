/**
 * 下部固定ナビゲーション（実装仕様書 4章 / 11章）。
 *
 * Phase 2 までに MobileNavigation が無かったため、簡易な実装を用意する。
 */

"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

import styles from "./mobile-navigation.module.css";

const NAV_ITEMS = [
  { href: "/assistant", label: "AI", shortLabel: "AI" },
  { href: "/", label: "ホーム", shortLabel: "ホーム" },
  { href: "/calendar", label: "カレンダー", shortLabel: "カレ" },
  { href: "/records", label: "記録", shortLabel: "記録" },
  { href: "/meals", label: "食事", shortLabel: "食事" },
  { href: "/reports", label: "レポート", shortLabel: "レポ" },
  { href: "/settings/account", label: "その他", shortLabel: "他" },
];

export function MobileNavigation() {
  const pathname = usePathname();

  return (
    <nav className={styles.nav} aria-label="メインナビゲーション">
      <ul className={styles.list}>
        {NAV_ITEMS.map((item) => {
          const isCurrent = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <li key={item.href} className={styles.item}>
              <Link
                href={item.href}
                className={styles.link}
                aria-current={isCurrent ? "page" : undefined}
                aria-label={item.label}
              >
                <span aria-hidden="true">{item.shortLabel}</span>
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
