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

| Input                            | Default         | Meaning                                                                                                   |
| -------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------- |
| `duration`                       | `30m`           | Leader lifetime (`90s`, `2h`, `1h30m`; max `350m`, the GitHub job ceiling minus setup)                    |
| `prompt`                         | `''`            | First user message; the job waits until the turn completes                                                |
| `prompt-timeout`                 | `30m`           | Wall-clock cap for that turn                                                                              |
| `stop-after-prompt`              | `false`         | Tear down once the reply arrives                                                                          |
| `model` / `effort-level`         | `''`            | Override the bundle's model (pi-ai alias, e.g. `anthropic:claude-opus-4-6`) / effort                      |
| `provider` / `provider-base-url` | `''`            | Single API-key provider (with the `SLICC_PROVIDER_API_KEY` secret); base URL where the provider needs one |
| `checkout`                       | `true`          | Check out the calling repository first                                                                    |
| `inject-path`                    | `''`            | Workspace directory copied into the VFS at `inject-target` (default `/`)                                  |
| `mounts`                         | `''`            | One `<runner-path>:<slicc-path>` per line; live host folders, no copy                                     |
| `fetch-file`                     | `''`            | VFS path published as the `<artifact-prefix>-file` artifact                                               |
| `export-session`                 | `false`         | Publish the redacted transcript bundle as `<artifact-prefix>-session`                                     |
| `expose-follower`                | `false`         | Run `slicc … follow <follower-runner>` on this runner (default runner `bash -c`)                          |
| `slicc-version`                  | `latest`        | npm version of `sliccy` (node-server)                                                                     |
| `cli-version`                    | `latest`        | Release tag of the Go CLI                                                                                 |
| `slicc-ref`                      | `main`          | Ref of this repo the actions are taken from                                                               |
| `runs-on`                        | `ubuntu-latest` | Runner label                                                                                              |
| `mask-join-url`                  | `true`          | Redact the join URL from logs; `false` publishes it as the `<artifact-prefix>-join` artifact (see below)  |
| `artifact-prefix`                | `slicc`         | Prefix for uploaded artifacts                                                                             |

Secrets: `SLICC_PROVIDER_API_KEY` (with the `provider` input), `SLICC_CONE_CONFIG` (JSON bundle, below) and `SLICC_SECRETS_ENV` (`secrets.env` text). All optional; without a provider account the cone boots but `prompt` cannot succeed.

Outputs: `tray-id`, `slicc-version`, `response` (first 256 KB; the artifact holds all of it), `prompt-exit-code`.

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

| Action           | Purpose                                                                                    | Key inputs → outputs                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `start-leader`   | Boot `node-server --hosted` + headless Chrome, seed credentials, wait for the join URL     | `duration`, `mounts`, `cone-config`, `secrets-env`, `model`, `slicc-version` → `join-url`, `tray-id` |
| `install-cli`    | Install the Go `slicc` CLI from releases (or build it from a checkout), export `SLICC_CLI` | `version`, `source` → `path`, `version`                                                              |
| `prompt`         | One user turn, wait for completion                                                         | `prompt`, `timeout` → `response`, `response-file`, `exit-code`                                       |
| `exec`           | One command in the leader's virtual shell                                                  | `command`, `stdin-file`, `fail-on-error` → `stdout`, `exit-code`                                     |
| `read-file`      | Copy a VFS file to the runner (byte-exact)                                                 | `path`, `local` → `bytes`                                                                            |
| `write-file`     | Write a runner file or inline text into the VFS                                            | `path`, `local` or `content` → `bytes`                                                               |
| `inject-files`   | Copy a whole directory tree into the VFS in one round trip                                 | `source`, `target` → `files`, `bytes`                                                                |
| `follow`         | Lend this runner to the leader as an exec-capable follower (detached)                      | `runner`, `eval` → `pid`, `connected`                                                                |
| `export-session` | `session export` on the leader, copy the ZIP back                                          | `local`, `session-id` → `bytes`                                                                      |
| `keep-alive`     | Hold the job until the deadline; fail if a watched process dies                            | `watch`, `until`                                                                                     |
| `stop-leader`    | Tear down followers, node-server, leftover Chrome; print log tails; always succeeds        | → `log-path`                                                                                         |

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

The quickest setup is one API-key provider: `provider` (`anthropic`, `openai`, `bedrock-camp`, …), the `SLICC_PROVIDER_API_KEY` secret (`provider-api-key` on the action), `provider-base-url` where the provider needs one, and `model` as `<provider>:<model>`. The smoke gate runs exactly this with the repo's Bedrock key: `provider: bedrock-camp`, `provider-base-url: https://bedrock-runtime.us-west-2.amazonaws.com`, `model: bedrock-camp:us.anthropic.claude-opus-4-8`.

For several accounts or secrets, two bundle inputs match what the cloud float already consumes: **`cone-config`** (a JSON bundle, stored as the `SLICC_CONE_CONFIG` secret) and **`secrets-env`** (`secrets.env` text, stored as `SLICC_SECRETS_ENV`).

### `cone-config` — full example

The bundle is the same `ConeConfig` shape `packages/cloud-core/src/cone-config/index.ts` defines for the e2b float. Every field except `accounts` is optional. The comments below are for reading only — the stored secret must be plain JSON, so strip them before pasting.

<!-- prettier-ignore -->
```jsonc
{
  // Model the cone starts on, as "<providerId>:<modelId>". The `model`
  // input overrides this. Omit it to let SLICC pick its default.
  "model": "bedrock-camp:us.anthropic.claude-opus-4-8",

  // Locked thinking effort: off | minimal | low | medium | high | xhigh.
  // Omit for the model's default. The `effort-level` input overrides this.
  "effortLevel": "high",

  // Provider accounts applied at boot, before the first turn. One entry per
  // providerId; a later `provider` + `provider-api-key` shortcut replaces the
  // entry with the same providerId.
  "accounts": [
    {
      // API-key provider that also needs an endpoint (Bedrock runtime for
      // the region; the ABSK… value is the Bedrock API key / CAMP bearer).
      "providerId": "bedrock-camp",
      "kind": "apikey",
      "apiKey": "ABSK...",
      "baseUrl": "https://bedrock-runtime.us-west-2.amazonaws.com"
    },
    {
      // Plain API-key provider: `baseUrl` is optional, as are `deployment`
      // and `apiVersion` (Azure-style providers).
      "providerId": "anthropic",
      "kind": "apikey",
      "apiKey": "sk-ant-..."
    },
    {
      // OAuth provider: a pre-acquired access token (the cone cannot open a
      // login popup). `refreshToken`, `tokenExpiresAt` (epoch ms), `userName`
      // and `baseUrl` are optional. A GitHub token here also drives the
      // in-cone `git clone` / `git push` bridge.
      "providerId": "github",
      "kind": "oauth",
      "accessToken": "gho_...",
      "refreshToken": "ghr_...",
      "tokenExpiresAt": 1789520000000,
      "userName": "octocat"
    }
  ],

  // Domain-scoped secrets (same schema as secrets.env). The agent only ever
  // sees a masked value; the fetch proxy substitutes the real one for
  // requests whose hostname matches one of `domains`. Names must be
  // identifiers ([A-Za-z_][A-Za-z0-9_.-]*) — identifier-shaped ones also
  // surface as $NAME in the agent shell — and values single-line. The
  // `oauth.` prefix is reserved. A `secrets-env` entry with the same name
  // wins over one listed here.
  "secrets": [
    {
      "name": "GITHUB_TOKEN",
      "value": "ghp_...",
      // Bare `github.com` is needed for `git push https://github.com/...`;
      // `*.github.com` does not match the bare host.
      "domains": ["github.com", "*.github.com", "raw.githubusercontent.com"]
    },
    {
      "name": "OPENAI_KEY",
      "value": "sk-...",
      "domains": ["api.openai.com"]
    },
    {
      // Dotted names stay out of the shell environment but are still
      // unmasked by the proxy — the convention mount backends use.
      "name": "s3.r2.access_key_id",
      "value": "R2_ACCESS_KEY_ID",
      "domains": ["*.r2.cloudflarestorage.com"]
    }
  ]
}
```

Validation happens on the runner before node-server starts, and a bad bundle fails the boot with the offending path (`cone-config: accounts[1]: apikey account requires apiKey`, `secrets-env: TOKEN has no TOKEN_DOMAINS line`, …). Only names and provider ids are ever logged.

### `secrets-env` — full example

The same secrets in the line-oriented format node-server reads (`docs/secrets.md`). Each secret is two lines; a secret without a `_DOMAINS` line is rejected. Values are taken verbatim (no quoting, no escaping, single-line only; base64-encode a multi-line credential).

<!-- prettier-ignore -->
```env
# GitHub PAT for the in-cone git bridge and `gh`-style API calls
GITHUB_TOKEN=ghp_...
GITHUB_TOKEN_DOMAINS=github.com,*.github.com,raw.githubusercontent.com

OPENAI_KEY=sk-...
OPENAI_KEY_DOMAINS=api.openai.com

# S3 / R2 profile consumed by `mount --source s3://… --profile r2`
s3.r2.access_key_id=R2_ACCESS_KEY_ID
s3.r2.access_key_id_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.secret_access_key=R2_SECRET_ACCESS_KEY
s3.r2.secret_access_key_DOMAINS=*.r2.cloudflarestorage.com
s3.r2.endpoint=https://<account-id>.r2.cloudflarestorage.com
s3.r2.endpoint_DOMAINS=*.r2.cloudflarestorage.com
```

Storing them as repository secrets from a terminal:

```bash
gh secret set SLICC_CONE_CONFIG --repo <owner>/<repo> < cone-config.json
gh secret set SLICC_SECRETS_ENV --repo <owner>/<repo> < secrets.env
```

Accounts land in `/slicc/cone-config.json` and the leader's hosted bootstrap applies them before the first turn. Secrets land in a 0600 `secrets.env` under `$RUNNER_TEMP`; the agent only ever sees masked values and the fetch proxy unmasks them at the network boundary for the allowed domains (see `docs/secrets.md`). Neither input is placed in node-server's environment.

## Files and folders

- **`inject-files` / `inject-path`** copies a tree into the VFS once, at boot. Overwrites files with the same path; leaves everything else alone. Compressed payload cap 64 MB (`max-bytes`).
- **`mounts`** exposes runner folders live over node-server's host-FS bridge — the agent's reads and writes hit the runner's disk directly, so `${{ github.workspace }}:/mnt/repo` is the natural way to let the cone work on your checkout. One `<runner-path>:<slicc-path>` per line; targets must be absolute and not `/`.
- **`read-file` / `write-file` / `fetch-file`** move single files byte-exact in either direction.

## The join URL

`start-leader` registers the join URL as a secret with the runner (`mask-join-url: true`), so it is redacted from every log line and never leaves the job. Inside the job it flows freely between steps, which is what every action above relies on.

Reaching a leader from a **different** job needs care: a job's outputs only become readable once the job has finished, and finishing the leader job tears the leader down, so outputs cannot hand a live leader to anyone. Two options that do work:

- Store a long-lived leader's URL as a repository or environment secret and use the `slicc-*.yml` workflows with `SLICC_JOIN_URL`.
- Set `mask-join-url: false` on `slicc-leader.yml`. The URL is then published as the `<artifact-prefix>-join` artifact (`join.json`) right after boot, while the leader is still running; a parallel job in the same run downloads it (retry until it exists) and drives the leader with the actions. Treat that run's logs and artifacts as secret-bearing.

## Exposing a runner as a follower

`follow` (or `expose-follower: true`, or `slicc-follower.yml`) runs `slicc <join-url> follow --plain --no-banner <runner>` detached. The leader's agent sees the runner in `ssh --list` as a `follower-<id> (slicc-cli)` exec target and can run commands on it with `ssh <id> "…"`. This is remote code execution on the runner by design. The `runner` argv is where you scope it: `bash -c` gives the agent the whole runner, `docker exec -i box sh -c` confines it to a container. `eval: true` switches to a persistent REPL runner (`python -i`, `node -i`).

## Limits and gotchas

- GitHub jobs end after 6 hours; `duration` is capped at 350 minutes and `timeout-minutes` defaults to 360.
- The leader needs a **Linux** runner. Credentials are seeded through `/slicc/cone-config.json`, a path node-server reads unconditionally, and macOS's sealed root volume cannot hold that directory even with sudo (a credential-less leader still boots there). The CLI actions run on Linux, macOS and Windows.
- `install-cli` downloads the newest release that ships binaries by default; `source: build` compiles `packages/slicc-cli` from a checkout instead (needs Go), which is how this repo's smoke gate tests the CLI at the PR's ref. `slicc-leader.yml` exposes the same switch as `cli-source`.
- `prompt` needs a provider account in `cone-config`; without one the turn errors and the step fails.
- Everything runs against production sliccy.ai by default. `ui-origin` and `tray-worker-base-url` point a leader at a staging UI or tray hub.
- The leader log is always uploaded as `<artifact-prefix>-leader-logs`; `stop-leader` prints its tail in the job log.
