WITH latest_import AS (
  SELECT normalized_rows_json
  FROM feishu_cargo_migration_runs
  WHERE status = 'IMPORTED'
  ORDER BY imported_at DESC NULLS LAST, created_at DESC, id DESC
  LIMIT 1
), source_rows AS (
  SELECT
    COALESCE(row_data ->> 'sourceSequence', row_data ->> 'productGroupKey') AS source_sequence,
    row_data ->> 'skuCode' AS sku_code,
    NULLIF(row_data ->> 'linkText', '') AS link_text,
    CASE
      WHEN NULLIF(row_data ->> 'cargoUnitPriceMilliYuan', '') ~ '^[0-9]+$'
        THEN (row_data ->> 'cargoUnitPriceMilliYuan')::integer
      ELSE NULL
    END AS cargo_unit_price_milli_yuan
  FROM latest_import
  CROSS JOIN LATERAL jsonb_array_elements(normalized_rows_json) AS source(row_data)
), source_group_skus AS (
  SELECT DISTINCT source_sequence, sku_code
  FROM source_rows
  WHERE source_sequence IS NOT NULL AND sku_code IS NOT NULL
), source_groups AS (
  SELECT
    source_sequence,
    count(*) AS source_sku_count,
    max(link_text) AS link_text,
    max(cargo_unit_price_milli_yuan) AS cargo_unit_price_milli_yuan
  FROM source_rows
  WHERE source_sequence IS NOT NULL AND sku_code IS NOT NULL
  GROUP BY source_sequence
), complete_group_products AS (
  SELECT group_skus.source_sequence, local_skus.product_id
  FROM source_group_skus AS group_skus
  INNER JOIN skus AS local_skus ON local_skus.sku_code = group_skus.sku_code
  GROUP BY group_skus.source_sequence, local_skus.product_id
  HAVING count(*) = (
    SELECT source_sku_count
    FROM source_groups
    WHERE source_groups.source_sequence = group_skus.source_sequence
  )
  AND NOT EXISTS (
    SELECT 1
    FROM skus AS sibling
    WHERE sibling.product_id = local_skus.product_id
      AND NOT EXISTS (
        SELECT 1
        FROM source_group_skus AS source_sibling
        WHERE source_sibling.source_sequence = group_skus.source_sequence
          AND source_sibling.sku_code = sibling.sku_code
      )
  )
)
UPDATE products
SET
  source_sequence = COALESCE(products.source_sequence, source_groups.source_sequence),
  link_text = COALESCE(products.link_text, source_groups.link_text),
  cargo_unit_price_milli_yuan = COALESCE(
    products.cargo_unit_price_milli_yuan,
    source_groups.cargo_unit_price_milli_yuan
  )
FROM complete_group_products
INNER JOIN source_groups
  ON source_groups.source_sequence = complete_group_products.source_sequence
WHERE products.id = complete_group_products.product_id;
