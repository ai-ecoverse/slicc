# CLAUDE.md

This file covers the GitHub Actions package in `packages/github-workflow/`.

## Scope

Runs a SLICC **hosted leader** on a GitHub Actions runner and drives it with the Go `slicc` follower CLI. It is the CI-runner analogue of the e2b cloud float: the same `node-server --hosted` boot (headless Chrome against the hosted UI origin, join URL published via `/tmp/slicc-join.json`) and the same credential seeding (`/slicc/cone-config.json` + `secrets.env`), but on a runner the job owns for its lifetime instead of a sandbox cloud-core manages.

Two surfaces:

- **Composite actions** in `actions/<name>/action.yml`, each a thin `env` mapping over one script in `scripts/`. Consumers reference them as `ai-ecoverse/slicc/packages/github-workflow/actions/<name>@<ref>`.
- **Reusable workflows** in `.github/workflows/slicc-*.yml` (`workflow_call`) that compose the actions: `slicc-leader.yml` (boot + hold + optional prompt/inject/mount/export/follow), `slicc-prompt.yml`, `slicc-exec.yml`, `slicc-vfs-read.yml`, `slicc-vfs-write.yml`, `slicc-follower.yml`.

**Not an npm workspace.** Consumers run the scripts from a bare checkout of this directory, so `scripts/` must stay dependency-free (Node built-ins only). Tests run under the `github-workflow` vitest project from the repo root.

## Layout

| Path                                   | Purpose                                                                                                                 |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `scripts/lib.mjs`                      | Pure helpers: duration/port/mount parsing, cone-config + `secrets.env` validation, join-file parsing, command builders  |
| `scripts/gh-io.mjs`                    | Runner I/O: `INPUT_*` reads, `$GITHUB_OUTPUT`/`$GITHUB_ENV`/`$GITHUB_PATH`, masks, state file, liveness, `execOnLeader` |
| `scripts/start-leader.mjs`             | Install `sliccy`, write credential files, spawn `node-server --hosted`, poll the join file, record state                |
| `scripts/wait-for-deadline.mjs`        | Hold the job until the deadline; fail fast when a watched pid dies                                                      |
| `scripts/stop-leader.mjs`              | Followers → node-server → leftover Chrome; always exits 0; prints log tails                                             |
| `scripts/install-cli.mjs`              | Token-authenticated release scan for `slicc-<os>-<arch>`; exports `SLICC_CLI`                                           |
| `scripts/slicc-run.mjs`                | `prompt` / `exec` with timeout, output file, truncated step output                                                      |
| `scripts/vfs-file.mjs`                 | Byte-exact read/write of one VFS file over base64                                                                       |
| `scripts/inject-files.mjs`             | tar+gzip a runner directory, unpack on the leader in one exec                                                           |
| `scripts/follow.mjs`                   | Detached `slicc … follow <runner>`; records the pid for keep-alive/stop                                                 |
| `scripts/export-session.mjs`           | `session export` on the leader, then copy the ZIP back                                                                  |
| `actions/*/action.yml`                 | One composite action per script (plus `keep-alive` over `wait-for-deadline.mjs`)                                        |
| `tests/fixtures/`, `tests/helpers.mjs` | Fake `slicc` CLI + fake node-server + per-test env scaffolding (excluded from coverage)                                 |

## Build and Test

```bash
npx vitest run --project github-workflow      # unit + fake-CLI tests
npm run test:coverage:github-workflow         # same, with the coverage floors from coverage-thresholds.json
actionlint .github/workflows/slicc-*.yml .github/workflows/github-workflow-smoke.yml
npm run lint                                  # biome (.mjs) + prettier (yml/md)
```

Tests are co-located `scripts/*.test.mjs`. `lib.test.mjs` is pure; every other script is driven through its exported `main()` against `tests/fixtures/fake-slicc.mjs` (a stand-in for the Go CLI that keeps a fake VFS and understands the exact command shapes `lib.mjs` builds, plus probes that force dial failures, non-zero exits, and slow turns) and `tests/fixtures/fake-node-server.mjs` (writes the join file, or exits / never writes / writes a stale one). `tests/helpers.mjs` gives each test an isolated `$SLICC_GW_HOME`, the three GitHub command files, and the two path seams (`SLICC_GW_JOIN_FILE`, `SLICC_GW_CONE_CONFIG_PATH`) so nothing touches `/tmp/slicc-join.json` or `/slicc`.

Coverage is gated in CI (`github-workflow` job) with an explicit `coverageInclude` so a script without a test counts as 0% instead of disappearing from the report. Only the `isMain` trampolines are `v8 ignore`d — they are unreachable in-process by construction. Floors are ratcheted by the nightly `coverage-ratchet.mjs` like every other package; never hand-lower them.

The live gate is `.github/workflows/github-workflow-smoke.yml`: it boots a real leader from the published `sliccy` package against production sliccy.ai, builds the Go CLI from the checkout (`install-cli` with `source: build`, so a CLI fix is exercised before it is released) and exercises every action (the prompt legs use the repo's Bedrock key through `bedrock-camp`, so they run only for same-repo heads), then runs `slicc-leader.yml` at the PR's ref. It runs on PRs touching this package or the `slicc-*.yml` workflows and needs network egress.

## Design Rules

- **Existing mechanisms only.** Credentials go through the cone-config bundle and `secrets.env` exactly as cloud-core writes them; files enter the VFS over the tray exec channel; mounts use node-server's `--mount` table. Nothing here adds a node-server endpoint.
- **Pure vs I/O split.** Anything decidable without a runner lives in `lib.mjs` with a unit test. Scripts do I/O, export their `main()` and helpers, and only run behind `isMain(import.meta.url)`, so tests import them without side effects. Injection points (`exec`, `fetchImpl`, `isAlive`, `pollMs`) are options on `main`, never globals.
- **The join URL is a capability.** `start-leader` masks it by default (`::add-mask::`); every CLI action re-masks the value it receives. It is never a job output: outputs are readable only after the job (and its leader) ended. Cross-job use goes through a `SLICC_JOIN_URL` secret or, with `mask-join-url: false`, the `<artifact-prefix>-join` artifact uploaded while the leader runs — documented, never the default.
- **Credentials never reach node-server's environment.** `buildLeaderEnv` strips every `INPUT_*` variable and the preboot `*_B64` bundles before spawning; the bundle is on disk with mode 0600 only.
- **Two `slicc` binaries.** The npm `sliccy` package installs a `slicc` bin (node-server); the Go follower is also `slicc`. `install-cli` installs the Go binary into a private dir and exports `SLICC_CLI`; scripts call that path, never bare `slicc`.
- **Composite actions have no `post:`.** Teardown is the explicit `stop-leader` action under `if: always()`; `keep-alive` is what keeps the job (and therefore the detached leader) alive.
- **Preserve lifecycle state.** `state.json` holds the leader pid, credential path, Chrome profile, and follower pids. `readState` returns `null` only for a missing file and surfaces other read/parse failures; `writeState` replaces the file by same-directory rename so `follow` never folds a failed or partial read into a follower-only state.
- **Byte-exact file transfer is base64 both ways.** The exec channel carries stdin as bytes but streams stdout as text.
- **Dial failures retry, executions never do.** The CLI reports a failed WebRTC dial (`tray connect timed out`) before anything reaches the leader, so `execOnLeader` and `slicc-run` retry those up to three times; any other non-zero status is final, because the command may have run.
- **Hard-coded paths belong to node-server.** `/slicc/cone-config.json` and `/tmp/slicc-join.json` are read/written by `packages/node-server/src/hosted-bootstrap.ts` and `packages/node-server/src/cloud-status.ts`; `CHROME_USER_DATA_DIR` and `SLICC_SECRETS_FILE` are env-configurable and point under `$RUNNER_TEMP/slicc-gw`.

## Related

- [`README.md`](./README.md) — consumer-facing input reference and recipes
- `packages/node-server/CLAUDE.md` — hosted mode, `--mount`, secrets architecture
- `packages/cloud-core/CLAUDE.md` — the e2b float this mirrors; `cone-config/index.ts` is the bundle contract
- `packages/slicc-cli/CLAUDE.md` — `prompt` / `exec` / `follow` semantics, exit codes, plain-mode output contract
- `packages/dev-tools/e2b-template/start.sh` — the sandbox boot script whose env discipline `start-leader.mjs` follows
- `docs/transcript-export.md` — what `export-session` produces
