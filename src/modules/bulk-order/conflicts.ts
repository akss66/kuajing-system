import type { ConflictGroup, StockDemandGroup } from "./types";

export type CrossStoreConflictResult = {
  blockedGroupIds: Set<string>;
  fileHashConflicts: Map<string, Set<string>>;
  subOrderConflicts: Map<string, Set<string>>;
};

export type StockConflictResult = {
  blockedGroupIds: Set<string>;
  shortageBySku: Map<
    string,
    { availableQuantity: number; requiredQuantity: number }
  >;
};

function groupOwners(
  groups: readonly ConflictGroup[],
  values: (group: ConflictGroup) => readonly string[],
) {
  const owners = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const value of new Set(values(group))) {
      const groupIds = owners.get(value) ?? new Set<string>();
      groupIds.add(group.groupId);
      owners.set(value, groupIds);
    }
  }
  return new Map([...owners].filter(([, groupIds]) => groupIds.size > 1));
}

export function findCrossStoreConflicts(
  groups: readonly ConflictGroup[],
): CrossStoreConflictResult {
  const groupIds = groups.map((group) => group.groupId);
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error("店铺分组 ID 不能重复");
  }

  const fileHashConflicts = groupOwners(groups, (group) => group.fileHashes);
  const subOrderConflicts = groupOwners(groups, (group) => group.subOrderNos);
  const blockedGroupIds = new Set<string>();
  for (const conflict of [fileHashConflicts, subOrderConflicts]) {
    for (const owners of conflict.values()) {
      for (const groupId of owners) blockedGroupIds.add(groupId);
    }
  }
  return { blockedGroupIds, fileHashConflicts, subOrderConflicts };
}

export function findGroupsAffectedByShortage(
  groups: readonly StockDemandGroup[],
  availableBySku: ReadonlyMap<string, number>,
): StockConflictResult {
  const groupIds = groups.map((group) => group.groupId);
  if (new Set(groupIds).size !== groupIds.length) {
    throw new Error("店铺分组 ID 不能重复");
  }
  for (const availableQuantity of availableBySku.values()) {
    if (!Number.isSafeInteger(availableQuantity) || availableQuantity < 0) {
      throw new Error("可售库存不能为负数");
    }
  }

  const requiredBySku = new Map<string, number>();
  const groupIdsBySku = new Map<string, Set<string>>();
  for (const group of groups) {
    for (const [skuId, quantity] of group.quantityBySku) {
      if (!Number.isSafeInteger(quantity) || quantity <= 0) {
        throw new Error("SKU 需求数量必须为正数");
      }
      requiredBySku.set(skuId, (requiredBySku.get(skuId) ?? 0) + quantity);
      const groupIdsForSku = groupIdsBySku.get(skuId) ?? new Set<string>();
      groupIdsForSku.add(group.groupId);
      groupIdsBySku.set(skuId, groupIdsForSku);
    }
  }

  const blockedGroupIds = new Set<string>();
  const shortageBySku = new Map<
    string,
    { availableQuantity: number; requiredQuantity: number }
  >();
  for (const [skuId, requiredQuantity] of requiredBySku) {
    const availableQuantity = availableBySku.get(skuId) ?? 0;
    if (requiredQuantity <= availableQuantity) continue;
    shortageBySku.set(skuId, { availableQuantity, requiredQuantity });
    for (const groupId of groupIdsBySku.get(skuId) ?? []) {
      blockedGroupIds.add(groupId);
    }
  }

  return { blockedGroupIds, shortageBySku };
}
