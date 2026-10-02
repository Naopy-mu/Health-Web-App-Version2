"use client";

import type { SupplementIntake } from "../schema";
import { unitLabel } from "../labels";
import { formatDateTimeJa } from "../utils";
import styles from "./supplements.module.css";

type IntakeListProps = {
  intakes: SupplementIntake[];
  onVoid: (intake: SupplementIntake) => void;
  disabled: boolean;
};

function statusLabel(status: SupplementIntake["status"]): string {
  switch (status) {
    case "taken":
      return "服用";
    case "skipped":
      return "スキップ";
    case "as_needed":
      return "必要時";
    case "voided":
      return "取消済み";
    default:
      return status;
  }
}

export function IntakeList({ intakes, onVoid, disabled }: IntakeListProps) {
  if (intakes.length === 0) {
    return <p className={styles.empty}>服用履歴がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">記録日時</th>
            <th scope="col">商品</th>
            <th scope="col">状態</th>
            <th scope="col">量</th>
            <th scope="col">在庫消費量</th>
            <th scope="col">予定</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {intakes.map((intake) => (
            <tr key={intake.id} className={intake.status === "voided" ? styles.archived : ""}>
              <td>{formatDateTimeJa(intake.recordedAt)}</td>
              <td>{intake.productName}</td>
              <td>{statusLabel(intake.status)}</td>
              <td>
                {intake.amount}
                {unitLabel(intake.unit)}
              </td>
              <td>
                {intake.consumedQuantity}
                {unitLabel(intake.unit)}
              </td>
              <td>{intake.scheduledFor ? formatDateTimeJa(intake.scheduledFor) : "予定外"}</td>
              <td>
                {intake.status !== "voided" ? (
                  <div className={styles.buttonGroup}>
                    <button
                      className={`${styles.button} ${styles.buttonDanger}`}
                      type="button"
                      onClick={() => onVoid(intake)}
                      disabled={disabled}
                    >
                      取消
                    </button>
                  </div>
                ) : (
                  <span className={styles.statusSecondary}>{intake.voidReason ?? "取消済み"}</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
