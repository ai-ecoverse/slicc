# SLICC in GitHub Actions

Run a SLICC leader on a GitHub Actions runner, keep it alive for as long as you like, hand it credentials, files, and folders, and talk to it from the same job or from other workflows through the `slicc` CLI. The runner becomes a disposable, fully provisioned cone: the hosted UI and tray hub come from sliccy.ai, node-server and headless Chrome run on the runner, and every interaction goes over the same WebRTC tray channel a browser or iOS follower uses.

Two ways in:

- **Reusable workflows** — one `uses:` line, no checkout of this repo needed.
- **Composite actions** — building blocks for your own job.

Both need network egress to `www.sliccy.ai` (UI + tray hub), npm (node-server), and GitHub releases (the CLI).

## Reusable workflows

### `slicc-leader.yml` — boot, hold, and optionally prompt

```yaml
jobs:
  slicc:
    uses: ai-ecoverse/slicc/.github/workflows/slicc-leader.yml@main
    with:
      duration: 45m
      prompt: |
        Read /mnt/repo/README.md and write a one-paragraph summary to /workspace/summary.md.
      fetch-file: /workspace/summary.md
      mounts: |
        ${{ github.workspace }}:/mnt/repo
      export-session: true
      expose-follower: true # the agent can `ssh` into this runner
    secrets:
      SLICC_CONE_CONFIG: ${{ secrets.SLICC_CONE_CONFIG }}
      SLICC_SECRETS_ENV: ${{ secrets.SLICC_SECRETS_ENV }}
```

What it does, in order: check out your repo (`checkout: true`), boot the leader, install the CLI, inject `inject-path` into the VFS, lend the runner as a follower (`expose-follower`), run `prompt` and wait for the turn, upload the reply (`<artifact-prefix>-response`), export the session (`<artifact-prefix>-session`), fetch `fetch-file` (`<artifact-prefix>-file`), hold until `duration` elapses (or stop right after the prompt with `stop-after-prompt: true`), tear down, upload the leader logs.

| Input                    | Default         | Meaning                                                                                |
| ------------------------ | --------------- | -------------------------------------------------------------------------------------- |
| `duration`               | `30m`           | Leader lifetime (`90s`, `2h`, `1h30m`; max `350m`, the GitHub job ceiling minus setup) |
| `prompt`                 | `''`            | First user message; the job waits until the turn completes                             |
| `prompt-timeout`         | `30m`           | Wall-clock cap for that turn                                                           |
| `stop-after-prompt`      | `false`         | Tear down once the reply arrives                                                       |
| `model` / `effort-level` | `''`            | Override the bundle's model (pi-ai alias, e.g. `anthropic:claude-opus-4-6`) / effort   |
| `checkout`               | `true`          | Check out the calling repository first                                                 |
| `inject-path`            | `''`            | Workspace directory copied into the VFS at `inject-target` (default `/`)               |
| `mounts`                 | `''`            | One `<runner-path>:<slicc-path>` per line; live host folders, no copy                  |
| `fetch-file`             | `''`            | VFS path published as the `<artifact-prefix>-file` artifact                            |
| `export-session`         | `false`         | Publish the redacted transcript bundle as `<artifact-prefix>-session`                  |
| `expose-follower`        | `false`         | Run `slicc … follow <follower-runner>` on this runner (default runner `bash -c`)       |
| `slicc-version`          | `latest`        | npm version of `sliccy` (node-server)                                                  |
| `cli-version`            | `latest`        | Release tag of the Go CLI                                                              |
| `slicc-ref`              | `main`          | Ref of this repo the actions are taken from                                            |
| `runs-on`                | `ubuntu-latest` | Runner label                                                                           |
| `mask-join-url`          | `true`          | Redact the join URL from logs — which also drops it from the job outputs (see below)   |
| `artifact-prefix`        | `slicc`         | Prefix for uploaded artifacts                                                          |

Secrets: `SLICC_CONE_CONFIG` (JSON bundle, below) and `SLICC_SECRETS_ENV` (`secrets.env` text). Both optional; without them the cone boots with no provider and `prompt` cannot succeed.

Outputs: `join-url` (empty when masked), `tray-id`, `slicc-version`, `response` (first 256 KB; the artifact holds all of it), `prompt-exit-code`.

`workflow_dispatch` is wired too, with the ten most useful inputs, reading `SLICC_CONE_CONFIG` / `SLICC_SECRETS_ENV` from the repository secrets.

### Talking to a running leader from another workflow

Each takes the join URL as the `SLICC_JOIN_URL` secret (store it as a repository or environment secret, or pass a leader job's output when you set `mask-join-url: false`).

| Workflow              | Inputs                                                 | Result                                                        |
| --------------------- | ------------------------------------------------------ | ------------------------------------------------------------- |
| `slicc-prompt.yml`    | `prompt`, `timeout`                                    | `response` output + `slicc-response` artifact, after the turn |
| `slicc-exec.yml`      | `command`, `timeout`, `fail-on-error`                  | `stdout` + `exit-code` outputs, `slicc-exec-output` artifact  |
| `slicc-vfs-read.yml`  | `path`, `artifact-name`                                | The file as an artifact                                       |
| `slicc-vfs-write.yml` | `path`, `content` or `source-artifact` + `source-file` | Bytes written                                                 |
| `slicc-follower.yml`  | `duration`, `runner`, `eval`, `checkout`               | This runner stays connected as an exec-capable follower       |

```yaml
jobs:
  ask:
    uses: ai-ecoverse/slicc/.github/workflows/slicc-prompt.yml@main
    with:
      prompt: 'What changed in the last release? Use git log in /mnt/repo.'
    secrets:
      SLICC_JOIN_URL: ${{ secrets.SLICC_JOIN_URL }}

  build-box:
    uses: ai-ecoverse/slicc/.github/workflows/slicc-follower.yml@main
    with:
      duration: 2h
      runner: bash -c # the agent runs commands on this runner via `ssh`
    secrets:
      SLICC_JOIN_URL: ${{ secrets.SLICC_JOIN_URL }}
```

## Composite actions

All live under `packages/github-workflow/actions/` and are referenced as `ai-ecoverse/slicc/packages/github-workflow/actions/<name>@main`. Every CLI action takes `join-url`; the leader lifecycle actions share a state file under `$RUNNER_TEMP/slicc-gw`.

| Action           | Purpose                                                                                | Key inputs → outputs                                                                                 |
| ---------------- | -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `start-leader`   | Boot `node-server --hosted` + headless Chrome, seed credentials, wait for the join URL | `duration`, `mounts`, `cone-config`, `secrets-env`, `model`, `slicc-version` → `join-url`, `tray-id` |
| `install-cli`    | Install the Go `slicc` CLI from releases, export `SLICC_CLI`                           | `version` → `path`, `version`                                                                        |
| `prompt`         | One user turn, wait for completion                                                     | `prompt`, `timeout` → `response`, `response-file`, `exit-code`                                       |
| `exec`           | One command in the leader's virtual shell                                              | `command`, `stdin-file`, `fail-on-error` → `stdout`, `exit-code`                                     |
| `read-file`      | Copy a VFS file to the runner (byte-exact)                                             | `path`, `local` → `bytes`                                                                            |
| `write-file`     | Write a runner file or inline text into the VFS                                        | `path`, `local` or `content` → `bytes`                                                               |
| `inject-files`   | Copy a whole directory tree into the VFS in one round trip                             | `source`, `target` → `files`, `bytes`                                                                |
| `follow`         | Lend this runner to the leader as an exec-capable follower (detached)                  | `runner`, `eval` → `pid`, `connected`                                                                |
| `export-session` | `session export` on the leader, copy the ZIP back                                      | `local`, `session-id` → `bytes`                                                                      |
| `keep-alive`     | Hold the job until the deadline; fail if a watched process dies                        | `watch`, `until`                                                                                     |
| `stop-leader`    | Tear down followers, node-server, leftover Chrome; print log tails; always succeeds    | → `log-path`                                                                                         |

```yaml
steps:
  - uses: actions/checkout@v7
  - id: leader
    uses: ai-ecoverse/slicc/packages/github-workflow/actions/start-leader@main
    with:
      duration: 20m
      cone-config: ${{ secrets.SLICC_CONE_CONFIG }}
      mounts: |
        ${{ github.workspace }}:/mnt/repo
  - uses: ai-ecoverse/slicc/packages/github-workflow/actions/install-cli@main
  - id: reply
    uses: ai-ecoverse/slicc/packages/github-workflow/actions/prompt@main
    with:
      join-url: ${{ steps.leader.outputs.join-url }}
      prompt: Run the test suite in /mnt/repo and summarize the failures.
  - uses: ai-ecoverse/slicc/packages/github-workflow/actions/keep-alive@main
  - if: always()
    uses: ai-ecoverse/slicc/packages/github-workflow/actions/stop-leader@main
```

## Credentials

Two inputs, both matching what the cloud float already consumes:

- **`cone-config`** — a JSON bundle `{ "model", "effortLevel", "accounts": [...], "secrets": [...] }`. `accounts` are provider accounts (`{"providerId":"anthropic","kind":"apikey","apiKey":"…"}` or `{"providerId":"github","kind":"oauth","accessToken":"…"}`); `secrets` are `{ "name", "value", "domains": ["api.example.com"] }`. Store it as one repository secret.
- **`secrets-env`** — plain `secrets.env` text: `NAME=value` followed by `NAME_DOMAINS=a,b`. Every secret must be domain-scoped; a missing `_DOMAINS` line fails the boot with the offending name.

Accounts land in `/slicc/cone-config.json` and the leader's hosted bootstrap applies them before the first turn. Secrets land in a 0600 `secrets.env` under `$RUNNER_TEMP`; the agent only ever sees masked values and the fetch proxy unmasks them at the network boundary for the allowed domains (see `docs/secrets.md`). Neither input is placed in node-server's environment.

## Files and folders

- **`inject-files` / `inject-path`** copies a tree into the VFS once, at boot. Overwrites files with the same path; leaves everything else alone. Compressed payload cap 64 MB (`max-bytes`).
- **`mounts`** exposes runner folders live over node-server's host-FS bridge — the agent's reads and writes hit the runner's disk directly, so `${{ github.workspace }}:/mnt/repo` is the natural way to let the cone work on your checkout. One `<runner-path>:<slicc-path>` per line; targets must be absolute and not `/`.
- **`read-file` / `write-file` / `fetch-file`** move single files byte-exact in either direction.

## The join URL

`start-leader` registers the join URL as a secret with the runner (`mask-join-url: true`), so it is redacted from every log line. GitHub then refuses to pass it through _job_ outputs — inside the same job it flows freely between steps, which is what every action above relies on. To use a leader from a different job or workflow you have two options: store a long-lived leader's URL as a repository secret and use the `slicc-*.yml` workflows with `SLICC_JOIN_URL`, or set `mask-join-url: false` and treat the job's logs as secret-bearing.

## Exposing a runner as a follower

`follow` (or `expose-follower: true`, or `slicc-follower.yml`) runs `slicc <join-url> follow --plain --no-banner <runner>` detached. The leader's agent sees the runner in `ssh --list` as a `follower-<id> (slicc-cli)` exec target and can run commands on it with `ssh <id> "…"`. This is remote code execution on the runner by design. The `runner` argv is where you scope it: `bash -c` gives the agent the whole runner, `docker exec -i box sh -c` confines it to a container. `eval: true` switches to a persistent REPL runner (`python -i`, `node -i`).

## Limits and gotchas

- GitHub jobs end after 6 hours; `duration` is capped at 350 minutes and `timeout-minutes` defaults to 360.
- Only Linux and macOS runners are supported for the leader (headless Chrome + `sudo mkdir /slicc`); the CLI actions also run on Windows.
- `prompt` needs a provider account in `cone-config`; without one the turn errors and the step fails.
- Everything runs against production sliccy.ai by default. `ui-origin` and `tray-worker-base-url` point a leader at a staging UI or tray hub.
- The leader log is always uploaded as `<artifact-prefix>-leader-logs`; `stop-leader` prints its tail in the job log.
