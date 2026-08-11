export type JifengCredentials = {
  accessToken: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  userId: string;
};

export type JifengCreateOrderSku = {
  itemNameCn?: string;
  itemNameEn?: string;
  num: number;
  sku: string;
  unitPrice?: number;
};

export type JifengCreateOrderInput = {
  amount?: number;
  buyerName: string;
  buyerPhone: string;
  currency?: string;
  erpNo: string;
  logisticsId?: number;
  logisticsName?: string;
  note?: string;
  platform: "temu" | "other";
  platformOrderNo?: string;
  recipientAddress: string;
  recipientAddress2?: string;
  recipientArea?: string;
  recipientCity: string;
  recipientCountry: "CA";
  recipientEmail?: string;
  recipientProvince: string;
  shopName?: string;
  skuList: JifengCreateOrderSku[];
  type: 1 | 2;
  warehouse: string;
  zipCode: string;
};

export type JifengOrderDetail = {
  currency?: string;
  erpNo: string;
  errorCode?: number;
  errorMsg?: string;
  logisticsFee?: number;
  orderNo?: string;
  shippedTime?: string;
  status: number;
  trackingNo?: string;
};
