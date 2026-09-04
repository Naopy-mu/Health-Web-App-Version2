"use client";

import { useEffect, useState } from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

import type { HydrationEntry, SleepEntry } from "../schema";
import { formatDateTimeJa } from "../utils";
import styles from "../wellness.module.css";

type WellnessChartProps = {
  entries: (SleepEntry | HydrationEntry)[];
  targetValue?: number;
  targetLabel?: string;
  dataKey: "sleepMinutes" | "amountMl";
  yLabel: string;
  valueFormatter?: (value: number) => string;
};

function getInitialReducedMotion(): boolean {
  if (typeof window === "undefined" || !("matchMedia" in window)) {
    return false;
  }
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(getInitialReducedMotion);
  useEffect(() => {
    if (typeof window === "undefined" || !("matchMedia" in window)) {
      return;
    }
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const handler = (event: MediaQueryListEvent) => setReduced(event.matches);
    media.addEventListener("change", handler);
    return () => media.removeEventListener("change", handler);
  }, []);
  return reduced;
}

export function WellnessChart({
  entries,
  targetValue,
  targetLabel,
  dataKey,
  yLabel,
  valueFormatter,
}: WellnessChartProps) {
  const reducedMotion = usePrefersReducedMotion();
  const sorted = [...entries].sort(
    (a, b) =>
      new Date("sleepAt" in a ? a.sleepAt : a.recordedAt).getTime() -
      new Date("sleepAt" in b ? b.sleepAt : b.recordedAt).getTime(),
  );
  const chartData = sorted.map((entry) => ({
    date: "sleepAt" in entry ? entry.sleepAt : entry.recordedAt,
    value: (entry as unknown as Record<string, number>)[dataKey],
  }));

  return (
    <section className={styles.card} aria-labelledby="chart-heading">
      <h2 className={styles.sectionTitle} id="chart-heading">
        推移グラフ
      </h2>
      {entries.length === 0 ? (
        <p className={styles.empty}>グラフ表示する記録がありません。</p>
      ) : (
        <>
          <div className={styles.chartContainer} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="date"
                  tickFormatter={(value: string) => {
                    const date = new Date(value);
                    return `${date.getMonth() + 1}/${date.getDate()}`;
                  }}
                />
                <YAxis label={{ value: yLabel, angle: -90, position: "insideLeft" }} />
                <Tooltip
                  formatter={(value: unknown) => [
                    valueFormatter ? valueFormatter(value as number) : String(value),
                    yLabel,
                  ]}
                  labelFormatter={(label: unknown) => formatDateTimeJa(String(label))}
                />
                <Line
                  type="monotone"
                  dataKey="value"
                  name={yLabel}
                  stroke="#267a5b"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                  isAnimationActive={!reducedMotion}
                />
                {targetValue !== undefined ? (
                  <ReferenceLine
                    y={targetValue}
                    label={targetLabel ?? "目標"}
                    stroke="#dc2626"
                    strokeDasharray="5 5"
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <caption className={styles.srOnly}>グラフの表形式代替表示</caption>
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  <th scope="col">{yLabel}</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((row) => (
                  <tr key={row.date}>
                    <td>{formatDateTimeJa(row.date)}</td>
                    <td>{valueFormatter ? valueFormatter(row.value) : row.value}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </section>
  );
}
