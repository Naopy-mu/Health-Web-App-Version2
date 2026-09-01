import type { ConflictInfo } from "../use-measurements";
import styles from "../measurements.module.css";

export function conflictTitle(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "MEASUREMENT_DUPLICATE_CONFLICT":
      return "同じ日時の記録が既に存在します";
    case "MEASUREMENT_GOAL_CONFLICT":
      return "同じ種別に未達成の目標が既に存在します";
    case "MEASUREMENT_TYPE_CONFLICT":
      return "種別が競合しています";
    case "MEASUREMENT_CONFLICT":
    default:
      return "他の画面や操作でデータが更新されました";
  }
}

export function conflictGuidance(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "MEASUREMENT_DUPLICATE_CONFLICT":
      return "日時を変えるか、一覧から既存の記録を編集してください。";
    case "MEASUREMENT_GOAL_CONFLICT":
      return "既存の目標を更新するか、達成済みにしてから新しい目標を作成してください。";
    case "MEASUREMENT_TYPE_CONFLICT":
      return "一覧を確認し、他の画面での変更を反映してから再試行してください。";
    case "MEASUREMENT_CONFLICT":
    default:
      return "最新値を取得しました。内容を確認の上、再度「更新する」を押してください。";
  }
}

type ConflictBannerProps = {
  conflict: ConflictInfo;
};

export function ConflictBanner({ conflict }: ConflictBannerProps) {
  return (
    <div
      className={`${styles.status} ${styles.statusError}`}
      role="alert"
      tabIndex={-1}
      aria-live="polite"
    >
      <p className={styles.sectionTitle}>{conflictTitle(conflict)}</p>
      <p>{conflictGuidance(conflict)}</p>
    </div>
  );
}
