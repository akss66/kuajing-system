import { and, asc, desc, eq, exists, inArray, or, sql, type SQL } from "drizzle-orm";

import { db } from "@/db/client";
import {
  bulkImportDrafts,
  bulkImportStoreGroups,
  customers,
  orderImportBatches,
  orderImportRows,
  stores,
} from "@/db/schema";
import { requireAdmin } from "@/modules/identity/guards";
import { BUSINESS_TIME_ZONE } from "@/shared/brand";

import {
  getAdminBulkDraftErrorLabel,
  getAdminBulkDraftStatusLabel,
  getAdminBulkDraftValidationLabel,
} from "@/modules/settlement/admin-ui-labels";
import {
  type BulkDraftValidationStatus,
  validateBulkDraft,
} from "./validation-service";

export type AdminBulkDraftFilters = {
  customerId?: string;
  dateFrom?: string;
  dateTo?: string;
  status?: BulkDraftValidationStatus;
  storeId?: string;
};

function isIsoDate(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export async function listAdminBulkDrafts(filters: AdminBulkDraftFilters = {}) {
  await requireAdmin();

  const conditions: SQL[] = [];
  if (filters.customerId) {
    conditions.push(eq(bulkImportDrafts.customerId, filters.customerId));
  }
  if (filters.storeId) {
    conditions.push(
      exists(
        db
          .select({ id: bulkImportStoreGroups.id })
          .from(bulkImportStoreGroups)
          .where(
            and(
              eq(bulkImportStoreGroups.draftId, bulkImportDrafts.id),
              eq(bulkImportStoreGroups.storeId, filters.storeId),
            ),
          ),
      ),
    );
  }
  if (filters.status === "ALREADY_SUBMITTED") {
    conditions.push(
      exists(
        db
          .select({ id: bulkImportStoreGroups.id })
          .from(bulkImportStoreGroups)
          .where(
            and(
              eq(bulkImportStoreGroups.draftId, bulkImportDrafts.id),
              eq(bulkImportStoreGroups.status, "SUBMITTED"),
            ),
          ),
      ),
    );
  }
  if (filters.status === "EXPIRED") {
    conditions.push(
      or(
        eq(bulkImportDrafts.status, "EXPIRED"),
        exists(
          db
            .select({ id: bulkImportStoreGroups.id })
            .from(bulkImportStoreGroups)
            .where(
              and(
                eq(bulkImportStoreGroups.draftId, bulkImportDrafts.id),
                eq(bulkImportStoreGroups.status, "EXPIRED"),
              ),
            ),
        ),
      )!,
    );
  }
  if (filters.dateFrom && isIsoDate(filters.dateFrom)) {
    conditions.push(
      sql`(${bulkImportDrafts.updatedAt} at time zone ${BUSINESS_TIME_ZONE})::date >= ${filters.dateFrom}::date`,
    );
  }
  if (filters.dateTo && isIsoDate(filters.dateTo)) {
    conditions.push(
      sql`(${bulkImportDrafts.updatedAt} at time zone ${BUSINESS_TIME_ZONE})::date <= ${filters.dateTo}::date`,
    );
  }

  const drafts = await db
    .select({
      createdAt: bulkImportDrafts.createdAt,
      customerCode: customers.code,
      customerId: customers.id,
      customerName: customers.name,
      expiresAt: bulkImportDrafts.expiresAt,
      id: bulkImportDrafts.id,
      status: bulkImportDrafts.status,
      updatedAt: bulkImportDrafts.updatedAt,
    })
    .from(bulkImportDrafts)
    .innerJoin(customers, eq(customers.id, bulkImportDrafts.customerId))
    .where(conditions.length ? and(...conditions) : undefined)
    .orderBy(desc(bulkImportDrafts.updatedAt))
    .limit(50);

  const draftIds = drafts.map((draft) => draft.id);
  const counts =
    draftIds.length === 0
      ? []
      : await db
          .select({
            draftId: bulkImportStoreGroups.draftId,
            fileCount: sql<number>`count(${orderImportBatches.id})::int`.mapWith(Number),
            groupId: bulkImportStoreGroups.id,
          })
          .from(bulkImportStoreGroups)
          .leftJoin(
            orderImportBatches,
            eq(orderImportBatches.storeGroupId, bulkImportStoreGroups.id),
          )
          .where(inArray(bulkImportStoreGroups.draftId, draftIds))
          .groupBy(bulkImportStoreGroups.draftId, bulkImportStoreGroups.id);

  const summary = new Map<string, { fileCount: number; groupCount: number }>();
  for (const row of counts) {
    const current = summary.get(row.draftId) ?? { fileCount: 0, groupCount: 0 };
    current.fileCount += row.fileCount;
    current.groupCount += 1;
    summary.set(row.draftId, current);
  }

  const validations = await Promise.all(
    drafts.map(async (draft) => {
      const validation = await validateBulkDraft({
        customerId: draft.customerId,
        draftId: draft.id,
      });
      return [draft.id, validation] as const;
    }),
  );
  const validationByDraft = new Map(validations);

  const groupRows =
    draftIds.length === 0
      ? []
      : await db
          .select({
            draftId: bulkImportStoreGroups.draftId,
            id: bulkImportStoreGroups.id,
            storeId: bulkImportStoreGroups.storeId,
            storeName: stores.name,
          })
          .from(bulkImportStoreGroups)
          .innerJoin(stores, eq(stores.id, bulkImportStoreGroups.storeId))
          .where(inArray(bulkImportStoreGroups.draftId, draftIds))
          .orderBy(asc(bulkImportStoreGroups.createdAt));

  return drafts
    .map((draft) => {
      const draftGroups = groupRows.filter((group) => group.draftId === draft.id);
      const validation = validationByDraft.get(draft.id);
      const statuses = draftGroups.map(
        (group) => validation?.groups.get(group.id)?.status ?? "EMPTY",
      );
      const dominantStatus =
        statuses.find((status) => status === "BLOCKED_CROSS_STORE") ??
        statuses.find((status) => status === "BLOCKED_INVALID") ??
        statuses.find((status) => status === "BLOCKED_UNKNOWN_SKU") ??
        statuses.find((status) => status === "BLOCKED_INVENTORY") ??
        statuses.find((status) => status === "SUBMITTABLE") ??
        statuses[0] ??
        "EMPTY";

      return {
        ...draft,
        diagnosticStatus: dominantStatus,
        fileCount: summary.get(draft.id)?.fileCount ?? 0,
        groupCount: summary.get(draft.id)?.groupCount ?? 0,
        statusLabel: getAdminBulkDraftStatusLabel(draft.status),
        storeIds: draftGroups.map((group) => group.storeId),
        validationStatusLabel: getAdminBulkDraftValidationLabel(dominantStatus),
      };
    })
    .filter((draft) => {
      if (filters.status && draft.diagnosticStatus !== filters.status) return false;
      return true;
    });
}

export async function getAdminBulkDraftDetail(draftId: string) {
  await requireAdmin();

  const [draft] = await db
    .select({
      createdAt: bulkImportDrafts.createdAt,
      customerCode: customers.code,
      customerId: customers.id,
      customerName: customers.name,
      expiresAt: bulkImportDrafts.expiresAt,
      id: bulkImportDrafts.id,
      status: bulkImportDrafts.status,
      updatedAt: bulkImportDrafts.updatedAt,
    })
    .from(bulkImportDrafts)
    .innerJoin(customers, eq(customers.id, bulkImportDrafts.customerId))
    .where(eq(bulkImportDrafts.id, draftId))
    .limit(1);
  if (!draft) return null;

  const validation = await validateBulkDraft({
    customerId: draft.customerId,
    draftId,
  });

  const groups = await db
    .select({
      id: bulkImportStoreGroups.id,
      status: bulkImportStoreGroups.status,
      storeId: bulkImportStoreGroups.storeId,
      storeName: stores.name,
    })
    .from(bulkImportStoreGroups)
    .innerJoin(stores, eq(stores.id, bulkImportStoreGroups.storeId))
    .where(eq(bulkImportStoreGroups.draftId, draftId))
    .orderBy(asc(bulkImportStoreGroups.createdAt));

  const groupIds = groups.map((group) => group.id);
  const fileRows =
    groupIds.length === 0
      ? []
      : await db
          .select({
            duplicateRows: orderImportBatches.duplicateRows,
            fileName: orderImportBatches.originalFileName,
            fileSizeBytes: orderImportBatches.fileSizeBytes,
            groupId: orderImportBatches.storeGroupId,
            id: orderImportBatches.id,
            invalidRows: orderImportBatches.invalidRows,
            readyRows: orderImportBatches.readyRows,
            totalRows: orderImportBatches.totalRows,
            unknownSkuRows: orderImportBatches.unknownSkuRows,
          })
          .from(orderImportBatches)
          .where(inArray(orderImportBatches.storeGroupId, groupIds))
          .orderBy(asc(orderImportBatches.createdAt));

  const resultRows =
    groupIds.length === 0
      ? []
      : await db
          .select({
            errorCode: orderImportRows.errorCode,
            groupId: orderImportBatches.storeGroupId,
            rowStatus: orderImportRows.status,
          })
          .from(orderImportRows)
          .innerJoin(
            orderImportBatches,
            eq(orderImportBatches.id, orderImportRows.batchId),
          )
          .where(inArray(orderImportBatches.storeGroupId, groupIds));

  return {
    createdAt: draft.createdAt,
    customerLabel: `${draft.customerCode} · ${draft.customerName}`,
    expiresAt: draft.expiresAt,
    id: draft.id,
    status: draft.status,
    statusLabel: getAdminBulkDraftStatusLabel(draft.status),
    storeGroups: groups.map((group) => {
      const validationGroup = validation.groups.get(group.id);
      const groupFiles = fileRows.filter((file) => file.groupId === group.id);
      const groupResults = resultRows.filter((row) => row.groupId === group.id);
      const errorCodes = [...new Set(validationGroup?.errorCodes ?? [])].map(
        getAdminBulkDraftErrorLabel,
      );

      return {
        errorCodeLabels: errorCodes,
        fileSummaries: groupFiles.map((file) => ({
          duplicateRows: file.duplicateRows,
          fileName: file.fileName,
          fileSizeBytes: file.fileSizeBytes,
          invalidRows: file.invalidRows,
          readyRows: file.readyRows,
          totalRows: file.totalRows,
          unknownSkuRows: file.unknownSkuRows,
        })),
        groupId: group.id,
        partialResultSummary: {
          duplicateRows: groupResults.filter((row) => row.rowStatus === "DUPLICATE").length,
          invalidRows: groupResults.filter((row) => row.rowStatus === "INVALID").length,
          readyRows: groupResults.filter((row) => row.rowStatus === "READY").length,
          unknownSkuRows: groupResults.filter((row) => row.rowStatus === "UNKNOWN_SKU").length,
        },
        statusLabel: getAdminBulkDraftValidationLabel(
          validationGroup?.status ?? group.status,
        ),
        storeName: group.storeName,
      };
    }),
    updatedAt: draft.updatedAt,
  };
}
