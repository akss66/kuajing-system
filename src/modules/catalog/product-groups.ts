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

function isAsciiDigit(character: string) {
  return character >= "0" && character <= "9";
}

function compareCodeUnits(left: string, right: string) {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function normalizeNumericToken(value: string) {
  const normalized = value.replace(/^0+/, "");
  return normalized === "" ? "0" : normalized;
}

function compareNumericTokens(left: string, right: string) {
  const normalizedLeft = normalizeNumericToken(left);
  const normalizedRight = normalizeNumericToken(right);

  if (normalizedLeft.length !== normalizedRight.length) {
    return normalizedLeft.length - normalizedRight.length;
  }

  const normalizedComparison = compareCodeUnits(normalizedLeft, normalizedRight);
  if (normalizedComparison !== 0) {
    return normalizedComparison;
  }

  if (left.length !== right.length) {
    return left.length - right.length;
  }

  return compareCodeUnits(left, right);
}

export function compareCatalogNaturally(left: string, right: string) {
  if (left === right) return 0;

  let leftIndex = 0;
  let rightIndex = 0;

  while (leftIndex < left.length && rightIndex < right.length) {
    const leftCharacter = left[leftIndex]!;
    const rightCharacter = right[rightIndex]!;
    const leftIsDigit = isAsciiDigit(leftCharacter);
    const rightIsDigit = isAsciiDigit(rightCharacter);

    if (leftIsDigit && rightIsDigit) {
      const leftStart = leftIndex;
      const rightStart = rightIndex;

      while (leftIndex < left.length && isAsciiDigit(left[leftIndex]!)) leftIndex += 1;
      while (rightIndex < right.length && isAsciiDigit(right[rightIndex]!)) rightIndex += 1;

      const numericComparison = compareNumericTokens(
        left.slice(leftStart, leftIndex),
        right.slice(rightStart, rightIndex),
      );
      if (numericComparison !== 0) {
        return numericComparison;
      }
      continue;
    }

    if (leftCharacter !== rightCharacter) {
      return compareCodeUnits(leftCharacter, rightCharacter);
    }

    leftIndex += 1;
    rightIndex += 1;
  }

  if (leftIndex < left.length) return 1;
  if (rightIndex < right.length) return -1;
  return 0;
}

function compareGroups<T extends CatalogGroupableItem>(
  left: CatalogProductGroup<T>,
  right: CatalogProductGroup<T>,
) {
  const sourceSequence = compareCatalogNaturally(
    left.sourceSequence ?? "",
    right.sourceSequence ?? "",
  );
  if (sourceSequence !== 0) {
    return sourceSequence;
  }

  const productName = compareCatalogNaturally(left.productName, right.productName);
  if (productName !== 0) {
    return productName;
  }

  return compareCatalogNaturally(left.productId, right.productId);
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
    group.variants.sort((left, right) => {
      const skuCode = compareCatalogNaturally(left.skuCode, right.skuCode);
      if (skuCode !== 0) {
        return skuCode;
      }

      return compareCatalogNaturally(left.id, right.id);
    });
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
