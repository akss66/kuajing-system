import { describe, expect, it } from "vitest";

import { inventoryMovementsRedirectHref } from "@/modules/inventory/movement-navigation";

describe("inventory movement navigation", () => {
  it("redirects the legacy tab URL to the standalone module with only canonical filters", () => {
    expect(
      inventoryMovementsRedirectHref({
        from: "2026-08-01",
        operator: ["admin-1", "ignored-admin"],
        page: "3",
        sku: "TZX-001",
        source: "SYSTEM_ORDER_SHIPMENT",
        to: "2026-08-31",
        type: "SHIPMENT",
        unknown: "must-not-leak",
        view: "movements",
      }),
    ).toBe(
      "/admin/inventory/movements?sku=TZX-001&from=2026-08-01&to=2026-08-31&type=SHIPMENT&operator=admin-1&source=SYSTEM_ORDER_SHIPMENT&page=3",
    );
  });

  it("uses the clean standalone route when the legacy URL has no filters", () => {
    expect(inventoryMovementsRedirectHref({ view: "movements" })).toBe(
      "/admin/inventory/movements",
    );
  });
});
