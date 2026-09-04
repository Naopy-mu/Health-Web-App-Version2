"use client";

import type { SleepEntry } from "../schema";
import {
  calculateSleepEfficiency,
  calculateSleepMinutes,
  calculateTimeInBedMinutes,
} from "../units";
import { formatDateTimeJa, formatMinutes, sleepKindLabel } from "../utils";
import styles from "../wellness.module.css";

type SleepListProps = {
  entries: SleepEntry[];
  onEdit: (entry: SleepEntry) => void;
  onDelete: (entry: SleepEntry) => void;
  disabled: boolean;
};

export function SleepList({ entries, onEdit, onDelete, disabled }: SleepListProps) {
  if (entries.length === 0) {
    return <p className={styles.empty}>睡眠記録がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">日時</th>
            <th scope="col">種別</th>
            <th scope="col">睡眠時間</th>
            <th scope="col">就床〜離床</th>
            <th scope="col">効率</th>
            <th scope="col">質／感覚</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => {
            const sleepMinutes =
              calculateSleepMinutes(entry.sleepAt, entry.wakeAt, entry.awakeMinutes) ??
              entry.sleepMinutes;
            const timeInBed =
              calculateTimeInBedMinutes(entry.bedAt, entry.outOfBedAt) ?? entry.timeInBedMinutes;
            const efficiency = calculateSleepEfficiency(sleepMinutes, timeInBed);
            return (
              <tr key={entry.id}>
                <td>{formatDateTimeJa(entry.sleepAt)}</td>
                <td>{sleepKindLabel(entry.sleepKind)}</td>
                <td>{formatMinutes(sleepMinutes)}</td>
                <td>{formatMinutes(timeInBed)}</td>
                <td>{efficiency !== null ? `${efficiency}%` : "—"}</td>
                <td>
                  {entry.quality ?? "—"} / {entry.morningFeeling ?? "—"}
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
