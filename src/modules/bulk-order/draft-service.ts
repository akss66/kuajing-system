import {
  and,
  asc,
  desc,
  eq,
  inArray,
  sql,
} from "drizzle-orm";

import { db, type DbTransaction } from "@/db/client";
import {
  auditLogs,
  bulkImportDrafts,
  bulkImportStoreGroups,
  orderImportBatches,
  stores,
} from "@/db/schema";
import {
  createTemuImportPreviewInTransaction,
  type ImportPreviewSummary,
} from "@/modules/order-import/service";

const DRAFT_LIFETIME_MS = 24 * 60 * 60 * 1_000;
const MAX_DRAFT_GROUPS = 20;
const MAX_GROUP_FILES = 10;
const MAX_DRAFT_FILES = 100;

export type BulkDraftStatus =
  | "DRAFT"
  | "PARTIALLY_SUBMITTED"
  | "COMPLETED"
  | "EXPIRED";

export type BulkDraftUploadFile = {
  buffer: Uint8Array;
  fileName: string;
  mimeType: string;
};

export type StoreGroupFileView = {
  batchId: string;
  expiresAt: Date;
  fileName: string;
  fileSizeBytes: number;
  summary: ImportPreviewSummary;
};

export type StoreGroupView = {
  id: string;
  customerId: string;
  draftId: string;
  storeId: string;
  storeName: string;
  status: "PREVIEW" | "SUBMITTED" | "EXPIRED" | "CANCELLED";
  files: StoreGroupFileView[];
};

export type BulkDraftView = {
  id: string;
  customerId: string;
  status: BulkDraftStatus;
  createdAt: Date;
  updatedAt: Date;
  expiresAt: Date;
  groups: StoreGroupView[];
};

export type BulkDraftListItem = {
  createdAt: Date;
  expiresAt: Date;
  fileCount: number;
  groupCount: number;
  id: string;
  status: BulkDraftStatus;
  submittableGroupCount: number;
  updatedAt: Date;
};

export class BulkDraftError extends Error {
  constructor(
    public readonly code:
      | "DRAFT_NOT_FOUND"
      | "DRAFT_EXPIRED"
      | "DRAFT_NOT_WRITABLE"
      | "STORE_NOT_OWNED"
      | "STORE_DISABLED"
      | "STORE_GROUP_EXISTS"
      | "GROUP_NOT_FOUND"
      | "GROUP_LIMIT"
      | "GROUP_FILE_LIMIT"
      | "DRAFT_FILE_LIMIT"
      | "EMPTY_FILES"
      | "GROUP_FILE_NOT_FOUND",
    message: string,
  ) {
    super(message);
    this.name = "BulkDraftError";
  }
}

function isWritableStatus(status: BulkDraftStatus) {
  return status === "DRAFT" || status === "PARTIALLY_SUBMITTED";
}

async function lockOwnedWritableDraft(
  tx: DbTransaction,
  customerId: string,
  draftId: string,
) {
  const [draft] = await tx
    .select()
    .from(bulkImportDrafts)
    .where(
      and(
        eq(bulkImportDrafts.id, draftId),
        eq(bulkImportDrafts.customerId, customerId),
      ),
    )
    .for("update")
    .limit(1);
  if (!draft) {
    throw new BulkDraftError("DRAFT_NOT_FOUND", "找不到该批量导入草稿");
  }

  if (draft.expiresAt.getTime() <= Date.now()) {
    if (draft.status !== "EXPIRED") {
      await tx
        .update(bulkImportDrafts)
        .set({ status: "EXPIRED", updatedAt: new Date() })
        .where(eq(bulkImportDrafts.id, draft.id));
    }
    throw new BulkDraftError("DRAFT_EXPIRED", "该批量导入草稿已过期");
  }
  if (!isWritableStatus(draft.status)) {
    throw new BulkDraftError("DRAFT_NOT_WRITABLE", "该批量导入草稿不可再修改");
  }

  return draft;
}

async function ownedGroup(tx: DbTransaction, customerId: string, groupId: string) {
  const [group] = await tx
    .select({
      customerId: bulkImportStoreGroups.customerId,
      draftId: bulkImportStoreGroups.draftId,
      id: bulkImportStoreGroups.id,
      status: bulkImportStoreGroups.status,
      storeId: bulkImportStoreGroups.storeId,
      storeName: stores.name,
      storeStatus: stores.status,
    })
    .from(bulkImportStoreGroups)
    .innerJoin(stores, eq(stores.id, bulkImportStoreGroups.storeId))
    .where(
      and(
        eq(bulkImportStoreGroups.id, groupId),
        eq(bulkImportStoreGroups.customerId, customerId),
      ),
    )
    .limit(1);
  if (!group) {
    throw new BulkDraftError("GROUP_NOT_FOUND", "找不到该店铺上传分组");
  }
  return group;
}

async function countGroupFiles(tx: DbTransaction, groupId: string) {
  const [result] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orderImportBatches)
    .where(eq(orderImportBatches.storeGroupId, groupId));
  return result.count;
}

async function countDraftFiles(tx: DbTransaction, draftId: string) {
  const [result] = await tx
    .select({ count: sql<number>`count(*)::int` })
    .from(orderImportBatches)
    .innerJoin(
      bulkImportStoreGroups,
      eq(bulkImportStoreGroups.id, orderImportBatches.storeGroupId),
    )
    .where(eq(bulkImportStoreGroups.draftId, draftId));
  return result.count;
}

export async function createBulkDraft(input: {
  actorUserId: string;
  customerId: string;
}): Promise<BulkDraftView> {
  const createdAt = new Date();
  const expiresAt = new Date(createdAt.getTime() + DRAFT_LIFETIME_MS);
  const draftId = await db.transaction(async (tx) => {
    const [draft] = await tx
      .insert(bulkImportDrafts)
      .values({
        createdAt,
        customerId: input.customerId,
        expiresAt,
        updatedAt: createdAt,
      })
      .returning({ id: bulkImportDrafts.id });
    await tx.insert(auditLogs).values({
      action: "BULK_IMPORT_DRAFT_CREATED",
      actorId: input.actorUserId,
      actorType: "CUSTOMER",
      afterJson: { customerId: input.customerId, expiresAt: expiresAt.toISOString() },
      beforeJson: {},
      entityId: draft.id,
      entityType: "BULK_IMPORT_DRAFT",
      reason: "客户创建多店铺批量导入草稿",
    });
    return draft.id;
  });
  return getBulkDraft(input.customerId, draftId);
}

export async function addStoreGroup(input: {
  draftId: string;
  customerId: string;
  storeId: string;
}): Promise<StoreGroupView> {
  const group = await db.transaction(async (tx) => {
    const draft = await lockOwnedWritableDraft(
      tx,
      input.customerId,
      input.draftId,
    );
    const [store] = await tx
      .select({ id: stores.id, name: stores.name, status: stores.status })
      .from(stores)
      .where(
        and(
          eq(stores.id, input.storeId),
          eq(stores.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (!store) {
      throw new BulkDraftError("STORE_NOT_OWNED", "无权使用该店铺");
    }
    if (store.status !== "ACTIVE") {
      throw new BulkDraftError("STORE_DISABLED", "该店铺已停用，不能上传订单");
    }

    const [existing] = await tx
      .select({ id: bulkImportStoreGroups.id })
      .from(bulkImportStoreGroups)
      .where(
        and(
          eq(bulkImportStoreGroups.draftId, draft.id),
          eq(bulkImportStoreGroups.storeId, store.id),
        ),
      )
      .limit(1);
    if (existing) {
      throw new BulkDraftError(
        "STORE_GROUP_EXISTS",
        "该草稿已添加此店铺，请在现有分组继续上传",
      );
    }

    const [countResult] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(bulkImportStoreGroups)
      .where(eq(bulkImportStoreGroups.draftId, draft.id));
    if (countResult.count >= MAX_DRAFT_GROUPS) {
      throw new BulkDraftError("GROUP_LIMIT", "一个草稿最多添加 20 个店铺");
    }

    const [created] = await tx
      .insert(bulkImportStoreGroups)
      .values({
        customerId: input.customerId,
        draftId: draft.id,
        storeId: store.id,
      })
      .returning({
        customerId: bulkImportStoreGroups.customerId,
        draftId: bulkImportStoreGroups.draftId,
        id: bulkImportStoreGroups.id,
        status: bulkImportStoreGroups.status,
        storeId: bulkImportStoreGroups.storeId,
      });
    return { ...created, storeName: store.name };
  });

  return { ...group, files: [] };
}

export async function uploadGroupFiles(input: {
  actorUserId?: string;
  groupId: string;
  customerId: string;
  files: readonly BulkDraftUploadFile[];
}): Promise<StoreGroupView> {
  if (input.files.length === 0) {
    throw new BulkDraftError("EMPTY_FILES", "请选择至少一个 Excel 文件");
  }

  const draftId = await db.transaction(async (tx) => {
    const group = await ownedGroup(tx, input.customerId, input.groupId);
    const draft = await lockOwnedWritableDraft(
      tx,
      input.customerId,
      group.draftId,
    );
    if (group.storeStatus !== "ACTIVE") {
      throw new BulkDraftError("STORE_DISABLED", "该店铺已停用，不能上传订单");
    }
    const currentGroupFiles = await countGroupFiles(tx, group.id);
    if (currentGroupFiles + input.files.length > MAX_GROUP_FILES) {
      throw new BulkDraftError(
        "GROUP_FILE_LIMIT",
        "一个店铺分组最多上传 10 个文件",
      );
    }
    const currentDraftFiles = await countDraftFiles(tx, draft.id);
    if (currentDraftFiles + input.files.length > MAX_DRAFT_FILES) {
      throw new BulkDraftError(
        "DRAFT_FILE_LIMIT",
        "一个草稿最多上传 100 个文件",
      );
    }

    for (const file of input.files) {
      await createTemuImportPreviewInTransaction(tx, {
        actorUserId: input.actorUserId ?? null,
        buffer: file.buffer,
        customerId: input.customerId,
        expiresAt: draft.expiresAt,
        fileName: file.fileName,
        mimeType: file.mimeType,
        storeGroupId: group.id,
        storeId: group.storeId,
        storeName: group.storeName,
      });
    }
    return draft.id;
  });

  const draft = await getBulkDraft(input.customerId, draftId);
  const group = draft.groups.find((candidate) => candidate.id === input.groupId);
  if (!group) {
    throw new BulkDraftError("GROUP_NOT_FOUND", "找不到该店铺上传分组");
  }
  return group;
}

export async function getBulkDraft(
  customerId: string,
  draftId: string,
): Promise<BulkDraftView> {
  const [draft] = await db
    .select()
    .from(bulkImportDrafts)
    .where(
      and(
        eq(bulkImportDrafts.id, draftId),
        eq(bulkImportDrafts.customerId, customerId),
      ),
    )
    .limit(1);
  if (!draft) {
    throw new BulkDraftError("DRAFT_NOT_FOUND", "找不到该批量导入草稿");
  }

  let status = draft.status;
  let updatedAt = draft.updatedAt;
  if (
    draft.expiresAt.getTime() <= Date.now() &&
    isWritableStatus(draft.status)
  ) {
    status = "EXPIRED";
    updatedAt = new Date();
    await db
      .update(bulkImportDrafts)
      .set({ status, updatedAt })
      .where(
        and(
          eq(bulkImportDrafts.id, draft.id),
          inArray(bulkImportDrafts.status, ["DRAFT", "PARTIALLY_SUBMITTED"]),
        ),
      );
  }

  const groups = await db
    .select({
      customerId: bulkImportStoreGroups.customerId,
      draftId: bulkImportStoreGroups.draftId,
      id: bulkImportStoreGroups.id,
      status: bulkImportStoreGroups.status,
      storeId: bulkImportStoreGroups.storeId,
      storeName: stores.name,
    })
    .from(bulkImportStoreGroups)
    .innerJoin(stores, eq(stores.id, bulkImportStoreGroups.storeId))
    .where(
      and(
        eq(bulkImportStoreGroups.draftId, draft.id),
        eq(bulkImportStoreGroups.customerId, customerId),
      ),
    )
    .orderBy(asc(bulkImportStoreGroups.createdAt));

  const batches =
    groups.length === 0
      ? []
      : await db
          .select({
            batchId: orderImportBatches.id,
            duplicate: orderImportBatches.duplicateRows,
            expiresAt: orderImportBatches.expiresAt,
            fileName: orderImportBatches.originalFileName,
            fileSizeBytes: orderImportBatches.fileSizeBytes,
            groupId: orderImportBatches.storeGroupId,
            invalid: orderImportBatches.invalidRows,
            ready: orderImportBatches.readyRows,
            total: orderImportBatches.totalRows,
            unknownSku: orderImportBatches.unknownSkuRows,
          })
          .from(orderImportBatches)
          .where(
            inArray(
              orderImportBatches.storeGroupId,
              groups.map((group) => group.id),
            ),
          )
          .orderBy(asc(orderImportBatches.createdAt));

  return {
    createdAt: draft.createdAt,
    customerId: draft.customerId,
    expiresAt: draft.expiresAt,
    groups: groups.map((group) => ({
      ...group,
      files: batches
        .filter((batch) => batch.groupId === group.id)
        .map((batch) => ({
          batchId: batch.batchId,
          expiresAt: batch.expiresAt,
          fileName: batch.fileName,
          fileSizeBytes: batch.fileSizeBytes,
          summary: {
            duplicate: batch.duplicate,
            invalid: batch.invalid,
            ready: batch.ready,
            total: batch.total,
            unknownSku: batch.unknownSku,
          },
        })),
    })),
    id: draft.id,
    status,
    updatedAt,
  };
}

export async function listBulkDrafts(customerId: string): Promise<BulkDraftListItem[]> {
  const drafts = await db
    .select({
      createdAt: bulkImportDrafts.createdAt,
      expiresAt: bulkImportDrafts.expiresAt,
      id: bulkImportDrafts.id,
      status: bulkImportDrafts.status,
      updatedAt: bulkImportDrafts.updatedAt,
    })
    .from(bulkImportDrafts)
    .where(eq(bulkImportDrafts.customerId, customerId))
    .orderBy(desc(bulkImportDrafts.updatedAt));

  if (!drafts.length) return [];

  const groupRows = await db
    .select({
      draftId: bulkImportStoreGroups.draftId,
      fileCount: sql<number>`count(${orderImportBatches.id})::int`.mapWith(Number),
      groupId: bulkImportStoreGroups.id,
      status: bulkImportStoreGroups.status,
    })
    .from(bulkImportStoreGroups)
    .leftJoin(
      orderImportBatches,
      eq(orderImportBatches.storeGroupId, bulkImportStoreGroups.id),
    )
    .where(
      inArray(
        bulkImportStoreGroups.draftId,
        drafts.map((draft) => draft.id),
      ),
    )
    .groupBy(bulkImportStoreGroups.draftId, bulkImportStoreGroups.id, bulkImportStoreGroups.status);

  return drafts.map((draft) => {
    const draftGroups = groupRows.filter((group) => group.draftId === draft.id);
    return {
      createdAt: draft.createdAt,
      expiresAt: draft.expiresAt,
      fileCount: draftGroups.reduce((total, group) => total + group.fileCount, 0),
      groupCount: draftGroups.length,
      id: draft.id,
      status: draft.status,
      submittableGroupCount: draftGroups.filter((group) => group.status === "PREVIEW").length,
      updatedAt: draft.updatedAt,
    };
  });
}

export async function removeGroupFile(input: {
  customerId: string;
  batchId: string;
}): Promise<void> {
  await db.transaction(async (tx) => {
    const [candidate] = await tx
      .select({
        draftId: bulkImportStoreGroups.draftId,
        groupId: bulkImportStoreGroups.id,
      })
      .from(orderImportBatches)
      .innerJoin(
        bulkImportStoreGroups,
        eq(bulkImportStoreGroups.id, orderImportBatches.storeGroupId),
      )
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
          eq(bulkImportStoreGroups.customerId, input.customerId),
        ),
      )
      .limit(1);
    if (!candidate) {
      throw new BulkDraftError(
        "GROUP_FILE_NOT_FOUND",
        "找不到该店铺分组中的导入文件",
      );
    }

    await lockOwnedWritableDraft(tx, input.customerId, candidate.draftId);
    const removed = await tx
      .delete(orderImportBatches)
      .where(
        and(
          eq(orderImportBatches.id, input.batchId),
          eq(orderImportBatches.customerId, input.customerId),
          eq(orderImportBatches.storeGroupId, candidate.groupId),
        ),
      )
      .returning({ id: orderImportBatches.id });
    if (removed.length === 0) {
      throw new BulkDraftError(
        "GROUP_FILE_NOT_FOUND",
        "找不到该店铺分组中的导入文件",
      );
    }
  });
}
