# Cloud Core — Deep Reference

Companion to [`packages/cloud-core/CLAUDE.md`](../packages/cloud-core/CLAUDE.md).
This file holds the multi-paragraph detail that would otherwise inflate the guide
past its character budget. Invariants and safety rules stay in the guide; expansions
live here.

## <a name="e2b-substrate"></a>e2b substrate — timeouts and template filtering

`src/substrates/e2b.ts` pins `requestTimeoutMs` to 120s so Cloudflare Workers do
not abort cold-start restores under their 30s subrequest timeout — resume
operations reconnect to a paused sandbox and can exceed the default budget on
first byte.

`list` filters team sandboxes by template alias via the exported
`isSliccTemplate` predicate. The match is a `slicc` **prefix**, not an equality
check, so isolated test-template cones (`slicc-test`) list as SLICC-owned
instead of surfacing as `dead` in the reconciliation pass in `listCones`.

The template image itself is defined in `packages/dev-tools/e2b-template/`.
Cloud-core orchestrates it but does not build it; template changes are shipped
independently and pinned by alias.

## <a name="stable-contracts"></a>Stable Contracts — rationale

### `ConeEntry.state = 'reserved'`

`'reserved'` is the in-flight placeholder used during start/resume to hold a cap
slot before the substrate reports real state. The worker's
`CloudSessionsDurableObject` calls `reserveSlot` under `blockConcurrencyWhile`
so per-user concurrency caps are enforced against a single serialized view of
the registry, then completes the substrate call outside the critical section.
`listCones` GCs `reserved` entries older than 10 minutes (`reservedAt`) so a
crashed start attempt eventually frees its slot.

### `trayId` + `lastJoinUpdatedAt` preservation on pause

`startCone` reads `/tmp/slicc-join.json` from the sandbox and records the
`trayId` and the `updatedAt` timestamp of that read into the registry as
`lastJoinUpdatedAt`. `pauseCone` must not overwrite either field — it just
transitions `state` to `'paused'`.

`resumeCone` reconnects to the paused sandbox, posts to
`/api/leader-restart` on the hosted node-server, then polls
`/tmp/slicc-join.json` via `pollForRefreshedStatus`, which only returns success
when the file's `updatedAt` is strictly newer than the baseline. Without
preservation, the baseline would be reset on pause and every resume would
succeed instantly against a stale join URL — the follower would still be
pointed at the pre-pause tray, silently.

### `/tmp/slicc-join.json` as IPC channel

The hosted node-server writes this file from its `/api/cloud-status` POST
handler (see `packages/node-server/src/cloud-status.ts`). Cloud-core reads it
back through the substrate's `readFile`. The shape is `CloudStatus` in
`src/types.ts`. Because the file is written into the template image at build
time, `pollCloudStatus` uses `minUpdatedAt` on the start path to ignore that
template-baked file until the hosted node-server has written a fresh one.

### Registry persistence schema

Both `FileRegistry` (`~/.slicc/cloud-sessions.json`) and `LocalRegistry`
(DurableObject storage) persist `{ sessions: ConeEntry[] }`. The `sessions`
field name is a legacy carry-over from before the "cone" rename — CLI files
already on disk use it, so it stays. `append` is upsert-by-`sandboxId`, not
insert-or-throw; `listCones`'s reconciliation pass depends on this to fold
substrate-reported state back into the registry without duplicating rows.

## <a name="secrets"></a>Secret injection paths

The user's substrate credential (`E2B_API_KEY`, and optionally
`E2B_API_KEY_DOMAINS`) belongs to the substrate client, not the workload.
`filterSecretsEnv` in `src/secrets-filter.ts` strips both from the env bag
before it is uploaded into the sandbox at start/resume, so the cone never sees
the credential that could spawn or kill other sandboxes on the same team.

Everything else in the env bag is forwarded as-is; consumers layer their own
policy on top (the worker only accepts explicitly listed variables from the
user; the CLI forwards the caller's shell env). Adjustments to the strip list
should be made here — not in a consumer — so both consumers stay in sync.

## <a name="hosted-leader-boot"></a>Hosted-leader boot sequence

1. Consumer calls `startCone`; `reserveSlot` writes a `'reserved'` row.
2. `SandboxSubstrate.create` provisions an e2b sandbox from the SLICC template.
3. cloud-core uploads filtered env and starts `node-server --hosted`.
4. The hosted node-server writes `/tmp/slicc-join.json` from its
   `/api/cloud-status` POST once its tray-hub handshake completes.
5. `pollCloudStatus` reads the file with `minUpdatedAt` set to the reservation
   time, so the template-baked copy is ignored.
6. `startCone` writes `trayId` + `lastJoinUpdatedAt` into the registry and
   flips `state` from `'reserved'` to `'running'`.

Resume follows the same shape without provisioning: reconnect, kick
`/api/leader-restart`, poll for strictly-newer `updatedAt`.
