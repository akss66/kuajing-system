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
