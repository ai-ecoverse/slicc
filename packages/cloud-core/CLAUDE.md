# CLAUDE.md

This file covers the shared cloud orchestration core in `packages/cloud-core/`.

## Scope

`@slicc/cloud-core` is the platform-agnostic library that owns the lifecycle of cloud-hosted cones: starting, listing, pausing, resuming, and killing remote sandboxes that run the SLICC node-server in hosted-leader mode.

It has **two consumers**:

- `packages/node-server/src/cloud/` — the laptop-side `slicc --cloud start/list/pause/resume/kill` CLI subcommands. Each `node-server/src/cloud/<op>.ts` is a thin adapter that wires `FileRegistry` (backed by `~/.slicc/cloud-sessions.json`) and the e2b substrate to the matching cloud-core operation.
- `packages/cloudflare-worker/src/cloud/` — the Plan D web feature at `sliccy.ai/cloud`. The `CloudSessionsDurableObject` wraps the same operations with a `LocalRegistry` (DurableObject storage) and per-user authorization.

Code that touches sandbox lifecycle belongs here, not in either consumer. Adapter glue (file IO, DurableObject storage, HTTP plumbing, auth) stays in the consumer.

## Architecture

```text
[CLI: slicc --cloud …]             [Worker: sliccy.ai/cloud]
  node-server/src/cloud/             cloudflare-worker/src/cloud/
        │                                    │
        ▼                                    ▼
   ┌────────────────────────────────────────────────┐
   │            @slicc/cloud-core                   │
   │                                                │
   │  operations/  ── start / list / pause /        │
   │                  resume / kill                 │
   │  substrate.ts ── SandboxSubstrate interface    │
   │  substrates/  ── e2b.ts (only impl today)      │
   │  registry.ts  ── Registry interface            │
   │  polling.ts   ── pollCloudStatus / refresh     │
   │  types.ts     ── ConeEntry, CloudStatus, …     │
   │  errors.ts    ── CloudError + stable codes     │
   │  secrets-filter.ts ── strip E2B_API_KEY        │
   └────────────────────────────────────────────────┘
```

## Build and Test Commands

```bash
npm run build -w @slicc/cloud-core   # tsc -p tsconfig.json → dist/
npm run test  -w @slicc/cloud-core   # vitest run
npm run typecheck                    # included in root pipeline
```

`postinstall` builds `@slicc/cloud-core` before anything that imports it (mirrors `@slicc/shared-ts`).

## Key Files

| Path                       | Purpose                                                                                                                                                                                                                                                                                                                                                |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/index.ts`             | Public re-exports — the only surface consumers should import from                                                                                                                                                                                                                                                                                      |
| `src/types.ts`             | `ConeEntry` (registry row), `CloudStatus` (`/tmp/slicc-join.json` shape), `StartResult`, `ResumeResult`, `SandboxSummary`                                                                                                                                                                                                                              |
| `src/errors.ts`            | `CloudError` + `CloudErrorCode` union. Workers translate codes to HTTP statuses; CLI prints them. Stable contract — adding codes is fine, renaming/removing is breaking                                                                                                                                                                                |
| `src/substrate.ts`         | `SandboxSubstrate` interface (`create`, `connect`, `list`, `extendTimeout`), `SandboxHandle` (`pause`, `kill`, `getInfo`, `writeFile`, `readFile`, `run`), and supporting types                                                                                                                                                                        |
| `src/substrate-factory.ts` | `createSubstrate(id, cfg)` — the only place that maps a `SubstrateId` to a concrete impl. `SubstrateId = 'e2b'` today; widen the union when a real second substrate lands                                                                                                                                                                              |
| `src/substrates/e2b.ts`    | The e2b implementation. Pins `requestTimeoutMs` to 120s so CF Workers don't abort cold-start restores under their 30s subrequest timeout. `list` filters team sandboxes by template alias via the exported `isSliccTemplate` predicate — a `slicc` **prefix** match, so isolated test-template cones (`slicc-test`) list too instead of showing `dead` |
| `src/registry.ts`          | `Registry` interface. Two implementations live with their consumers: `FileRegistry` (node-server, `~/.slicc/cloud-sessions.json`) and `LocalRegistry` (worker, DurableObject storage)                                                                                                                                                                  |
| `src/polling.ts`           | `pollCloudStatus` (start path — uses `minUpdatedAt` to ignore the stale template-baked file) and `pollForRefreshedStatus` (resume path — requires strictly newer `updatedAt`)                                                                                                                                                                          |
| `src/secrets-filter.ts`    | `filterSecretsEnv` — strips `E2B_API_KEY` / `E2B_API_KEY_DOMAINS` before upload. The cone never sees the user's substrate credential                                                                                                                                                                                                                   |
| `src/operations/start.ts`  | `startCone` + `reserveConeStart` (worker atomically records an in-flight named start under `blockConcurrencyWhile`, then performs slow sandbox creation outside the lock)                                                                                                                                                                              |
| `src/operations/list.ts`   | `listCones` — reconciles registry against substrate.list, GCs stale `reserved` entries (10-minute TTL)                                                                                                                                                                                                                                                 |
| `src/operations/pause.ts`  | `pauseCone` — preserves `trayId` + `lastJoinUpdatedAt` (resume needs them as a freshness baseline)                                                                                                                                                                                                                                                     |
| `src/operations/resume.ts` | `resumeCone` — reconnects, posts `/api/leader-restart`, polls until `updatedAt > baseline`                                                                                                                                                                                                                                                             |
| `src/operations/kill.ts`   | `killCone` — idempotent removal                                                                                                                                                                                                                                                                                                                        |

## Stable Contracts

The fields and behaviors below are load-bearing for both consumers; changes need migration thought.

### `ConeEntry.state`

`'running' | 'paused' | 'dead' | 'reserved'`.  
`'reserved'` is an in-flight placeholder used during start/resume to prevent duplicate coordination on the same name/operation before the substrate reports real state. `listCones` GCs `reserved` entries older than 10 minutes (`reservedAt` field).

### `ConeEntry.trayId` and `lastJoinUpdatedAt`

Set by `startCone` after the initial `/tmp/slicc-join.json` read. `pauseCone` **must preserve** them — `resumeCone` polls for `updatedAt` strictly newer than `lastJoinUpdatedAt`, so resume only declares success after the leader-restart kick produced a fresh refresh. Overwriting these on pause would make every resume succeed instantly against the old join URL.

### `/tmp/slicc-join.json`

The shape persisted inside the sandbox by `node-server --hosted`'s `/api/cloud-status` POST. Defined as `CloudStatus` in `src/types.ts`. Used as the IPC channel between the hosted node-server and the orchestrating cloud-core. Changes here are coordinated with `packages/node-server/src/cloud-status.ts`.

### Registry persistence schema

`Registry` implementations persist `{ sessions: ConeEntry[] }` (the legacy field name `sessions` is kept for CLI files already on disk — do not rename to `cones`). `append` is upsert-by-`sandboxId`, not insert-or-throw; reconciliation passes depend on this.

## Substrate Authoring

To add a new substrate (e.g., Modal, Fly, Daytona):

1. Implement `SandboxSubstrate` in `src/substrates/<name>.ts` against the existing interface — `create`, `connect`, `list`, `extendTimeout`, plus the `SandboxHandle` ops.
2. Add the literal to `SubstrateId` in `src/substrate.ts` and the dispatch arm in `src/substrate-factory.ts`.
3. The five operations under `src/operations/` are substrate-agnostic; they should not need changes.
4. Update both consumers' `--cloud` / `?substrate=` dispatch to expose the new ID.

`extendTimeout` is allowed to be a no-op for substrates without an auto-pause concept.

## Test Conventions

- `tests/fixtures/fake-substrate.ts` is an in-memory `SandboxSubstrate` exported via the package's `./tests/fake-substrate` subpath. Both consumers reuse it for their own integration tests.
- `tests/fixtures/mem-registry.ts` is the matching in-memory `Registry`.
- Tests pin operation behavior (name conflicts, reservation GC, freshness-poll semantics, e2b API-key filtering). These are the reasons doc above calls out "load-bearing" fields.

## Related Guides

- `packages/node-server/CLAUDE.md` — CLI `--cloud` subcommands (the adapter layer)
- `packages/cloudflare-worker/CLAUDE.md` — `sliccy.ai/cloud` web feature (the other adapter layer)
- `packages/dev-tools/e2b-template/` — the sandbox image cloud-core orchestrates
