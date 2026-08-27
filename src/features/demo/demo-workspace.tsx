"use client";

/**
 * デモモードの作業領域（実装仕様書 3.1節）。
 *
 * このフェーズは**骨格**であり、候補プロフィールの提示・確認保存・JSON出力・
 * ブラウザ内削除までを扱う。編集フォームの本実装（実装仕様書 5.2節の
 * `ProfileWorkspace`）は後続フェーズ。
 *
 * TODO(Phase 3以降): `/onboarding` と共通の `ProfileWorkspace` へ置き換え、
 * 実装仕様書 5.2節の候補項目・検証（年齢1〜130、身長30〜300cm、体重10〜500kg、
 * 周囲径10〜500cm、目標期限、IANAタイムゾーンの実在性、運動可能曜日の重複禁止）を
 * 実装する。
 *
 * Supabase・外部APIへの送信経路をこのツリーへ持ち込まないこと。
 */

import { useCallback, useEffect, useState } from "react";

import styles from "@/features/auth/auth.module.css";

import {
  createDemoCandidateProfile,
  DEMO_PROFILE_LABELS,
  formatDemoProfileValue,
  type DemoCandidateProfile,
  type DemoProfileRecord,
} from "./candidate-profile";
import { clearDemoData, readDemoProfile, saveConfirmedDemoProfile } from "./store";

type LoadState = "loading" | "ready" | "unsupported";

export function DemoWorkspace() {
  const [candidate] = useState<DemoCandidateProfile>(createDemoCandidateProfile);
  const [saved, setSaved] = useState<DemoProfileRecord | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    // `readDemoProfile()` は非同期なので、状態更新は必ずマイクロタスク以降に走る
    // （effect本体での同期的な setState はカスケードレンダーを招く）。
    // IndexedDB が使えない環境ではストア側が null を返すため、ここで判別する。
    void readDemoProfile()
      .then((record) => {
        if (!active) {
          return;
        }
        if (typeof globalThis.indexedDB === "undefined") {
          setLoadState("unsupported");
          return;
        }
        setSaved(record);
        setLoadState("ready");
      })
      .catch(() => {
        if (active) {
          setLoadState("unsupported");
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const handleConfirm = useCallback(async () => {
    const record = await saveConfirmedDemoProfile(candidate);
    setSaved(record);
    setMessage(
      record
        ? "確認した内容をこのブラウザに保存しました。サーバーへは送信していません。"
        : "このブラウザでは保存できませんでした。",
    );
  }, [candidate]);

  const handleClear = useCallback(async () => {
    await clearDemoData();
    setSaved(null);
    setMessage("このブラウザに保存したデモデータを削除しました。");
  }, []);

  const handleExport = useCallback(() => {
    const payload = JSON.stringify(saved ?? { profile: candidate, confirmed: false }, null, 2);
    // Blob URL のみを使い、外部へは送信しない（実装仕様書 3.1節）。
    const url = URL.createObjectURL(new Blob([payload], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "health-web-app-demo-profile.json";
    link.click();
    URL.revokeObjectURL(url);
    setMessage("JSONを書き出しました。");
  }, [candidate, saved]);

  return (
    <>
      {message ? (
        <p className={styles.banner} role="status" aria-live="polite">
          {message}
        </p>
      ) : null}

      {loadState === "unsupported" ? (
        <p className={styles.banner} role="status">
          このブラウザではIndexedDBが使えないため、デモデータを保存できません。
          画面上での確認のみ可能です。
        </p>
      ) : null}

      <section className={styles.card} aria-labelledby="demo-candidate-heading">
        <h2 className={styles.cardTitle} id="demo-candidate-heading">
          架空の候補プロフィール
        </h2>
        <p className={styles.hint}>
          以下は架空の初期候補です。内容を確認して保存すると、このブラウザの
          IndexedDBにのみ保存されます。
        </p>
        <dl className={styles.definitionList}>
          {(Object.keys(DEMO_PROFILE_LABELS) as (keyof DemoCandidateProfile)[]).map((key) => (
            <div key={key} style={{ display: "contents" }}>
              <dt>{DEMO_PROFILE_LABELS[key]}</dt>
              <dd>{formatDemoProfileValue(candidate[key])}</dd>
            </div>
          ))}
        </dl>
        <button
          className={styles.button}
          type="button"
          onClick={() => void handleConfirm()}
          disabled={loadState !== "ready"}
        >
          内容を確認して保存する
        </button>
      </section>

      <section className={styles.card} aria-labelledby="demo-saved-heading">
        <h2 className={styles.cardTitle} id="demo-saved-heading">
          このブラウザの保存内容
        </h2>
        {loadState === "loading" ? (
          <p className={styles.hint}>読み込み中…</p>
        ) : saved ? (
          <p className={styles.hint}>
            最終保存:{" "}
            <time dateTime={saved.updatedAt}>
              {new Date(saved.updatedAt).toLocaleString("ja-JP")}
            </time>
          </p>
        ) : (
          <p className={styles.hint}>まだ保存されていません。</p>
        )}
        <button className={styles.button} type="button" onClick={handleExport}>
          JSONを出力する
        </button>
        <button
          className={styles.button}
          type="button"
          onClick={() => void handleClear()}
          disabled={loadState !== "ready" || !saved}
        >
          ブラウザ内のデータを削除する
        </button>
      </section>
    </>
  );
}
