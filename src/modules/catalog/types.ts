export type ResolveUnitPriceInput = {
  customerId: string;
  skuId: string;
  overrideUnitPriceFen?: number;
};

export type ResolveStandardSkuInput = {
  storeId: string;
  externalSku: string;
};
