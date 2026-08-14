# Task 10 implementation report

## Outcome and scope

- Rebuilt inventory as exactly two URL-backed first-level views: `实时库存` and `库存流水`. There is no `批量盘点` tab and the old eight-row recent-movement substitute was removed.
- Kept the live-inventory health/low-stock context, then placed one row-scoped `+ / - 调整` control on every desktop row and mobile card.
- Replaced signed free text with direction plus positive integer quantity. The client imports `MANUAL_INVENTORY_REASON_CODES`, `DEFAULT_MANUAL_INVENTORY_REASON`, and `inventoryReasonLabel` from Task 9; it does not duplicate the reason matrix.
- Added the six-fact live preview: before total, signed delta, after total, order locked, current available, and after available. Decreases/stocktakes below locked inventory are announced inline and disabled client-side while the Task 9 server transaction remains authoritative.
- Shows the approved offline-fulfillment warning verbatim whenever `OFFLINE_FULFILLMENT` is selected.
- Keeps `设置为实际库存` inside the row drawer as a low-frequency secondary mode. An unchanged actual count visibly states `无变化，不生成库存流水` and disables submission.
- Added full movement filters, reset, deterministic page links, semantic wide-screen table, and mobile cards with the same before/delta/after, reason, remark, operator, source, time, and allowlisted relation facts. `系统订单自动发货` and `线下发货/人工出库` remain visibly distinct.
- The Server Component page reads canonical Next 16 async `searchParams`, validates filter enums/dates/pages, loads Task 8 snapshot/movement DTOs, and passes only serializable dates to the client boundary.
- Did not modify schema/migrations, read models, inventory service/actions, fulfillment/Jifeng transitions, permissions/audit, Feishu integration, globals/fonts, production configuration, or deployment.

## Skill and installed-framework influence

- Impeccable classified this as an existing **Operate** surface. Its context/polish/craft-floor guidance kept the incumbent restrained merchant-center visual system, semantic tokens, compact data alignment, flat surfaces, and one bounded self-review rather than introducing gradients, page fonts, decorative animation, or nested card styling.
- Frontend UI Engineering drove separate wide semantic tables and narrow task-ordered cards, native labels/controls, 44px primary targets, meaningful empty/disabled/error states, and URL state for shareable filters/pagination.
- Test-Driven Development and writing-good-tests guidance kept tests behavior-focused and DAMP: tests assert user-visible facts, semantic roles, exact warnings/defaults, canonical links, and responsive structure rather than implementation calls.
- The installed Next 16 page/server-client/forms/server-actions/cache/revalidation/testing/CSS guidance determined async `searchParams`, server-side database loading, serializable Client Component props, native GET filters, and reuse of the existing Server Actions with React form state.
- Per the Task 10 brief, the final Impeccable detector was intentionally not run; Task 11/whole-branch verification owns its single pass after all UI changes are complete.

## Witnessed RED → GREEN

### RED before implementation

```powershell
npm.cmd test -- tests/unit/inventory/inventory-workspace.test.tsx
```

Exit code `1`: 1 file failed, 4/4 tests failed. The old workspace still required `recentMovements`, had no two-view props, rendered the bottom-eight substitute, and lacked the row-scoped directional/preview/movement contracts.

### GREEN after minimal implementation and bounded refinement

```powershell
npm.cmd test -- tests/unit/inventory/inventory-workspace.test.tsx tests/unit/ui/management-primitives.test.tsx
```

Exit code `0`: 2 files passed, 11/11 tests passed. Coverage includes exactly two tabs/no third tab, no recent-eight region, row-scoped drawer, shared increase/decrease defaults/options, positive integer attributes, all six preview facts, locked-stock inline rejection, exact offline warning, secondary stocktake/no-change state, all canonical filters, reset, pagination, automatic/manual source distinction, semantic table, mobile fact parity, and drawer focus/touch primitives.

```powershell
npm.cmd run typecheck
npm.cmd exec eslint -- 'src/app/(admin)/admin/inventory/page.tsx' 'src/components/inventory/inventory-workspace.tsx' 'src/components/inventory/inventory-results.tsx' 'src/components/inventory/inventory-adjustment-drawer.tsx' 'src/components/inventory/inventory-movements-view.tsx' 'src/components/inventory/inventory-adjustment-preview.tsx' 'tests/unit/inventory/inventory-workspace.test.tsx'
git diff --check
```

All commands exited `0`.

## Residual risks and Task 11 handoff

- Component tests prove DOM semantics and responsive table/card separation, but real 1440/1920/430/390/360 layout, keyboard completion, axe, console/hydration, page overflow, filter navigation, and unmasked screenshots remain Task 11 acceptance work.
- Stocktake batch relations intentionally remain plain allowlisted labels because Task 8 exposes no invented stocktake detail route.
- No production deployment, push, merge, external write, or Feishu source operation occurred.

## Fix Round 1 — business-time date boundaries

Independent review found that the first implementation interpreted date-filter days as UTC while rendering movement timestamps in Toronto time, and JavaScript date normalization could accept impossible calendar dates.

RED added direct pure-function coverage for Toronto summer and winter offsets plus strict invalid input. After isolating the Server Page's data imports, the focused test exited `1` with 1 failure and 4 passes because `inventoryDateBoundary` did not exist.

The minimal fix exports `inventoryDateBoundary`, parses strict `YYYY-MM-DD` values with Luxon in the shared `BUSINESS_TIME_ZONE`, rejects normalized/impossible dates, and returns the Toronto `startOf("day")` or `endOf("day")` instant. The movement formatter now imports that same shared time-zone token instead of repeating a raw zone string.

GREEN evidence after the fix:

```powershell
npm.cmd test -- tests/unit/inventory/inventory-workspace.test.tsx
```

Exit code `0`: 1 file passed, 5/5 tests passed. Exact assertions include summer start `2026-08-14T04:00:00.000Z`, summer end `2026-08-15T03:59:59.999Z`, winter start `2026-01-14T05:00:00.000Z`, and rejection of `2026-02-31` plus wrong-format input.
