const HEADER = [
  "序号",
  "SKU",
  "图片",
  "名称",
  "货品价格",
  "采购价",
  "总库存",
  "可售库存",
  "链接文字",
  "规格",
  "颜色",
  "组合销售",
  "重量",
  "状态",
] as const;

function imageToken(skuCode: string) {
  return { fileToken: `field-aligned-image-${skuCode}` };
}

function productLink(sequence: number) {
  return {
    text: "查看飞书商品",
    link: `https://example.test/feishu/${sequence}`,
  };
}

/**
 * A field-aligned read-only Feishu payload: 74 source sequences, 140 distinct
 * SKUs and one image token for every SKU. Sequence 34 intentionally owns three
 * SKUs so parser grouping cannot be inferred from an individual SKU row.
 */
export function buildFieldAlignedCargoSourceFixture(): { value: unknown[][] } {
  const value: unknown[][] = [Array.from(HEADER)];

  for (let sequence = 1; sequence <= 74; sequence += 1) {
    const skuCount = sequence === 34 ? 3 : sequence <= 65 ? 2 : 1;
    const paddedSequence = String(sequence).padStart(3, "0");

    for (let variant = 1; variant <= skuCount; variant += 1) {
      const skuCode = `TZX-${paddedSequence}-${variant}`;
      const isGroupLeader = variant === 1;
      const cargoPrice = sequence === 34 ? "1.366" : `${sequence}.366`;
      const defaultPrice = sequence === 34 ? "0.325" : `${sequence}.325`;

      value.push([
        isGroupLeader ? String(sequence) : "",
        skuCode,
        imageToken(skuCode),
        isGroupLeader ? `字段映射商品 ${sequence}` : "",
        isGroupLeader ? cargoPrice : "",
        isGroupLeader ? defaultPrice : "",
        sequence === 34 ? "0" : String(variant),
        sequence === 34 ? "0" : String(variant),
        isGroupLeader ? productLink(sequence) : "",
        isGroupLeader ? "标准款" : "",
        `颜色 ${variant}`,
        isGroupLeader ? "单个" : "",
        isGroupLeader ? "100g" : "",
        isGroupLeader ? "可售" : "",
      ]);
    }
  }

  return { value };
}
