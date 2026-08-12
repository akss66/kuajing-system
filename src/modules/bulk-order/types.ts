export type AllocationOrder = {
  orderId: string;
  totalAmountFen: number;
};

export type WalletAllocation = {
  orderId: string;
  walletFen: number;
  offlineFen: number;
};

export type ConflictGroup = {
  groupId: string;
  fileHashes: readonly string[];
  subOrderNos: readonly string[];
};

export type StockDemandGroup = {
  groupId: string;
  quantityBySku: ReadonlyMap<string, number>;
};
