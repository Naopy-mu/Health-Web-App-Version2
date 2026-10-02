import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupplementIntake } from "../schema";
import { HistoryPage } from "./history-page";

const INTAKE: SupplementIntake = {
  id: "i1",
  productId: "p1",
  productKey: "vitamin_c",
  productName: "ビタミンC",
  scheduleId: null,
  status: "taken",
  scheduledFor: null,
  recordedAt: "2026-09-15T09:00:00.000+09:00",
  timezone: "Asia/Tokyo",
  amount: 2,
  unit: "tablet",
  consumedQuantity: 2,
  idempotencyKey: "adhoc:p1:2026-09-15T09:00:00.000+09:00",
  voidedAt: null,
  voidReason: null,
  note: null,
  rowVersion: 1,
  clientMutationId: "original-record-key",
  createdAt: "2026-09-15T09:00:00.000+09:00",
  updatedAt: "2026-09-15T09:00:00.000+09:00",
};

const mockLoadMore = vi.fn();
const mockVoidIntake = vi.fn();

vi.mock("../use-supplements", () => ({
  useSupplements: vi.fn(() => ({
    entries: [INTAKE],
    summary: {
      weeklyScheduledCount: 0,
      weeklyTakenCount: 1,
      monthlyTakenCount: 1,
      lowStockProductCount: 0,
      expiringLotCount: 0,
    },
    loadingState: "idle",
    error: null,
    conflict: null,
    nextCursor: null,
    isLoadingMore: false,
    loadMore: mockLoadMore,
    voidIntake: mockVoidIntake,
  })),
}));

describe("HistoryPage", () => {
  beforeAll(() => {
    let count = 0;
    vi.stubGlobal("crypto", {
      randomUUID: () => {
        count += 1;
        return `00000000-0000-4000-8000-${String(count).padStart(12, "0")}`;
      },
    });
    vi.stubGlobal("prompt", () => "誤って記録");
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("取消ボタンを押すと新しい clientMutationId で voidIntake を呼ぶ", async () => {
    mockVoidIntake.mockResolvedValue(true);
    render(<HistoryPage />);

    fireEvent.click(screen.getByRole("button", { name: "取消" }));

    await waitFor(() => expect(mockVoidIntake).toHaveBeenCalledTimes(1));
    const request = mockVoidIntake.mock.calls[0][0] as {
      resource: string;
      clientMutationId: string;
      void: { id: string; expectedRowVersion: number; reason: string | null };
    };
    expect(request.resource).toBe("void_intake");
    expect(request.void.id).toBe(INTAKE.id);
    expect(request.clientMutationId).toBe("00000000-0000-4000-8000-000000000001");
    expect(request.clientMutationId).not.toBe(INTAKE.clientMutationId);
  });
});
