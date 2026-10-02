"use client";

import type { SupplementSchedule } from "../schema";
import { mealRelationLabel, scheduleKindLabel, unitLabel } from "../labels";
import styles from "./supplements.module.css";

type ScheduleListProps = {
  schedules: SupplementSchedule[];
  onEdit: (schedule: SupplementSchedule) => void;
  onDelete: (schedule: SupplementSchedule) => void;
  disabled: boolean;
};

function weekdaysLabel(weekdays: number[] | null): string {
  if (!weekdays || weekdays.length === 0) {
    return "—";
  }
  const labels = ["日", "月", "火", "水", "木", "金", "土"];
  return weekdays
    .sort((a, b) => a - b)
    .map((d) => labels[d])
    .join("・");
}

export function ScheduleList({ schedules, onEdit, onDelete, disabled }: ScheduleListProps) {
  if (schedules.length === 0) {
    return <p className={styles.empty}>摂取予定がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">商品</th>
            <th scope="col">種別</th>
            <th scope="col">時刻</th>
            <th scope="col">曜日</th>
            <th scope="col">開始日</th>
            <th scope="col">終了日</th>
            <th scope="col">量</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {schedules.map((schedule) => (
            <tr key={schedule.id} className={schedule.archivedAt !== null ? styles.archived : ""}>
              <td>{schedule.productName}</td>
              <td>{scheduleKindLabel(schedule.scheduleKind)}</td>
              <td>{schedule.timeOfDay ?? "—"}</td>
              <td>{weekdaysLabel(schedule.weekdays)}</td>
              <td>{schedule.startDate}</td>
              <td>{schedule.endDate ?? "—"}</td>
              <td>
                {schedule.amount}
                {unitLabel(schedule.unit)}
                <span className={styles.statusSecondary}>
                  {mealRelationLabel(schedule.mealRelation)}
                </span>
              </td>
              <td>
                <div className={styles.buttonGroup}>
                  <button
                    className={`${styles.button} ${styles.buttonSecondary}`}
                    type="button"
                    onClick={() => onEdit(schedule)}
                    disabled={disabled}
                  >
                    編集
                  </button>
                  <button
                    className={`${styles.button} ${styles.buttonDanger}`}
                    type="button"
                    onClick={() => onDelete(schedule)}
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
