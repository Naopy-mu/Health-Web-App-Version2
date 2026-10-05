import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SupplementProduct } from "../schema";
import { ScheduleForm } from "./schedule-form";

const PRODUCT: SupplementProduct = {
  id: "p1",
  productKey: "vitamin_c",
  name: "ビタミンC",
  nameNormalized: "ビタミンc",
  brand: null,
  category: "vitamin",
  form: "tablet",
  defaultAmount: 2,
  defaultUnit: "tablet",
  amountPerContainer: null,
  lowStockThreshold: null,
  ingredientNote: null,
  safetyNote: null,
  url: null,
  archivedAt: null,
  stock: { remainingTotal: 10, lotCount: 1, nearestExpiresOn: "2027-01-31", lowStock: false },
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("ScheduleForm", () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("商品が1件だけでも、選択操作なしで送信できる", async () => {
    const onSubmit = vi.fn();
    render(
      <ScheduleForm
        products={[PRODUCT]}
        editingSchedule={null}
        onSubmit={onSubmit}
        onCancel={() => {}}
        disabled={false}
        serverError={null}
      />,
    );

    const productSelect = screen.getByLabelText("商品") as HTMLSelectElement;
    await waitFor(() => expect(productSelect.value).toBe(PRODUCT.id));
    expect(screen.getByLabelText("単位")).toHaveValue(PRODUCT.defaultUnit);

    fireEvent.input(screen.getByLabelText("量"), { target: { value: "2" } });
    fireEvent.click(screen.getByRole("button", { name: "登録する" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const args = onSubmit.mock.calls[0][0];
    expect(args.productId).toBe(PRODUCT.id);
    expect(args.unit).toBe(PRODUCT.defaultUnit);
  });
});
