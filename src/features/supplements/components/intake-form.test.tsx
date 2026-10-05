import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupplementLot, SupplementProduct } from "../schema";
import { IntakeForm } from "./intake-form";

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
  stock: { remainingTotal: 10, lotCount: 2, nearestExpiresOn: "2027-01-31", lowStock: false },
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

const LOTS: SupplementLot[] = [
  {
    id: "l1",
    productId: "p1",
    productKey: "vitamin_c",
    productName: "ビタミンC",
    lotCode: "L-001",
    quantity: 5,
    remainingQuantity: 5,
    unit: "tablet",
    purchasedOn: "2026-08-01",
    openedOn: "2026-08-10",
    expiresOn: "2026-12-31",
    note: null,
    rowVersion: 1,
    clientMutationId: null,
    createdAt: "2026-08-01T00:00:00.000Z",
    updatedAt: "2026-08-10T00:00:00.000Z",
  },
  {
    id: "l2",
    productId: "p1",
    productKey: "vitamin_c",
    productName: "ビタミンC",
    lotCode: "L-002",
    quantity: 10,
    remainingQuantity: 10,
    unit: "tablet",
    purchasedOn: "2026-08-15",
    openedOn: null,
    expiresOn: "2027-06-30",
    note: null,
    rowVersion: 1,
    clientMutationId: null,
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
  },
];

describe("IntakeForm", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "0ed6f568-e1cd-42c5-889e-358a00748f21" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("FEFO 見積もりを表示する", async () => {
    const onSubmit = vi.fn();
    render(
      <IntakeForm
        products={[PRODUCT]}
        lots={LOTS}
        onSubmit={onSubmit}
        disabled={false}
        serverError={null}
      />,
    );

    await waitFor(() => expect(screen.getByText("FEFO 消費見積もり")).toBeInTheDocument());
    expect(screen.getByText("L-001: 2錠")).toBeInTheDocument();
  });

  it("在庫不足時に在庫追加を促す表示を出す", async () => {
    const onSubmit = vi.fn();
    render(
      <IntakeForm
        products={[PRODUCT]}
        lots={LOTS}
        onSubmit={onSubmit}
        disabled={false}
        serverError={null}
      />,
    );

    const amountInput = screen.getByLabelText("量");
    fireEvent.input(amountInput, { target: { value: "20" } });

    await waitFor(() => expect(screen.getByText("在庫が不足しています")).toBeInTheDocument());
    expect(screen.getByText(/あと 5/)).toBeInTheDocument();
  });

  it("単位が既定単位と異なる場合は在庫消費量の明示を求める", async () => {
    const onSubmit = vi.fn();
    render(
      <IntakeForm
        products={[PRODUCT]}
        lots={LOTS}
        onSubmit={onSubmit}
        disabled={false}
        serverError={null}
      />,
    );

    const unitSelect = screen.getByLabelText("単位");
    fireEvent.change(unitSelect, { target: { value: "mg" } });

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(screen.getByText(/単位が商品の既定単位/)).toBeInTheDocument());
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("商品が1件だけでも、選択操作なしで送信できる", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <IntakeForm
        products={[PRODUCT]}
        lots={LOTS}
        onSubmit={onSubmit}
        disabled={false}
        serverError={null}
      />,
    );

    const productSelect = screen.getByLabelText("商品") as HTMLSelectElement;
    await waitFor(() => expect(productSelect.value).toBe(PRODUCT.id));

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const args = onSubmit.mock.calls[0][0];
    expect(args.productId).toBe(PRODUCT.id);
    expect(args.unit).toBe(PRODUCT.defaultUnit);
    expect(args.amount).toBe(PRODUCT.defaultAmount);
    expect(args.idempotencyKey).toMatch(/^adhoc:/);
  });

  it("連続して記録すると冪等キーが変わる", async () => {
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    render(
      <IntakeForm
        products={[PRODUCT]}
        lots={LOTS}
        onSubmit={onSubmit}
        disabled={false}
        serverError={null}
      />,
    );

    await waitFor(() =>
      expect((screen.getByLabelText("商品") as HTMLSelectElement).value).toBe(PRODUCT.id),
    );

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(1));
    const firstKey = onSubmit.mock.calls[0][0].idempotencyKey;

    fireEvent.click(screen.getByRole("button", { name: "記録する" }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
    const secondKey = onSubmit.mock.calls[1][0].idempotencyKey;

    expect(secondKey).not.toBe(firstKey);
  });
});
