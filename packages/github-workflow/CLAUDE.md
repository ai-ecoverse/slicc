# CLAUDE.md

Covers the GitHub Actions package in `packages/github-workflow/`.

## Scope

Runs a SLICC **hosted leader** on a GitHub Actions runner, driven by the Go `slicc` follower CLI — the CI-runner analogue of the e2b cloud float. Same `node-server --hosted` boot (headless Chrome against the hosted UI origin, join URL via a join file (`$SLICC_GW_HOME/join.json` when the node-server supports `SLICC_JOIN_FILE`, else `/tmp/slicc-join.json`)) and credential seeding (`/slicc/cone-config.json` + `secrets.env`), but on a runner the job owns for its lifetime instead of a cloud-core-managed sandbox.

Two surfaces:

- **Composite actions** in `actions/<name>/action.yml`, each a thin `env` mapping over one `scripts/` script. Referenced as `ai-ecoverse/slicc/packages/github-workflow/actions/<name>@<ref>`.
- **Reusable workflows** in `.github/workflows/slicc-*.yml` (`workflow_call`) composing the actions: `slicc-leader.yml` (boot + hold + optional prompt/inject/mount/export/follow), plus `slicc-prompt.yml`, `-exec.yml`, `-vfs-read.yml`, `-vfs-write.yml`, `-follower.yml`.

**Not an npm workspace.** Consumers run the scripts from a bare checkout, so `scripts/` must stay dependency-free (Node built-ins only). Tests run under the `github-workflow` vitest project from the repo root.

## Layout

| Path                                    | Purpose                                                                                             |
| --------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `scripts/lib.mjs`                       | Pure helpers: duration/port/mount parsing, cone-config + `secrets.env` validation, command builders |
| `scripts/gh-io.mjs`                     | Runner I/O: `INPUT_*`, `$GITHUB_OUTPUT`/`_ENV`/`_PATH`, masks, state file, liveness, `execOnLeader` |
| `scripts/start-leader.mjs`              | Install `sliccy`, write credential files, spawn `node-server --hosted`, poll join file, save state  |
| `scripts/serve-webapp.mjs`              | Opt-in loopback server for a built `dist/ui` (`pin-webapp`); else leaders load production sliccy.ai |
| `scripts/materialize-pinned-commit.mjs` | Fetch a git ref into a worktree, build `dist/node-server` + `dist/ui` (local node harness layout)   |
| `scripts/wait-for-deadline.mjs`         | Hold the job until the deadline; fail fast when a watched pid dies                                  |
| `scripts/stop-leader.mjs`               | Followers → node-server → leftover Chrome; always exits 0; prints log tails                         |
| `scripts/install-cli.mjs`               | Token-authenticated release scan for `slicc-<os>-<arch>`; exports `SLICC_CLI`                       |
| `scripts/slicc-run.mjs`                 | `prompt` / `exec` with timeout, output file, truncated step output                                  |
| `scripts/vfs-file.mjs`                  | Byte-exact read/write of one VFS file over base64                                                   |
| `scripts/inject-files.mjs`              | tar+gzip a runner directory, unpack on the leader in one exec                                       |
| `scripts/follow.mjs`                    | Detached `slicc … follow <runner>`; records the pid for keep-alive/stop                             |
| `scripts/export-session.mjs`            | `session export` on the leader, then copy the ZIP back                                              |
| `actions/*/action.yml`                  | One composite action per script (plus `keep-alive` over `wait-for-deadline.mjs`)                    |
| `tests/fixtures/`, `tests/helpers.mjs`  | Fake `slicc` CLI + fake node-server + per-test env scaffolding (excluded from coverage)             |

## Build and Test

```bash
npx vitest run --project github-workflow      # unit + fake-CLI tests
npm run test:coverage:github-workflow         # same, with the coverage floors from coverage-thresholds.json
actionlint .github/workflows/slicc-*.yml .github/workflows/github-workflow-smoke.yml
npm run lint                                  # biome (.mjs) + prettier (yml/md)
```

Tests are co-located `scripts/*.test.mjs`. `lib.test.mjs` is pure; every other script runs through its exported `main()` against `tests/fixtures/fake-slicc.mjs` (Go-CLI stand-in: fake VFS, understands the command shapes `lib.mjs` builds, plus probes forcing dial failures, non-zero exits, slow turns) and `tests/fixtures/fake-node-server.mjs` (writes the join file, or exits / never writes / writes a stale one). `tests/helpers.mjs` gives each test an isolated `$SLICC_GW_HOME`, the three GitHub command files, and the two path seams (`SLICC_GW_JOIN_FILE`, `SLICC_GW_CONE_CONFIG_PATH`) so nothing touches `/tmp/slicc-join.json` or `/slicc`.

Coverage is gated in CI with `coverageInclude` so untested scripts count as 0%. Only `isMain` trampolines are `v8 ignore`d. Floors ratchet via nightly `coverage-ratchet.mjs`; never hand-lower them.

Live gate `.github/workflows/github-workflow-smoke.yml`: boots a real leader from published `sliccy`, builds the Go CLI from the checkout (`install-cli` `source: build`), exercises every action (prompt legs use Bedrock via `bedrock-camp`, same-repo heads only), then `slicc-leader.yml` at the PR ref. Needs network egress.

## Design Rules

- **Existing mechanisms only.** Credentials go through the cone-config bundle and `secrets.env` exactly as cloud-core writes them; files enter the VFS over the tray exec channel; mounts use node-server's `--mount` table. Nothing adds a node-server endpoint.
- **Pure vs I/O split.** Anything decidable without a runner lives in `lib.mjs` with a unit test. Scripts do I/O, export `main()` and helpers, and only run behind `isMain(import.meta.url)`, so tests import them without side effects. Injection points (`exec`, `fetchImpl`, `isAlive`, `pollMs`) are `main` options, never globals.
- **The join URL is a capability.** `start-leader` masks it by default (`::add-mask::`); every CLI action re-masks the value it receives. Never a job output (readable only after the job and its leader ended). Cross-job use goes through a `SLICC_JOIN_URL` secret or, with `mask-join-url: false`, the `<artifact-prefix>-join` artifact uploaded while the leader runs — never the default.
- **Credentials never reach node-server's environment.** `buildLeaderEnv` strips every `INPUT_*` variable and the preboot `*_B64` bundles before spawning; the bundle lives on disk with mode 0600 only.
- **Two `slicc` binaries.** The npm `sliccy` package installs a `slicc` bin (node-server); the Go follower is also `slicc`. `install-cli` puts the Go binary in a private dir and exports `SLICC_CLI`; scripts call that path, never bare `slicc`.
- **Composite actions have no `post:`.** Teardown is the explicit `stop-leader` action under `if: always()`; `keep-alive` keeps the job (and detached leader) alive.
- **Preserve lifecycle state.** `state.json` holds the leader pid, credential path, Chrome profile, and follower pids. `readState` returns `null` only for a missing file and surfaces other read/parse failures; `writeState` replaces the file by same-directory rename so `follow` never folds a partial read into a follower-only state.
- **Byte-exact file transfer is base64 both ways.** The exec channel carries stdin as bytes but streams stdout as text.
- **`npm install sliccy` retries.** Just-published versions can briefly 404; `installNodeServer` retries after 5 s / 15 s / 45 s (`NPM_INSTALL_DELAYS_MS`); a bad `slicc-version` fails ~65 s later.
- **Dial failures retry, executions never do.** A failed WebRTC dial (`tray connect timed out`) is reported before anything reaches the leader, so `execOnLeader` and `slicc-run` retry those up to three times; any other non-zero status is final (the command may have run).
- **`SLICC_CHROME_GPU=1` in the job env reaches the leader's Chrome** (`start-leader` passes `process.env` to node-server): GPU + WebGPU instead of `--disable-gpu`, for GPU runners only (`cloud-run-gpu`). See node-server's Hosted mode.
- **Join file is per leader when node-server exposes `SLICC_JOIN_FILE`.** `start-leader` probes entry + `cloud-status.js`; if either names that var, polls `$SLICC_GW_HOME/join.json` only. Published packages lack the string and still write `/tmp/slicc-join.json` (never poll both — another lane's legacy write can win). `stop-leader` deletes recorded `joinFile`. `/slicc/cone-config.json` stays shared. Profile/secrets under `$SLICC_GW_HOME`.
- **`pin-webapp` is off by default.** Hosted leaders load `https://www.sliccy.ai` unless set; then `serve-webapp.mjs` serves package `dist/ui` on `localhost:<bridge+1000>`, Chrome's `WORKER_BASE_URL` points there, `SLICC_TRAY_WORKER_BASE_URL` stays on the tray hub. Worker page fetches (`/api/flags`, `/api/models/…`) proxy to the tray origin without cookies/credentials; local `dist/ui`, missing `/assets/*` stays 404. Page origin → `BRIDGE_DEV_ALLOWED_ORIGINS`; not with `ui-origin`. Stop kills `uiServer`.

## Related

- [`README.md`](./README.md) — consumer-facing input reference and recipes
- `packages/node-server/CLAUDE.md` — hosted mode, `--mount`, secrets architecture
- `packages/cloud-core/CLAUDE.md` — the e2b float this mirrors; `cone-config/index.ts` is the bundle contract
- `packages/slicc-cli/CLAUDE.md` — `prompt` / `exec` / `follow` semantics, exit codes, plain-mode output
- `packages/dev-tools/e2b-template/start.sh` — sandbox boot script whose env discipline `start-leader.mjs` follows
- `docs/transcript-export.md` — what `export-session` produces
