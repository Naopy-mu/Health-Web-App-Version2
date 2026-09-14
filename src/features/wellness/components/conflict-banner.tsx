import { forwardRef } from "react";

import type { ConflictInfo } from "../use-wellness";
import styles from "../wellness.module.css";

export function conflictTitle(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "WELLNESS_DUPLICATE_CONFLICT":
      return "同じ日時の記録が既に存在します";
    case "WELLNESS_GOAL_CONFLICT":
      return "目標が競合しています";
    case "WELLNESS_TYPE_CONFLICT":
      return "種別が競合しています";
    case "WELLNESS_TYPE_ARCHIVED":
      return "アーカイブ済みの種別です";
    case "WELLNESS_TYPE_LIMIT_REACHED":
      return "カスタム種別の上限に達しています";
    case "WELLNESS_CONFLICT":
    default:
      return "他の画面や操作でデータが更新されました";
  }
}

export function conflictGuidance(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "WELLNESS_DUPLICATE_CONFLICT":
      return "日時を変えるか、一覧から既存の記録を編集してください。";
    case "WELLNESS_GOAL_CONFLICT":
      return "既存の目標を更新するか、終了日を入れてから新しい目標を作成してください。";
    case "WELLNESS_TYPE_CONFLICT":
      return "一覧を確認し、他の画面での変更を反映してから再試行してください。";
    case "WELLNESS_TYPE_ARCHIVED":
      return "アーカイブを解除するか、別の種別を選んでください。";
    case "WELLNESS_TYPE_LIMIT_REACHED":
      return "不要なカスタム種別をアーカイブしてから再試行してください。";
    case "WELLNESS_CONFLICT":
    default:
      return "最新値を取得しました。内容を確認の上、再度「更新する」を押してください。";
  }
}

type ConflictBannerProps = {
  conflict: ConflictInfo;
};

export const ConflictBanner = forwardRef<HTMLDivElement, ConflictBannerProps>(
  function ConflictBanner({ conflict }, ref) {
    return (
      <div
        ref={ref}
        className={`${styles.status} ${styles.statusError}`}
        role="alert"
        tabIndex={-1}
        aria-live="polite"
      >
        <p className={styles.sectionTitle}>{conflictTitle(conflict)}</p>
        <p>{conflictGuidance(conflict)}</p>
      </div>
    );
  },
);
