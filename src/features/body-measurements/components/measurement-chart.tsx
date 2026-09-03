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

import type { Measurement, MeasurementGoal, MeasurementType } from "../schema";
import { normalizeMeasurement } from "../units";
import { formatUnitLabel, movingAverage, toDateTimeLocalValue } from "../utils";
import styles from "../measurements.module.css";

type MeasurementChartProps = {
  measurements: Measurement[];
  selectedType: MeasurementType | undefined;
  goals: MeasurementGoal[];
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

export function MeasurementChart({ measurements, selectedType, goals }: MeasurementChartProps) {
  const chartData = movingAverage(measurements, 7);
  const reducedMotion = usePrefersReducedMotion();
  const goal = selectedType
    ? goals.find((g) => g.typeId === selectedType.id && g.achievedAt === null)
    : undefined;
  const goalNormalized = goal
    ? normalizeMeasurement(goal.targetValue, goal.unit)?.value
    : undefined;

  const unitLabel = selectedType ? formatUnitLabel(selectedType.defaultUnit) : "";

  return (
    <section className={styles.card} aria-labelledby="chart-heading">
      <h2 className={styles.sectionTitle} id="chart-heading">
        {selectedType ? `${selectedType.displayName}の推移` : "推移グラフ"}
      </h2>

      {measurements.length === 0 ? (
        <p className={styles.empty}>グラフ表示する記録がありません。</p>
      ) : (
        <>
          <div className={styles.chartContainer} aria-hidden="true">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 8, right: 16, bottom: 8, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis
                  dataKey="measuredAt"
                  tickFormatter={(value: string) => {
                    const date = new Date(value);
                    return `${date.getMonth() + 1}/${date.getDate()}`;
                  }}
                />
                <YAxis
                  label={
                    unitLabel ? { value: unitLabel, angle: -90, position: "insideLeft" } : undefined
                  }
                />
                <Tooltip />
                <Line
                  type="monotone"
                  dataKey="value"
                  name="測定値"
                  stroke="#267a5b"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 5 }}
                  isAnimationActive={!reducedMotion}
                />
                <Line
                  type="monotone"
                  dataKey="average"
                  name="直近7件平均"
                  stroke="#2563eb"
                  strokeWidth={2}
                  dot={false}
                  connectNulls
                  isAnimationActive={!reducedMotion}
                />
                {goal && goalNormalized !== undefined ? (
                  <ReferenceLine
                    y={goalNormalized}
                    label={`目標 ${goal.targetValue}${formatUnitLabel(goal.unit)}`}
                    stroke="#dc2626"
                    strokeDasharray="5 5"
                  />
                ) : null}
              </LineChart>
            </ResponsiveContainer>
          </div>

          <div className={styles.tableWrapper}>
            <table className={styles.table}>
              <caption className="sr-only">グラフの表形式代替表示</caption>
              <thead>
                <tr>
                  <th scope="col">日時</th>
                  <th scope="col">測定値</th>
                  <th scope="col">直近7件平均</th>
                </tr>
              </thead>
              <tbody>
                {chartData.map((row) => (
                  <tr key={row.measuredAt}>
                    <td>{toDateTimeLocalValue(new Date(row.measuredAt))}</td>
                    <td>{row.value}</td>
                    <td>{row.average?.toFixed(2) ?? "—"}</td>
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
