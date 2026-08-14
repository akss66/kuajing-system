# Task 9 implementation report

## Outcome and scope

- Replaced the manual signed-delta/free-text command with an administrator-only direction plus positive integer quantity and a single typed reason matrix.
- Added stable server defaults: increase uses `RESTOCK_RECEIPT` (`补货入库`); decrease uses `OFFLINE_FULFILLMENT` (`线下发货/人工出库`). Direction-incompatible, stocktake-only, system shipment, reversal, and Feishu import codes are rejected at the Server Action and transaction service boundaries.
- The server derives the signed delta and immutable legacy reason label. User text is trimmed and stored only in nullable `remark`.
- Preserved the existing balance `FOR UPDATE` path and active-reservation recalculation. Concurrent reservation/decrease and stocktake-below-locked tests prove `afterTotal >= locked` remains authoritative inside the transaction.
- Added secondary set-to-actual stocktakes. A changed value creates exactly one stocktake batch, one linked movement, and one audit record in the same transaction; an unchanged value returns `NO_CHANGE` and writes nothing.
- Removed only the inventory adjustment call/import for `enqueueCargoSyncEvent`. Other order, replacement, fulfillment, and Feishu outbox behavior remains intact.
- Added only `reasonCode: "SYSTEM_SHIPMENT"` to the existing automatic shipment movement insert. Shipment type/source/reference, deduction amount, reservation consumption, idempotency, order transitions, notifications, audit, and outbox behavior were not changed.
- Narrowed Server Action error handling: only known insufficient-inventory errors produce the locked-stock message, known missing/invalid inventory errors receive safe bounded messages, and unknown database/runtime failures are rethrown to the application's existing error boundary instead of being misreported.
- Did not modify schema/migrations, read models, UI, Feishu integration implementation, Jifeng authorization/transitions, settlement, permissions, production configuration/database, or deployment.

## Witnessed RED → GREEN

### RED before implementation

```powershell
npm.cmd test -- tests/unit/inventory/actions.test.ts
```

Exit code `1`: 1 file failed, 16/16 tests failed. Failures showed the old `delta`/`reason` parser, absent shared direction/reason/default/label contract, absent stocktake action, and absent remark normalization.

```powershell
npm.cmd run test:integration -- --no-file-parallelism tests/integration/inventory/concurrency.test.ts tests/integration/fulfillment/status-sync.test.ts
```

Exit code `1`: 2 files failed, 6 tests failed and 6 passed. The old service rejected the new directional command, set-to-actual did not exist, and automatic shipment movements still returned `reasonCode: null`.

A self-review follow-up added RED coverage for error classification. The focused unit command then exited `1` with 2 failures and 19 passes because both unknown adjustment and stocktake database errors were incorrectly returned as locked-stock messages. The minimal type-specific catch branches made both tests green.

### GREEN after minimal implementation and coverage completion

```powershell
npm.cmd test -- tests/unit/inventory/actions.test.ts
```

Exit code `0`: 1 file passed, 21/21 tests passed. Coverage includes both defaults, exact matrix/labels, every prohibited manual system/stocktake code, positive safe integer parsing, remark trimming/empty normalization, stocktake-only parsing, invalid stocktake inputs, no-change messaging, both revalidation targets, and safe known-vs-unknown error classification.

```powershell
npm.cmd run test:integration -- --no-file-parallelism tests/integration/inventory/concurrency.test.ts tests/integration/fulfillment/status-sync.test.ts
```

Exit code `0`: 2 files passed, 13/13 tests passed. Coverage includes manual structured writes, admin/manual source metadata, no order reference for offline fulfillment, real row-lock concurrency, locked-stock rejection for decrease and stocktake, atomic stocktake linkage, no-change zero writes, zero inventory-to-Feishu enqueue calls, and automatic shipment metadata/idempotency.

```powershell
npm.cmd run test:integration -- --no-file-parallelism tests/integration/fulfillment/replacement.test.ts tests/integration/feishu/outbox.test.ts
```

Exit code `0`: 2 files passed, 17/17 tests passed. Replacement and legitimate outbox paths remain green.

```powershell
npm.cmd run typecheck
npx.cmd eslint src/modules/inventory/types.ts src/modules/inventory/service.ts src/modules/inventory/actions.ts src/modules/fulfillment/status-sync.ts tests/unit/inventory/actions.test.ts tests/integration/inventory/concurrency.test.ts tests/integration/fulfillment/status-sync.test.ts
git diff --check
```

All commands exited `0`.

Protected migration checks against `e917031` for 0019 and `ce04ff2` for 0020 both exited `0`. No `FEISHU_CARGO_WRITES_ENABLED` or `cargoWritesEnabled` line changed.

## Fulfillment boundary inspection

`git diff -- src/modules/fulfillment/status-sync.ts` contains exactly one production line:

```ts
reasonCode: "SYSTEM_SHIPMENT",
```

The incumbent movement remains `SHIPMENT + SYSTEM + ORDER_SHIPMENT`, and the existing repeated status-7 call still returns `ALREADY_SHIPPED` without another balance change or movement.

## Residual risks and Task 10 handoff

- The currently rendered inventory form still submits the legacy `delta`/free-text fields. Task 10 must switch it to the new direction/quantity/reason-code contract and wire the new stocktake action before the branch is user-ready.
- `src/modules/inventory/read-model.ts` already contains matching structured display labels from Task 8. Task 10 should import the shared Task 9 matrix/defaults for form options and must not create a third copy.
- Stocktake batches intentionally have no invented detail route; Task 8 returns an allowlisted plain relation descriptor.
- No production deployment, push, merge, external write, or Feishu source operation occurred.
