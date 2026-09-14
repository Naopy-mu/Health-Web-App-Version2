import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { SleepEntry } from "../schema";
import { SleepForm } from "./sleep-form";

beforeAll(() => {
  vi.stubGlobal(
    "confirm",
    vi.fn(() => true),
  );
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

function pad(n: number) {
  return String(n).padStart(2, "0");
}

function fmt(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function withTimezone(tz: string, fn: () => void) {
  const original = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = tz;
  });
  afterAll(() => {
    process.env.TZ = original;
  });
  fn();
}

describe("SleepForm", () => {
  it("就床≦入眠＜起床≦離床の順序違反をクライアント側で検証する", async () => {
    const onSubmit = vi.fn();
    render(
      <SleepForm
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const base = new Date("2026-09-01T20:00:00");
    fireEvent.change(screen.getByLabelText("就床") as HTMLInputElement, {
      target: { value: fmt(base) },
    });
    fireEvent.change(screen.getByLabelText("入眠") as HTMLInputElement, {
      target: { value: fmt(new Date(base.getTime() - 60 * 60 * 1000)) },
    });
    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() =>
      expect(
        screen.getByText("就床≦入眠＜起床≦離床の順序で入力してください。"),
      ).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("24時間超の睡眠スパンを拒否する", async () => {
    const onSubmit = vi.fn();
    render(
      <SleepForm
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const bed = new Date("2026-09-01T22:00:00");
    const sleep = new Date("2026-09-01T23:00:00");
    const wake = new Date("2026-09-02T23:30:00");
    const out = new Date("2026-09-03T00:00:00");

    fireEvent.change(screen.getByLabelText("就床") as HTMLInputElement, {
      target: { value: fmt(bed) },
    });
    fireEvent.change(screen.getByLabelText("入眠") as HTMLInputElement, {
      target: { value: fmt(sleep) },
    });
    fireEvent.change(screen.getByLabelText("起床") as HTMLInputElement, {
      target: { value: fmt(wake) },
    });
    fireEvent.change(screen.getByLabelText("離床") as HTMLInputElement, {
      target: { value: fmt(out) },
    });

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() =>
      expect(screen.getByText("就床から離床までが24時間を超えています。")).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("覚醒時間が睡眠時間以上を拒否する", async () => {
    const onSubmit = vi.fn();
    render(
      <SleepForm
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const bed = new Date("2026-09-01T22:30:00");
    const sleep = new Date("2026-09-01T23:00:00");
    const wake = new Date("2026-09-02T06:30:00");
    const out = new Date("2026-09-02T06:45:00");

    fireEvent.change(screen.getByLabelText("就床") as HTMLInputElement, {
      target: { value: fmt(bed) },
    });
    fireEvent.change(screen.getByLabelText("入眠") as HTMLInputElement, {
      target: { value: fmt(sleep) },
    });
    fireEvent.change(screen.getByLabelText("起床") as HTMLInputElement, {
      target: { value: fmt(wake) },
    });
    fireEvent.change(screen.getByLabelText("離床") as HTMLInputElement, {
      target: { value: fmt(out) },
    });
    fireEvent.change(screen.getByLabelText("覚醒時間（分）") as HTMLInputElement, {
      target: { value: "500" },
    });

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() =>
      expect(screen.getByText("覚醒時間が睡眠時間以上になっています。")).toBeInTheDocument(),
    );
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("正しい入力で onSubmit が呼ばれる", async () => {
    const onSubmit = vi.fn();
    render(
      <SleepForm
        editingEntry={null}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const bed = new Date("2026-09-01T22:30:00");
    const sleep = new Date("2026-09-01T23:00:00");
    const wake = new Date("2026-09-02T06:30:00");
    const out = new Date("2026-09-02T06:45:00");

    fireEvent.change(screen.getByLabelText("就床") as HTMLInputElement, {
      target: { value: fmt(bed) },
    });
    fireEvent.change(screen.getByLabelText("入眠") as HTMLInputElement, {
      target: { value: fmt(sleep) },
    });
    fireEvent.change(screen.getByLabelText("起床") as HTMLInputElement, {
      target: { value: fmt(wake) },
    });
    fireEvent.change(screen.getByLabelText("離床") as HTMLInputElement, {
      target: { value: fmt(out) },
    });
    fireEvent.change(screen.getByLabelText("睡眠の質（1〜5）") as HTMLInputElement, {
      target: { value: "4" },
    });

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalled());
    const submitted = onSubmit.mock.calls[0][0] as SleepEntry;
    expect(submitted.quality).toBe(4);
    expect(submitted.sleepKind).toBe("night");
  });

  describe("タイムゾーン往復変換（UTC ブラウザー）", () => {
    withTimezone("UTC", () => {
      it("Asia/Tokyo の記録を編集しても絶対時刻がずれない", async () => {
        const onSubmit = vi.fn();
        const entry: SleepEntry = {
          id: "11111111-1111-1111-1111-111111111111",
          sleepKind: "night",
          bedAt: "2026-09-01T22:30:00+09:00",
          sleepAt: "2026-09-01T23:00:00+09:00",
          wakeAt: "2026-09-02T06:30:00+09:00",
          outOfBedAt: "2026-09-02T06:45:00+09:00",
          timezone: "Asia/Tokyo",
          awakeningsCount: 0,
          awakeMinutes: 0,
          quality: null,
          morningFeeling: null,
          note: null,
          sleepMinutes: 450,
          timeInBedMinutes: 495,
          rowVersion: 1,
          clientMutationId: null,
          createdAt: "2026-09-01T23:00:00+09:00",
          updatedAt: "2026-09-02T06:45:00+09:00",
        };

        render(
          <SleepForm
            editingEntry={entry}
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            disabled={false}
            serverError={null}
          />,
        );

        expect((screen.getByLabelText("就床") as HTMLInputElement).value).toBe("2026-09-01T22:30");
        expect((screen.getByLabelText("入眠") as HTMLInputElement).value).toBe("2026-09-01T23:00");
        expect((screen.getByLabelText("起床") as HTMLInputElement).value).toBe("2026-09-02T06:30");
        expect((screen.getByLabelText("離床") as HTMLInputElement).value).toBe("2026-09-02T06:45");

        fireEvent.click(screen.getByRole("button", { name: "更新する" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        const submitted = onSubmit.mock.calls[0][0] as SleepEntry;
        expect(new Date(submitted.bedAt).toISOString()).toBe(new Date(entry.bedAt).toISOString());
        expect(new Date(submitted.sleepAt).toISOString()).toBe(
          new Date(entry.sleepAt).toISOString(),
        );
        expect(new Date(submitted.wakeAt).toISOString()).toBe(new Date(entry.wakeAt).toISOString());
        expect(new Date(submitted.outOfBedAt).toISOString()).toBe(
          new Date(entry.outOfBedAt).toISOString(),
        );
      });

      it("America/New_York の記録を編集しても絶対時刻がずれない", async () => {
        const onSubmit = vi.fn();
        const entry: SleepEntry = {
          id: "11111111-1111-1111-1111-111111111111",
          sleepKind: "night",
          bedAt: "2026-01-15T22:30:00-05:00",
          sleepAt: "2026-01-15T23:00:00-05:00",
          wakeAt: "2026-01-16T06:30:00-05:00",
          outOfBedAt: "2026-01-16T06:45:00-05:00",
          timezone: "America/New_York",
          awakeningsCount: 0,
          awakeMinutes: 0,
          quality: null,
          morningFeeling: null,
          note: null,
          sleepMinutes: 450,
          timeInBedMinutes: 495,
          rowVersion: 1,
          clientMutationId: null,
          createdAt: "2026-01-15T23:00:00-05:00",
          updatedAt: "2026-01-16T06:45:00-05:00",
        };

        render(
          <SleepForm
            editingEntry={entry}
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            disabled={false}
            serverError={null}
          />,
        );

        expect((screen.getByLabelText("就床") as HTMLInputElement).value).toBe("2026-01-15T22:30");
        expect((screen.getByLabelText("入眠") as HTMLInputElement).value).toBe("2026-01-15T23:00");
        expect((screen.getByLabelText("起床") as HTMLInputElement).value).toBe("2026-01-16T06:30");
        expect((screen.getByLabelText("離床") as HTMLInputElement).value).toBe("2026-01-16T06:45");

        fireEvent.click(screen.getByRole("button", { name: "更新する" }));

        await waitFor(() => expect(onSubmit).toHaveBeenCalled());
        const submitted = onSubmit.mock.calls[0][0] as SleepEntry;
        expect(new Date(submitted.bedAt).toISOString()).toBe(new Date(entry.bedAt).toISOString());
        expect(new Date(submitted.sleepAt).toISOString()).toBe(
          new Date(entry.sleepAt).toISOString(),
        );
        expect(new Date(submitted.wakeAt).toISOString()).toBe(new Date(entry.wakeAt).toISOString());
        expect(new Date(submitted.outOfBedAt).toISOString()).toBe(
          new Date(entry.outOfBedAt).toISOString(),
        );
      });

      it("無効なタイムゾーンの検証エラーを表示する", async () => {
        const onSubmit = vi.fn();
        render(
          <SleepForm
            editingEntry={null}
            onSubmit={onSubmit}
            onCancel={vi.fn()}
            disabled={false}
            serverError={null}
          />,
        );

        const timezoneInput = screen.getByLabelText("タイムゾーン") as HTMLInputElement;
        fireEvent.change(timezoneInput, { target: { value: "Not/A/Zone" } });
        fireEvent.click(screen.getByRole("button", { name: "記録する" }));

        await waitFor(() =>
          expect(
            screen.getByText("タイムゾーンは IANA 名（例: Asia/Tokyo）で指定してください。"),
          ).toBeInTheDocument(),
        );
        expect(timezoneInput).toHaveAttribute("aria-invalid", "true");
        expect(onSubmit).not.toHaveBeenCalled();
      });
    });
  });
});
