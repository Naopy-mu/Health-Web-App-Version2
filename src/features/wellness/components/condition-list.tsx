"use client";

import type { ConditionEntry } from "../schema";
import { formatDateTimeJa } from "../utils";
import styles from "../wellness.module.css";

type ConditionListProps = {
  entries: ConditionEntry[];
  onEdit: (entry: ConditionEntry) => void;
  onDelete: (entry: ConditionEntry) => void;
  disabled: boolean;
};

export function ConditionList({ entries, onEdit, onDelete, disabled }: ConditionListProps) {
  if (entries.length === 0) {
    return <p className={styles.empty}>体調記録がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">日時</th>
            <th scope="col">総合</th>
            <th scope="col">疲労</th>
            <th scope="col">活力</th>
            <th scope="col">ストレス</th>
            <th scope="col">痛み</th>
            <th scope="col">気分</th>
            <th scope="col">体温</th>
            <th scope="col">症状</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry.id}>
              <td>{formatDateTimeJa(entry.recordedAt)}</td>
              <td>{entry.overallScore ?? "—"}</td>
              <td>{entry.fatigueScore ?? "—"}</td>
              <td>{entry.energyScore ?? "—"}</td>
              <td>{entry.stressScore ?? "—"}</td>
              <td>{entry.painScore ?? "—"}</td>
              <td>{entry.moodScore ?? "—"}</td>
              <td>{entry.bodyTemperatureC !== null ? `${entry.bodyTemperatureC}℃` : "—"}</td>
              <td>
                {entry.symptoms.length === 0 && entry.freeTextSymptoms.length === 0
                  ? "—"
                  : [
                      ...entry.symptoms.map(
                        (s) => `${s.displayName}${s.severity !== null ? `(${s.severity})` : ""}`,
                      ),
                      ...entry.freeTextSymptoms,
                    ].join(", ")}
              </td>
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
