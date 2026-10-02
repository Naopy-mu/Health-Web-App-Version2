import { forwardRef } from "react";

import type { ConflictInfo } from "../use-supplements";
import styles from "../components/supplements.module.css";

export function conflictTitle(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "SUPPLEMENT_DUPLICATE_CONFLICT":
      return "同じ名前・キー・予定・ロットが既に存在します";
    case "SUPPLEMENT_CONFLICT":
      return "他の画面や操作でデータが更新されました";
    default:
      return "エラーが発生しました";
  }
}

export function conflictGuidance(conflict: ConflictInfo): string {
  switch (conflict.code) {
    case "SUPPLEMENT_DUPLICATE_CONFLICT":
      return "一覧から既存の項目を編集するか、識別子を変えて再試行してください。";
    case "SUPPLEMENT_CONFLICT":
      return "最新値を取得しました。内容を確認の上、再度「更新する」を押してください。";
    default:
      return conflict.message;
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
