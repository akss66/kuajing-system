export type SkuSalesReportRow = {
  quantity: number;
  revenueFen: number;
  skuCode: string;
  skuId: string;
  skuName: string;
};

export type StoreSalesReportRow = {
  orderCount: number;
  packageCount: number;
  quantity: number;
  revenueFen: number;
  storeId: string;
  storeName: string;
};

export type ReplacementReportRow = {
  quantity: number;
  reason: string;
  requestCount: number;
};

export type FundsReport = {
  adminCreditsFen: number;
  adminDebitsFen: number;
  approvedOfflineFen: number;
  completedOfflineRefundsFen: number;
  orderDebitsFen: number;
  orderRefundsFen: number;
  pendingReceivableFen: number;
};

export type OperationsReport = {
  funds: FundsReport;
  replacements: ReplacementReportRow[];
  skuSales: SkuSalesReportRow[];
  stores: StoreSalesReportRow[];
  trend: Array<{
    date: string;
    orderCount: number;
    revenueFen: number;
  }>;
  summary: {
    orderCount: number;
    packageCount: number;
    quantity: number;
    replacementQuantity: number;
    revenueFen: number;
  };
};

export type StockCoverageReportRow = {
  alertLevel: "CRITICAL" | "WARNING" | "NONE" | "NO_BASELINE";
  availableQuantity: number;
  averageDailyQuantity: number;
  coverageDays: number | null;
  shippedQuantity7d: number;
  skuCode: string;
  skuId: string;
  skuName: string;
  totalQuantity: number;
};
