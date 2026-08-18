export const INVENTORY_MOVEMENTS_PATH = "/admin/inventory/movements";

type InventoryMovementSearchParams = Record<
  string,
  string | string[] | undefined
>;

const canonicalMovementFilterKeys = [
  "sku",
  "from",
  "to",
  "type",
  "operator",
  "source",
  "page",
] as const;

function firstValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

export function inventoryMovementsRedirectHref(
  params: InventoryMovementSearchParams,
) {
  const query = new URLSearchParams();
  for (const key of canonicalMovementFilterKeys) {
    const value = firstValue(params[key]);
    if (value) query.set(key, value);
  }
  const search = query.toString();
  return `${INVENTORY_MOVEMENTS_PATH}${search ? `?${search}` : ""}`;
}
