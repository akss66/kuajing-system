export type CatalogGroupableItem = {
  id: string;
  productId: string;
  productName: string;
  sourceSequence: string | null;
  linkText: string | null;
  productUrl: string | null;
  skuCode: string;
};

export type CatalogProductGroup<T extends CatalogGroupableItem> = {
  productId: string;
  productName: string;
  sourceSequence: string | null;
  linkText: string | null;
  variants: T[];
};

export type CatalogSaleStatusFilter = "ALL" | "SELLABLE" | "NOT_SELLABLE";

const collator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

function compareGroups<T extends CatalogGroupableItem>(
  left: CatalogProductGroup<T>,
  right: CatalogProductGroup<T>,
) {
  const sourceSequence = collator.compare(
    left.sourceSequence ?? "",
    right.sourceSequence ?? "",
  );
  if (sourceSequence !== 0) {
    return sourceSequence;
  }

  const productName = collator.compare(left.productName, right.productName);
  if (productName !== 0) {
    return productName;
  }

  return collator.compare(left.productId, right.productId);
}

export function groupCatalogItems<T extends CatalogGroupableItem>(
  items: readonly T[],
): CatalogProductGroup<T>[] {
  const groupsByProductId = new Map<string, CatalogProductGroup<T>>();

  for (const item of items) {
    const group = groupsByProductId.get(item.productId);
    if (group) {
      group.variants.push(item);
      continue;
    }

    groupsByProductId.set(item.productId, {
      linkText: item.linkText,
      productId: item.productId,
      productName: item.productName,
      sourceSequence: item.sourceSequence,
      variants: [item],
    });
  }

  const groups = [...groupsByProductId.values()];
  for (const group of groups) {
    group.variants.sort((left, right) => collator.compare(left.skuCode, right.skuCode));
  }

  return groups.sort(compareGroups);
}

function includesQuery(value: string | null, query: string) {
  return value?.toLocaleLowerCase().includes(query) ?? false;
}

export function filterCatalogGroups<T extends CatalogGroupableItem>(
  groups: readonly CatalogProductGroup<T>[],
  query: string,
  variantSearchValues: (variant: T) => Array<string | null>,
): CatalogProductGroup<T>[] {
  const normalizedQuery = query.trim().toLocaleLowerCase();
  if (!normalizedQuery) {
    return [...groups];
  }

  return groups.filter(
    (group) =>
      includesQuery(group.productName, normalizedQuery) ||
      includesQuery(group.sourceSequence, normalizedQuery) ||
      includesQuery(group.linkText, normalizedQuery) ||
      group.variants.some((variant) =>
        variantSearchValues(variant).some((value) =>
          includesQuery(value, normalizedQuery),
        ),
      ),
  );
}

export function filterCatalogGroupVariants<T extends CatalogGroupableItem>(
  groups: readonly CatalogProductGroup<T>[],
  status: CatalogSaleStatusFilter,
  isSellable: (variant: T) => boolean,
): CatalogProductGroup<T>[] {
  if (status === "ALL") {
    return groups.map((group) => ({ ...group, variants: [...group.variants] }));
  }

  const expected = status === "SELLABLE";
  return groups.flatMap((group) => {
    const variants = group.variants.filter((variant) => isSellable(variant) === expected);
    return variants.length > 0 ? [{ ...group, variants }] : [];
  });
}
