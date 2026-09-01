"use client";

import type { Measurement, MeasurementType } from "../schema";
import { formatValue, toDateTimeLocalValue } from "../utils";
import styles from "../measurements.module.css";

type RecordListProps = {
  measurements: Measurement[];
  types: MeasurementType[];
  onEdit: (measurement: Measurement) => void;
  onDelete: (measurement: Measurement) => void;
  disabled: boolean;
};

function typeLabel(types: MeasurementType[], typeId: string): string {
  return types.find((type) => type.id === typeId)?.displayName ?? typeId;
}

export function RecordList({ measurements, types, onEdit, onDelete, disabled }: RecordListProps) {
  if (measurements.length === 0) {
    return <p className={styles.empty}>該当する測定記録がありません。</p>;
  }

  return (
    <div className={styles.tableWrapper}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th scope="col">日時</th>
            <th scope="col">種別</th>
            <th scope="col">値</th>
            <th scope="col">正規化値</th>
            <th scope="col">測定条件</th>
            <th scope="col">測定部位</th>
            <th scope="col">操作</th>
          </tr>
        </thead>
        <tbody>
          {measurements.map((measurement) => (
            <tr key={measurement.id}>
              <td>{toDateTimeLocalValue(new Date(measurement.measuredAt))}</td>
              <td>{typeLabel(types, measurement.typeId)}</td>
              <td>{formatValue(measurement.value, measurement.unit)}</td>
              <td>
                {measurement.normalizedValue !== null && measurement.normalizedUnit !== null
                  ? `${measurement.normalizedValue} ${measurement.normalizedUnit}`
                  : "—"}
              </td>
              <td>{measurement.measurementCondition ?? "—"}</td>
              <td>{measurement.bodySite ?? "—"}</td>
              <td>
                <div className={styles.buttonGroup}>
                  <button
                    className={`${styles.button} ${styles.buttonSecondary}`}
                    type="button"
                    onClick={() => onEdit(measurement)}
                    disabled={disabled}
                  >
                    編集
                  </button>
                  <button
                    className={`${styles.button} ${styles.buttonDanger}`}
                    type="button"
                    onClick={() => onDelete(measurement)}
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
