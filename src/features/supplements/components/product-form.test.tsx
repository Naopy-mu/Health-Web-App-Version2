import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SupplementProduct } from "../schema";
import { ProductForm } from "./product-form";

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
  stock: { remainingTotal: 10, lotCount: 1, nearestExpiresOn: null, lowStock: false },
  rowVersion: 1,
  clientMutationId: null,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
};

describe("ProductForm", () => {
  beforeAll(() => {
    vi.stubGlobal("crypto", { randomUUID: () => "0ed6f568-e1cd-42c5-889e-358a00748f21" });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("在庫ロットがある商品は単位を変更できない", async () => {
    const onSubmit = vi.fn();
    render(
      <ProductForm
        products={[PRODUCT]}
        editingProduct={PRODUCT}
        productIdsWithLots={new Set([PRODUCT.id])}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    const unitSelect = screen.getByLabelText("単位");
    expect(unitSelect).toBeDisabled();
    expect(screen.getByText("在庫ロットが存在するため単位は変更できません。")).toBeInTheDocument();
  });

  it("在庫ロットがない商品は単位を変更できる", async () => {
    const onSubmit = vi.fn();
    render(
      <ProductForm
        products={[PRODUCT]}
        editingProduct={PRODUCT}
        productIdsWithLots={new Set()}
        onSubmit={onSubmit}
        onCancel={vi.fn()}
        disabled={false}
        serverError={null}
      />,
    );

    expect(screen.getByLabelText("単位")).toBeEnabled();
  });
});
