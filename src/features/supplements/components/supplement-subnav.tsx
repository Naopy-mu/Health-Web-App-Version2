"use client";

import Link from "next/link";

import styles from "./supplements.module.css";

const LINKS = [
  { href: "/supplements", label: "概要" },
  { href: "/supplements/products", label: "商品" },
  { href: "/supplements/schedules", label: "予定" },
  { href: "/supplements/inventory", label: "在庫" },
  { href: "/supplements/history", label: "履歴" },
] as const;

type SupplementSubnavProps = {
  current: (typeof LINKS)[number]["href"];
};

export function SupplementSubnav({ current }: SupplementSubnavProps) {
  return (
    <nav className={styles.subnav} aria-label="サプリメント画面">
      {LINKS.map((link) => (
        <Link
          key={link.href}
          href={link.href}
          className={styles.subnavLink}
          aria-current={current === link.href ? "page" : undefined}
        >
          {link.label}
        </Link>
      ))}
    </nav>
  );
}
