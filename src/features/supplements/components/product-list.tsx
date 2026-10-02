"use client";

import type { SupplementProduct } from "../schema";
import { categoryLabel, formLabel, unitLabel } from "../labels";
import styles from "./supplements.module.css";

type ProductListProps = {
  products: SupplementProduct[];
  productIdsWithLots: Set<string>;
  onEdit: (product: SupplementProduct) => void;
  onArchiveToggle: (product: SupplementProduct, archived: boolean) => void;
  disabled: boolean;
};

export function ProductList({
  products,
  productIdsWithLots,
  onEdit,
  onArchiveToggle,
  disabled,
}: ProductListProps) {
  if (products.length === 0) {
    return <p className={styles.empty}>商品がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">商品名</th>
            <th scope="col">カテゴリ</th>
            <th scope="col">剤形</th>
            <th scope="col">既定量</th>
            <th scope="col">在庫</th>
            <th scope="col">状態</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {products.map((product) => (
            <tr key={product.id} className={product.archivedAt !== null ? styles.archived : ""}>
              <td>
                {product.name}
                {product.brand ? (
                  <span className={styles.statusSecondary}>（{product.brand}）</span>
                ) : null}
              </td>
              <td>{categoryLabel(product.category)}</td>
              <td>{formLabel(product.form)}</td>
              <td>
                {product.defaultAmount !== null
                  ? `${product.defaultAmount}${unitLabel(product.defaultUnit)}`
                  : `— ${unitLabel(product.defaultUnit)}`}
              </td>
              <td>
                {product.stock.remainingTotal}
                {unitLabel(product.defaultUnit)}
                {product.stock.lowStock ? (
                  <span className={`${styles.badge} ${styles.badgeLowStock}`}>低在庫</span>
                ) : null}
              </td>
              <td>
                {product.archivedAt !== null
                  ? "アーカイブ済み"
                  : productIdsWithLots.has(product.id)
                    ? "在庫あり"
                    : "在庫なし"}
              </td>
              <td>
                <div className={styles.buttonGroup}>
                  <button
                    className={`${styles.button} ${styles.buttonSecondary}`}
                    type="button"
                    onClick={() => onEdit(product)}
                    disabled={disabled}
                  >
                    編集
                  </button>
                  <button
                    className={`${styles.button} ${styles.buttonSecondary}`}
                    type="button"
                    onClick={() => onArchiveToggle(product, product.archivedAt === null)}
                    disabled={disabled}
                  >
                    {product.archivedAt !== null ? "アーカイブ解除" : "アーカイブ"}
                  </button>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
