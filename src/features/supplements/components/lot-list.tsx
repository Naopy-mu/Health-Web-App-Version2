"use client";

import type { SupplementLot } from "../schema";
import { isExpiringSoon, sortLotsByFefo } from "../units";
import { unitLabel } from "../labels";
import { toDateInputValue } from "../utils";
import styles from "./supplements.module.css";

type LotListProps = {
  lots: SupplementLot[];
  onEdit: (lot: SupplementLot) => void;
  onDelete: (lot: SupplementLot) => void;
  disabled: boolean;
};

export function LotList({ lots, onEdit, onDelete, disabled }: LotListProps) {
  const sorted = sortLotsByFefo(lots);
  const today = toDateInputValue(new Date());

  if (sorted.length === 0) {
    return <p className={styles.empty}>在庫ロットがありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">商品</th>
            <th scope="col">ロット名</th>
            <th scope="col">残量 / 数量</th>
            <th scope="col">使用期限</th>
            <th scope="col">購入日</th>
            <th scope="col">開封日</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((lot) => {
            const expiring = isExpiringSoon(
              { remainingQuantity: lot.remainingQuantity, expiresOn: lot.expiresOn },
              today,
            );
            return (
              <tr key={lot.id}>
                <td>{lot.productName}</td>
                <td>{lot.lotCode ?? "—"}</td>
                <td>
                  {lot.remainingQuantity} / {lot.quantity}
                  {unitLabel(lot.unit)}
                </td>
                <td>
                  {lot.expiresOn ?? "—"}
                  {expiring ? (
                    <span className={`${styles.badge} ${styles.badgeExpiring}`}>期限接近</span>
                  ) : null}
                </td>
                <td>{lot.purchasedOn ?? "—"}</td>
                <td>{lot.openedOn ?? "—"}</td>
                <td>
                  <div className={styles.buttonGroup}>
                    <button
                      className={`${styles.button} ${styles.buttonSecondary}`}
                      type="button"
                      onClick={() => onEdit(lot)}
                      disabled={disabled}
                    >
                      編集
                    </button>
                    <button
                      className={`${styles.button} ${styles.buttonDanger}`}
                      type="button"
                      onClick={() => onDelete(lot)}
                      disabled={disabled}
                    >
                      削除
                    </button>
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
