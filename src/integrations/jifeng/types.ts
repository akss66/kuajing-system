export type JifengCredentials = {
  accessToken: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken?: string;
  userId: string;
};

export type JifengTokenSet = {
  accessToken: string;
  expireIn: number;
  refreshExpireIn: number;
  refreshToken: string;
  requestId?: string;
  userId: string;
};

export type JifengRefreshInput = {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  userId: string;
};

export type JifengWarehouse = {
  address?: string;
  area?: string;
  city?: string;
  code: string;
  contactPerson?: string;
  country: string;
  email?: string;
  id?: number;
  isAuth?: boolean;
  name: string;
  orderReceiveStatus?: number;
  phone?: string;
  postCode?: string;
  province?: string;
  receiveStatus?: number;
  remark?: string;
  selfSending?: number;
  timeZone?: string;
  type?: number;
};

export type JifengOfflineLogistics = {
  code: string;
  id: number;
  name: string;
};

export type JifengCandidateResult =
  | {
      candidate: JifengOfflineLogistics;
      candidates: JifengOfflineLogistics[];
      status: "MATCHED";
    }
  | {
      candidates: JifengOfflineLogistics[];
      status: "AMBIGUOUS";
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
  packageType: 1 | 2 | 3;
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
  platformOrderNo?: string;
  shippedTime?: string;
  status: number;
  trackingNo?: string;
};
