import { z } from "zod";

import type {
  JifengCandidateResult,
  JifengOfflineLogistics,
  JifengWarehouse,
} from "./types";

const optionalText = z.string().optional();

export const jifengWarehouseSchema = z.object({
  address: optionalText,
  area: optionalText,
  city: optionalText,
  code: z.string().trim().min(1),
  contactPerson: optionalText,
  country: z.string().trim().min(1),
  email: optionalText,
  id: z.coerce.number().int().optional(),
  isAuth: z.boolean().optional(),
  name: z.string().trim().min(1),
  orderReceiveStatus: z.coerce.number().int().optional(),
  phone: optionalText,
  postCode: optionalText,
  province: optionalText,
  receiveStatus: z.coerce.number().int().optional(),
  remark: optionalText,
  selfSending: z.coerce.number().int().optional(),
  timeZone: optionalText,
  type: z.coerce.number().int().optional(),
}) satisfies z.ZodType<JifengWarehouse>;

export const jifengOfflineLogisticsSchema = z.object({
  code: z.string().trim().min(1),
  id: z.coerce.number().int(),
  name: z.string().trim().min(1),
}) satisfies z.ZodType<JifengOfflineLogistics>;

const offlineLogisticsDataSchema = z.object({
  page: z.object({
    heads: z
      .array(z.object({ key: z.string(), value: z.string() }))
      .optional(),
    pageNo: z.coerce.number().int(),
    pageSize: z.coerce.number().int(),
    rows: z.array(jifengOfflineLogisticsSchema),
    totalPage: z.coerce.number().int(),
    totalSize: z.coerce.number().int(),
  }),
});

// Add a code only after it has been verified against an official production
// response. No carrier code is currently confirmed for Canada Post.
const confirmedCanadaPostCodes = new Set<string>();
const explicitCanadaPostNames = new Set(["canada post", "加拿大邮政"]);

export function parseJifengWarehouses(data: unknown): JifengWarehouse[] {
  return z.array(jifengWarehouseSchema).parse(data);
}

export function parseJifengOfflineLogistics(
  data: unknown,
): JifengOfflineLogistics[] {
  return offlineLogisticsDataSchema.parse(data).page.rows;
}

export function classifyCanadaPostCandidates(
  channels: JifengOfflineLogistics[],
): JifengCandidateResult {
  const candidates = channels.filter((channel) => {
    const name = channel.name.trim().toLocaleLowerCase("en-CA");
    const code = channel.code.trim().toLocaleUpperCase("en-CA");
    return (
      explicitCanadaPostNames.has(name) || confirmedCanadaPostCodes.has(code)
    );
  });

  if (candidates.length === 1) {
    return { candidate: candidates[0], candidates, status: "MATCHED" };
  }
  return { candidates, status: "AMBIGUOUS" };
}
