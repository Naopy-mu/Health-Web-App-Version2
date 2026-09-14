"use client";

import type { BeverageType, HydrationEntry } from "../schema";
import { formatDateTimeJa, formatHydrationAmount } from "../utils";
import styles from "../wellness.module.css";

type HydrationListProps = {
  entries: HydrationEntry[];
  beverageTypes: BeverageType[];
  onEdit: (entry: HydrationEntry) => void;
  onDelete: (entry: HydrationEntry) => void;
  disabled: boolean;
};

function typeName(types: BeverageType[], typeId: string): string {
  return types.find((type) => type.id === typeId)?.displayName ?? typeId.slice(0, 8);
}

export function HydrationList({
  entries,
  beverageTypes,
  onEdit,
  onDelete,
  disabled,
}: HydrationListProps) {
  if (entries.length === 0) {
    return <p className={styles.empty}>水分記録がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">日時</th>
            <th scope="col">飲み物</th>
            <th scope="col">量</th>
            <th scope="col">ml換算</th>
            <th scope="col">カフェイン</th>
            <th scope="col">アルコール</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTimeJa(entry.recordedAt)}</td>
              <td>{typeName(beverageTypes, entry.beverageTypeId)}</td>
              <td>{formatHydrationAmount(entry.amount, entry.unit)}</td>
              <td>{entry.amountMl}ml</td>
              <td>{entry.containsCaffeine ? "はい" : "いいえ"}</td>
              <td>{entry.containsAlcohol ? "はい" : "いいえ"}</td>
              <td>
                <div className={styles.buttonGroup}>
                  <button
                    className={`${styles.button} ${styles.buttonSecondary}`}
                    type="button"
                    onClick={() => onEdit(entry)}
                    disabled={disabled}
                  >
                    編集
                  </button>
                  <button
                    className={`${styles.button} ${styles.buttonDanger}`}
                    type="button"
                    onClick={() => onDelete(entry)}
                    disabled={disabled}
                  >
                    削除
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
