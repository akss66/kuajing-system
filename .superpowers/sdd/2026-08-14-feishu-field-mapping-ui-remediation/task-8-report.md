# Task 8 implementation report

## Outcome and scope

- Added nullable structured inventory movement reason codes while retaining the required non-null legacy `reason` display snapshot.
- Added real stocktake batches and a nullable `ON DELETE RESTRICT` movement foreign key.
- Preserved the incumbent SKU/time index and added deterministic global, movement-type, actor, and reason `(created_at DESC, id DESC)` indexes.
- Added bounded, deterministic inventory snapshot and movement read models with combined filters, typed operators/sources, and only allowlisted order-shipment, replacement, Feishu-run, and stocktake relations.
- Did not modify `src/db/schema/index.ts`; its existing `export * from "./inventory"` already exports the new schema contract.
- Did not modify protected 0019/0020 artifacts, inventory service/actions/UI, fulfillment, Feishu behavior, production configuration/database, or deployment. Task 9 was not started.

## Witnessed RED → GREEN

### RED before schema/read-model implementation

```powershell
npm.cmd run test:integration -- tests/integration/schema/inventory-movement-listing.test.ts tests/integration/inventory/movement-query.test.ts
```

Exit code `1`: two files failed. The movement suite could not import the absent `@/modules/inventory/read-model`; the disposable-database schema test could not open the absent 0021 SQL; the journal assertion received 0018/0019/0020 instead of the required 0019/0020/0021 tail. These were the intended missing-feature failures.

### GREEN and adjacent compatibility

```powershell
npm.cmd run test:integration -- --no-file-parallelism tests/integration/schema/inventory-movement-listing.test.ts tests/integration/inventory/movement-query.test.ts
```

Exit code `0`: 2 files passed, 6 tests passed. Coverage includes the real forward migration, automatic-only backfill, nullable manual legacy rows, restrictive FK, complete index definitions, 30-row pagination, same-timestamp ID ordering, bounded page/page size, combined SKU/time/type/operator/source filters, clamped availability, structured/fallback reasons, human/system operators, all six typed sources, four allowlisted relation types, and an untrusted legacy reference that produces no URL.

Post-commit boundary review added one more witnessed RED before amending the same atomic commit: the focused movement suite reported `2 failed | 2 passed` because an intentionally conflicting legacy row matched both stocktake and system-shipment filters, and an extreme page remained `Number.MAX_SAFE_INTEGER`. The minimal fix made source predicates mutually exclusive in the same priority order as row classification and capped page at 1,000,000; the same focused file then passed 4/4.

```powershell
npm.cmd run test:integration -- --no-file-parallelism tests/integration/inventory/concurrency.test.ts tests/integration/fulfillment/status-sync.test.ts
```

Exit code `0`: 2 files passed, 8 tests passed. Existing nullable-compatible manual movements and automatic shipment deductions remain green without changing their owning code.

```powershell
npm.cmd run typecheck
```

Exit code `0` (`tsc --noEmit`).

## Migration generation and SQL review

- Verified `HEAD=a9b1abd` and local `main=e917031` before generation; the worktree was clean.
- Ran the repository-standard `npm.cmd run db:generate -- --name inventory_movement_listing_and_stocktakes` with only the local `tongzhouxing_test` URL, producing 0021 and its snapshot from committed 0020.
- Snapshot chain: 0020 id `e2ce9029-d6f0-410d-9485-b3f6da9f3b03`; 0021 `prevId` is exactly that id; journal entry is idx 21/tag `0021_inventory_movement_listing_and_stocktakes`.
- Manually reviewed one enum, one stocktake table, two nullable movement columns, one restrictive FK, and four new compound indexes. SQL SHA-256: `8C3383B12B7FBFD1385B5B9ACE84739E3F8A3AF044F77AA5FE4125318B5DBFB9`.
- The only handwritten data statement preserves legacy `reason` and fills `reason_code` solely for `FEISHU_CARGO_MIGRATION`, `SHIPMENT + ORDER_SHIPMENT`, and `REVERSAL`. It does not infer a code from free-text manual reasons.
- Applied migrations only to the explicit local `tongzhouxing_test` database; no production database was contacted.

## Integrity and hash evidence

```powershell
git diff --check
git diff --exit-code e917031 HEAD -- drizzle/0019_jifeng_bigint_logistics_id.sql drizzle/meta/0019_snapshot.json
git diff --exit-code ce04ff2 HEAD -- drizzle/0020_feishu_field_mapping.sql drizzle/meta/0020_snapshot.json
```

All three commands exited `0`.

- 0019 SQL baseline/HEAD blob: `b2acde07e631618394a32fae18e827c30eb9475b` / same.
- 0019 snapshot baseline/HEAD blob: `3f590f43688bdb9bfdf8bc94e20f3e41cdc34baa` / same.
- 0020 SQL baseline/HEAD blob: `5a4c1bad95b163bd0805e2dc1678aaf8ab581e3c` / same.
- 0020 snapshot baseline/HEAD blob: `b01570f3508912a7d40aae4d4538f316a5cf3d07` / same.

## Residual risks and handoff

- Honest legacy manual movements intentionally retain `reasonCode: null`; the read model falls back to their immutable legacy `reason` text.
- Unknown or missing legacy references intentionally return a static `UNAVAILABLE` descriptor with `href: null`; their raw IDs are not exposed as links.
- Stocktake batches currently resolve to an auditable plain descriptor with no route. Task 10 may present it in the movement workspace without inventing a route.
- Task 9 must supply structured codes/derived legacy labels for new writes and create stocktake batches transactionally; this task deliberately did not change those write paths.
