# Task 5 Report

- Boundary analyzed: Feishu cargo image persistence path from staged filesystem bytes under `CATALOG_ASSET_DIR`, through final content-addressed asset storage, into the authenticated `/api/catalog-assets/[assetId]` delivery route and the production Docker volume mounts shared by `web` and `worker`.
- Smallest safe change shipped: added one storage module (`src/modules/feishu/asset-storage.ts`) that owns magic-byte detection, Sharp-backed decode validation, path containment, digest-addressed staging/finalization, per-run byte caps, and controlled reads; added one route handler (`src/app/api/catalog-assets/[assetId]/route.ts`) that authorizes admin/customer access from DB asset IDs only; mounted one named volume (`tongzhouxing_shop_catalog_assets`) into both runtime services and created the writable runtime directory in `Dockerfile`.
- Threats addressed with direct evidence:
  - Path traversal / absolute-path / symlink escape: all temporary and final keys are regex-validated, resolved under `CATALOG_ASSET_DIR`, parent directories are `realpath`-checked, and unit coverage proves `runId`, `temporaryKey`, `storageKey`, and symlinked `temporary`/`sha256` directories are rejected.
  - MIME spoofing / unsupported content: stage+commit require real PNG/JPEG/WebP magic bytes and Sharp decode; mismatched declared MIME and SVG payloads are rejected by unit tests.
  - Decompression / oversized image abuse: single file size is capped at `8 MiB`, decoded pixel count at `25,000,000`, and one migration run at `1 GiB`; unit tests cover each limit.
  - Arbitrary file reads: the route never accepts a path, only a DB `catalog_assets.id`; customer access is constrained through `catalog_assets -> skus -> products -> customer_sku_prices`, while admins read by asset ID only.
  - Overwrite races / partial writes: staging and final writes use exclusive-create semantics (`fs.open(..., "wx")` / `writeFile(..., { flag: "wx" })`), reuse existing content-addressed files, and clean temporary paths on failure.
- Dependency note: `sharp` was promoted to an explicit root runtime dependency at version `0.35.3`, matching the version already present in the lock/runtime graph. This removes the transitive-runtime assumption from the shipped code path.

## TDD Evidence

### RED

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
```

Observed failures before implementation:

- `Cannot find package '@/modules/feishu/asset-storage'`
- `Cannot find package '@/app/api/catalog-assets/[assetId]/route'`

### GREEN

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
$env:APP_ENV_FILE='.env.example'; $env:POSTGRES_DB='tongzhouxing'; $env:POSTGRES_USER='tongzhouxing_app'; $env:POSTGRES_PASSWORD='replace-with-a-long-random-password'; docker compose -f compose.production.yaml config --quiet
git diff --check -- src/modules/feishu/asset-storage.ts src/app/api/catalog-assets/[assetId]/route.ts tests/unit/feishu/asset-storage.test.ts tests/integration/catalog/assets-route.test.ts Dockerfile compose.production.yaml
npm.cmd ls sharp --depth=0
```

Observed passes:

- `tests/unit/feishu/asset-storage.test.ts`: 9 passed
- `tests/integration/catalog/assets-route.test.ts`: 4 passed
- `typecheck`: passed
- `lint`: passed
- `docker compose ... config --quiet`: passed
- `git diff --check`: passed; only Git CRLF warnings remain on `Dockerfile` and `compose.production.yaml`
- `npm ls sharp --depth=0`: passed with direct root dependency `sharp@0.35.3`

## Validation Notes

- Normal path validated: valid PNG/JPEG/WebP bytes stage, dedupe, commit, and reopen correctly; admin and owning customer can fetch the exact bytes through the route with `Content-Type`, `Cache-Control`, and `X-Content-Type-Options: nosniff`.
- Failure path validated: unauthenticated route requests return `401`; non-owning customers receive `403`; unknown asset IDs return `404`; traversal, MIME spoofing, SVG, oversize files, oversized pixel grids, and symlink escapes are rejected.
- Recovery / rollback path validated: duplicate content safely reuses existing staged/final files, and `discardStagedAssets(runId)` removes staged run content without touching final assets.

## Residual Risk / Live Verification

- Compose validation required explicit environment variables on Thursday, August 13, 2026 because `compose.production.yaml` defaults to `.env.production`, which is intentionally absent in the worktree. A real deployment still needs one live `docker compose up` check to confirm the named volume is attached and writable by the unprivileged `nextjs` user inside both containers.
- The route currently trusts the DB MIME type for the response header after `openCatalogAsset()` revalidates the stored bytes. A broken DB row would still fail safe with `404`, but live observability for that case does not yet exist.

## Scope / Commit

- Modified: `src/modules/feishu/asset-storage.ts`, `src/app/api/catalog-assets/[assetId]/route.ts`, `tests/unit/feishu/asset-storage.test.ts`, `tests/integration/catalog/assets-route.test.ts`, `Dockerfile`, `compose.production.yaml`, `package.json`, `package-lock.json`
- Intentionally unchanged: `pnpm-lock.yaml`, `pnpm-workspace.yaml`, real Feishu integrations, and business import tables
- Commit: `31b897caf669e9c4951b05cafe837513d4358cd6`
- Commit message: `feat: store catalog images safely`
- Exact staged scope:
  - `Dockerfile`
  - `compose.production.yaml`
  - `package.json`
  - `package-lock.json`
  - `src/app/api/catalog-assets/[assetId]/route.ts`
  - `src/modules/feishu/asset-storage.ts`
  - `tests/integration/catalog/assets-route.test.ts`
  - `tests/unit/feishu/asset-storage.test.ts`

## Fix Round 1 (2026-08-13)

- Boundary re-checked: the same Task 5 path, with emphasis on the per-run quota control plane, final publish atomicity, customer-facing asset authorization, and Docker volume operability under the unprivileged runtime UID.
- Concrete issue/risk and evidence:
  - Per-run `1 GiB` enforcement was only a sum-then-write check, so two concurrent stages in the same migration run could both pass and overshoot the cap.
  - Final publish still had a time-of-check/time-of-use gap because readers and publishers worked from paths, not open handles, and the visible final path could be raced during promotion.
  - Customer reads were narrower than the actual customer catalog contract because the route required `customer_sku_prices`, and unauthorized or invisible assets returned distinguishable `403` vs `404`.
  - Docker volume sharing existed in config, but there was no executable proof that two runtime containers running as uid `1001` could both write/read the named asset volume.
- Smallest safe change preferred:
  - `src/modules/feishu/asset-storage.ts` now exposes a factory-backed storage module with a filesystem lock per `runId` under `CATALOG_ASSET_DIR/.locks/runs`, so quota accounting and staged writes are serialized across processes before bytes become visible.
  - Staged and final files are now written through hidden temp files plus `link()` publish, with no-overwrite semantics, cleanup on failure, and handle-based reads for commit/open paths.
  - `src/app/api/catalog-assets/[assetId]/route.ts` now treats customer visibility the same way as the customer catalog: any authenticated customer can read assets attached to `ACTIVE` products with `SELLABLE` SKUs, customer misses are unified to `404`, and the response `Content-Type` comes from verified file bytes instead of the DB row.
  - Added `scripts/verify-catalog-assets-volume.mjs` to build the runtime image, mount a unique temporary named volume, and verify two separate `uid=1001 gid=1001` containers can write/read the same `/app/data/catalog-assets` mount before cleaning the image and volume back up.

### RED

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
```

Observed failures before the fix:

- unit: concurrent quota/atomic publish coverage failed because the module had no factory for injected limits/hooks and still exposed path-based races.
- integration: customer-visible assets without `customer_sku_prices` returned `403`, other customers on active/sellable catalog entries returned `403`, and inactive/not-sellable cases were not uniformly hidden behind `404`.

### GREEN

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
$env:APP_ENV_FILE='.env.example'; $env:POSTGRES_DB='check'; $env:POSTGRES_USER='check'; $env:POSTGRES_PASSWORD='check'; docker compose -f compose.production.yaml config --quiet
node scripts/verify-catalog-assets-volume.mjs
git diff --check
```

Observed passes:

- `tests/unit/feishu/asset-storage.test.ts`: 13 passed, including the new concurrent quota race, same-digest concurrent commit, publish invisibility, and parent symlink escape cases.
- `tests/integration/catalog/assets-route.test.ts`: 6 passed, including customer-visible without customer-specific price, unified `404` for customer misses, and verified `Content-Type` from the stored bytes.
- `typecheck`: passed.
- `lint`: passed.
- `docker compose ... config --quiet`: passed when pointed at `.env.example` with placeholder Postgres vars.
- `node scripts/verify-catalog-assets-volume.mjs`: passed on Thursday, August 13, 2026. Evidence:
  - writer container: directory `/app/data/catalog-assets` and created file both reported owner `1001:1001`
  - second container: read the existing file and appended successfully, proving shared named-volume access under the unprivileged runtime UID

### Residual Risk / Limits

- This is the strongest boundary Node can realistically enforce from userspace: parent `realpath` checks, leaf `O_NOFOLLOW` where available, exclusive temp creation, and no-overwrite publish. It does not claim protection from a same-UID malicious local process that can race directory replacement outside what the host filesystem and Node APIs can atomically guarantee.
- The Docker verification script builds the full runtime image, so it is meaningful evidence for ownership/copy-up behavior, but it depends on local Docker availability and registry/network access in the execution environment.

### Fix Commit Scope

- Modified in this round:
  - `src/modules/feishu/asset-storage.ts`
  - `src/app/api/catalog-assets/[assetId]/route.ts`
  - `tests/unit/feishu/asset-storage.test.ts`
  - `tests/integration/catalog/assets-route.test.ts`
  - `scripts/verify-catalog-assets-volume.mjs`
- Intentionally unchanged in this round:
  - `.superpowers` content outside this report
  - `pnpm-lock.yaml`
  - `pnpm-workspace.yaml`
  - production volume names and runtime service topology in `compose.production.yaml`

## Fix Round 2 (2026-08-13)

- Boundary re-checked: the same Task 5 storage and delivery path, with the focus tightened to lease-based run locking, fallback publish semantics on filesystems without hard-link support, and directory-entry durability after publish and cleanup.
- Concrete issue/risk and evidence:
  - The first lock implementation only used the lock-directory `mtime`, so a live lock held longer than the stale TTL could be reclaimed incorrectly and break per-run quota serialization.
  - Final publish only supported `link()`, so filesystems without hard-link support would fail the commit path instead of publishing atomically.
  - Publish cleanup and final directory entries were not explicitly fsynced, leaving a durability gap after successful publish and temporary-file or claim-file cleanup.
- Smallest safe change preferred:
  - `src/modules/feishu/asset-storage.ts` now writes an owner-token lease file for each run lock, refreshes it on a heartbeat interval smaller than the stale TTL, and only releases a lock when the current lease token still matches the releasing owner. Stale reclaim moves the old lock directory out of the live path before cleanup, so a former owner cannot delete a newer lock instance.
  - Final publish still prefers `link()` when it works, but now falls back to a same-directory claim-file plus atomic `rename()` path when hard links are unsupported. This keeps the no-partial and no-overwrite guarantees inside the application boundary.
  - Final publish and cleanup now call `syncDirectory(...)` with observable `publish` and `cleanup` reasons. On Linux this must succeed; on non-Linux development hosts the implementation tolerates the platform-specific directory-fsync limitations that return `EINVAL`, `ENOTSUP`, `EPERM`, or `EISDIR`.

### RED

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
```

Observed failures before the fix:

- the new heartbeat test showed a second stage could still finish while the first stage kept the run lock longer than the stale TTL
- the stale-reclaim test showed a new owner could lose its lock while still holding it
- the directory-sync test showed no observable publish/cleanup sync events at all

### GREEN

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
$env:APP_ENV_FILE='.env.example'; $env:POSTGRES_DB='check'; $env:POSTGRES_USER='check'; $env:POSTGRES_PASSWORD='check'; docker compose -f compose.production.yaml config --quiet
node scripts/verify-catalog-assets-volume.mjs
git diff --check
```

Observed passes:

- `tests/unit/feishu/asset-storage.test.ts`: 18 passed, including:
  - live lock survives a stale-TTL window while heartbeat is active
  - stopped heartbeat can be reclaimed
  - the old owner finally block does not delete a newer owner’s live lock
  - fallback publish works when `link()` is injected to fail with `ENOTSUP`
  - directory sync is observed for both `publish` and `cleanup`
- `tests/integration/catalog/assets-route.test.ts`: 6 passed
- `typecheck`: passed
- `lint`: passed
- `docker compose ... config --quiet`: passed with `.env.example` and placeholder Postgres values
- `node scripts/verify-catalog-assets-volume.mjs`: passed again on Thursday, August 13, 2026

### Residual Risk / Limits

- The lock heartbeat now removes the false-stale condition that existed in the previous implementation, but it still does not claim protection from a same-UID malicious local process coordinating directory replacement outside the atomicity guarantees that Node and the underlying filesystem expose.
- The hard-link fallback is scoped to the application’s own coordination boundary. It prevents partial visibility and normal duplicate-write races, but it does not claim to serialize against arbitrary external writers that bypass the claim-file protocol.
- A live `docker compose up` against the real production env file remains deferred to Task 9. This round only preserves the existing compose topology and validates the image plus shared-volume runtime behavior through the isolated probe script.

## Fix Round 3 (2026-08-13)

- Boundary re-checked: the Task 5 asset-storage path from per-run staging lock acquisition through final publish fallback, including lease ownership, no-overwrite finalization, and the guarantee that the route only ever serves verified complete bytes.
- Concrete issue/risk and evidence:
  - The fallback publish path reused the same injected hard-link failure hooks during staging, so claim/heartbeat tests were exercising the wrong boundary and could deadlock before commit.
  - Claim-based publish needed the same owner-token lease discipline as run locks so a stale claim could be reclaimed without letting an old owner remove a new claim instance.
  - Stage and publish critical sections needed explicit lease-lost checks so a heartbeat write failure could stop the operation before persisting additional state.
- Smallest safe change preferred:
  - `src/modules/feishu/asset-storage.ts` now scopes hard-link fallback and claim hooks to final publish only. Staging keeps its per-run lock and uses same-root temp write plus controlled rename into the temporary key.
  - Final publish fallback now uses the leased-directory primitive for `*.claim` ownership, exclusive target creation and chunked writes with `assertHeld()` checks around the guarded steps, conflict verification on `EEXIST`, and cleanup that only removes a target created by the current owner.
  - Lease heartbeats now surface a lost-lease signal back into the active critical section, so both `stageCatalogAsset(...)` and fallback commit abort safely if renewal fails.

### RED

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
```

Observed failures before the fix:

- live claim and stale-claim reclaim tests timed out because the final-publish claim hooks were incorrectly firing during staging
- external target appearance was not preserved under fallback publish conflict handling
- partial-copy invisibility and claim lease-loss tests timed out because fallback coordination never reached the intended final-publish boundary

### GREEN

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
$env:APP_ENV_FILE='.env.example'; $env:POSTGRES_DB='check'; $env:POSTGRES_USER='check'; $env:POSTGRES_PASSWORD='check'; docker compose -f compose.production.yaml config --quiet
node scripts/verify-catalog-assets-volume.mjs
git diff --check
```

Observed passes:

- `tests/unit/feishu/asset-storage.test.ts`: 24 passed, including:
  - live claim survives the stale TTL while heartbeat is active
  - orphaned claim is reclaimable after heartbeat stop without letting the old owner delete the new claim
  - external target creation after claim acquisition is preserved and reported as a conflict
  - fallback copy never serves partial bytes through `openCatalogAsset(...)`
  - run-lease and claim-lease heartbeat write failures abort the active operation safely
- `tests/integration/catalog/assets-route.test.ts`: 6 passed on rerun after one transient auth-seeding failure in the integration environment
- `typecheck`: passed
- `lint`: passed
- `docker compose ... config --quiet`: passed with `.env.example` and placeholder Postgres values
- `node scripts/verify-catalog-assets-volume.mjs`: passed on Thursday, August 13, 2026. Evidence:
  - writer container: `/app/data/catalog-assets` and the created probe file both reported owner `1001:1001`
  - second container: read and appended the same file successfully on the shared named volume

### Residual Risk / Limits

- The implementation now enforces the strongest boundary Node can realistically provide here: parent-root containment, leaf `O_NOFOLLOW` where available, owner-token leases with heartbeat/reclaim, exclusive target creation, and post-publish verified reads. It still does not claim protection from a same-UID malicious local process that can replace directories outside the filesystem atomicity Node exposes.
- The fallback copy path is intentionally scoped to "never served partial" rather than "partial target can never transiently exist". If a write is interrupted after exclusive target creation, the current owner removes the partial file before release, and readers continue to reject integrity failures as `404` through the route layer.

## Fix Round 4 (2026-08-13)

- Boundary re-checked: the Task 5 asset-storage lease path only, specifically `stageCatalogAsset(...)` temporary publish under the per-run lease and fallback final publish under the claim lease in `src/modules/feishu/asset-storage.ts`.
- Concrete issue/risk and evidence:
  - Fallback publish cleanup still deleted by bare `targetPath` after `targetCreated`, so a later failure could remove a file that no longer belonged to the failing owner.
  - Temporary staging only asserted the run lease before entering `publishBytesAtomically(...)`, so a heartbeat failure during temp-file writes could still finish the write/rename path and count bytes for a worker that no longer owned the run.
- Smallest safe change preferred:
  - `publishBytesAtomically(...)` now accepts a step guard and uses chunked exclusive writes so the run lease is checked before writes, between chunks, after fsync, before rename/link, and before returning success. `stageCatalogAsset(...)` passes the live run-lease assertion through that entire path.
  - Fallback publish now records the created target file identity from the open handle and only unlinks on failure when both conditions hold: the claim lease is still held and the current path still resolves to the same file identity. If either proof fails, cleanup leaves the path alone for the current owner or later scavenging.
  - Added two fault-injection hooks used only by unit tests: one to pause temporary-file writes and one to simulate replacement just before fallback cleanup. No route or Docker behavior changed in this round.

### RED

Command:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
```

Observed failures before the fix:

- `does not publish or retain temp bytes after a run lease is lost mid-write and another worker reclaims the run`: timed out because staging had no mid-write lease checkpoint to stop the first writer and unblock the reclaimer cleanly.
- `does not delete a replacement target after the claim lease is lost`: failed because fallback cleanup still reached the bare path and the replacement-target hook never had a defended ownership boundary to preserve.
- the self-cleanup regression initially tripped staging's publish fsync hook too early, which confirmed the test had to be narrowed to the final `sha256` directory only.

### GREEN

Commands:

```powershell
npm.cmd test -- tests/unit/feishu/asset-storage.test.ts
npm.cmd run test:integration -- tests/integration/catalog/assets-route.test.ts
npm.cmd run typecheck
npm.cmd run lint
git diff --check
```

Observed passes:

- `tests/unit/feishu/asset-storage.test.ts`: 27 passed, including the new run-lease mid-write reclaim case, the replacement-target preservation case, and the same-owner cleanup regression.
- `tests/integration/catalog/assets-route.test.ts`: 6 passed.
- `typecheck`: passed.
- `lint`: passed.
- `git diff --check`: passed; only Git's existing CRLF conversion warnings were emitted for the edited files.

### Residual Risk / Live Verification

- The cleanup proof is intentionally conservative: if lease ownership or file identity cannot be proven, cleanup now skips deletion and leaves the orphan for the current owner or later reclamation. That is the smallest safe choice inside Node's filesystem guarantees.
- This round did not rerun Docker validation because no container or compose files changed. The previously validated image/volume behavior remains the latest container evidence for Thursday, August 13, 2026.
