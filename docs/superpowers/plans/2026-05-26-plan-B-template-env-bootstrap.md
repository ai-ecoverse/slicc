# Plan B — template env-var bootstrap + CLI backport

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the boot-time race where the in-sandbox bootstrap fetches `/api/hosted-bootstrap` ~5s after page load but secrets.env may not yet exist. Pass the IMS token (and any future bootstrap secrets) as sandbox env vars at `Sandbox.create`; have `start.sh` write `secrets.env` from those envs BEFORE invoking node-server. Also adds resume-time secrets refresh to the CLI (existing CLI bug — paused cones with expired IMS tokens can't recover).

**Architecture:** Two-file change to the template (start.sh + template.ts env-passthrough), plus a refactor of `cloud-core/operations/start.ts` and `cloud-core/operations/resume.ts` to use `envs` and write secrets.env on resume respectively. The CLI keeps its full filtered `secrets.env` upload via `files.write` permanently, because env-var bootstrap only carries the IMS token while CLI cones still need non-Adobe secrets such as GitHub PATs, S3 keys, and OAuth-replica tokens.

**Tech Stack:** Bash, TypeScript, e2b SDK v2.

**Spec:** `docs/superpowers/specs/2026-05-26-cloud-cones-on-sliccy-ai-design.md` § "Sandbox lifecycle integration".

**Depends on:** Plan A complete (operations live in cloud-core).

---

## File map

```
packages/dev-tools/e2b-template/
├── start.sh                          ← MODIFY: read ADOBE_IMS_TOKEN from env, write secrets.env
└── template.ts                       ← unchanged (already supports envs via Sandbox.create)

packages/cloud-core/src/operations/
├── start.ts                          ← MODIFY: thread `envs` from caller into substrate.create
└── resume.ts                         ← (already accepts refreshSecretsContents from Plan A)

packages/node-server/src/cloud/
├── start.ts                          ← MODIFY: extract ADOBE_IMS_TOKEN from envContents,
│                                              pass via envs alongside file upload
└── resume.ts                         ← MODIFY: pass current envContents as refreshSecretsContents

packages/node-server/tests/cloud/
└── start.test.ts                     ← MODIFY: assert envs include ADOBE_IMS_TOKEN
└── resume.test.ts                    ← MODIFY: assert files.write called with secrets.env
```

---

### Task B1: Update start.sh to write secrets.env from env vars

**Files:**

- Modify: `packages/dev-tools/e2b-template/start.sh`

- [ ] **Step 1: Read current start.sh to know exact line layout**

```bash
cat packages/dev-tools/e2b-template/start.sh
```

Confirm shebang (`#!/bin/bash` after our earlier fix) and the existing `exec` line.

- [ ] **Step 2: Update start.sh**

Replace the file content with:

```sh
#!/bin/bash
set -e

# Runtime env. (E2B v2 setEnvs is build-time only, so runtime env has to be set
# here. node-server uses these as defaults when --hosted is passed, so the
# `export`s are belt-and-suspenders.)
export SLICC_HOSTED=1
export SLICC_SECRETS_FILE=/slicc/secrets.env
export CHROME_USER_DATA_DIR=/data/profile

# Bootstrap secrets.env from sandbox env vars when present. Both the laptop CLI
# (Plan B) and the Cloudflare worker (Plan D) inject ADOBE_IMS_TOKEN via
# Sandbox.create({ envs: ... }) so the page-side hosted-bootstrap fetch finds
# the token even on the very first poll.
#
# Backwards compat: if /slicc/secrets.env already exists (older CLI uploaded
# it via files.write after sandbox create), don't overwrite — that case still
# papers over the race via the 5s page-side delay.
if [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then
  cat > /slicc/secrets.env <<EOF
ADOBE_IMS_TOKEN=$ADOBE_IMS_TOKEN
ADOBE_IMS_TOKEN_DOMAINS=${ADOBE_IMS_TOKEN_DOMAINS:-adobe-llm-proxy.paolo-moz.workers.dev}
EOF
fi

# Tee stderr to /tmp/slicc-stderr.log AND keep it on container stderr so it
# surfaces in e2b build logs (otherwise build-time failures are blind).
exec node /opt/slicc/node-server/index.js --hosted --port 5710 --no-open \
  2> >(tee /tmp/slicc-stderr.log >&2)
```

- [ ] **Step 3: Verify syntax**

```bash
bash -n packages/dev-tools/e2b-template/start.sh
```

Expected: no output (script parses OK).

- [ ] **Step 4: Commit**

```bash
git add packages/dev-tools/e2b-template/start.sh
git commit -m "feat(e2b-template): bootstrap /slicc/secrets.env from sandbox env vars"
```

---

### Task B2: Push the updated template

**Files:** none (deployment step)

- [ ] **Step 1: Confirm dist/ is fresh**

```bash
npm run build -w @slicc/webapp -w @slicc/node-server
```

- [ ] **Step 2: Push to e2b**

```bash
bash packages/dev-tools/e2b-template/scripts/build-template.sh
```

Expected: `Published template slicc: { … }`. Build takes ~5-10min if cached, ~1-2min on rebuild of small layers.

- [ ] **Step 3: Verify the new template boots**

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" \
  bash packages/dev-tools/e2b-template/scripts/verify-template.sh
```

Expected last line: `OK https://www.sliccy.ai/join/...`.

This step does NOT exercise the new env-var bootstrap path (verify-template doesn't pass ADOBE_IMS_TOKEN). It just confirms the template still boots with the modified start.sh. The actual env-var path gets exercised in Task B5.

- [ ] **Step 4: No commit needed** — deployment artifact

---

### Task B3: Thread envs through startCone

**Files:**

- Modify: `packages/cloud-core/src/operations/start.ts`

- [ ] **Step 1: Verify current shape**

`packages/cloud-core/src/operations/start.ts` should accept `opts.envs?: Record<string, string>` (added in Plan A Task A9). If missing, add it now:

```ts
export interface StartConeOpts {
  envContents: string;
  workerBaseUrl: string;
  template?: string;
  name?: string;
  sliccVersion: string;
  metadata?: Record<string, string>;
  /** Extra envs passed to substrate.create. Mainly used to inject ADOBE_IMS_TOKEN
   * so start.sh writes secrets.env from them BEFORE node-server boots,
   * eliminating the bootstrap race. */
  envs?: Record<string, string>;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  autoPauseOnCap?: boolean;
}
```

And verify the `substrate.create` call merges these:

```ts
envVars: {
  SLICC_TRAY_WORKER_BASE_URL: opts.workerBaseUrl,
  ...(opts.envs ?? {}),
},
```

- [ ] **Step 2: Run the cloud-core operations tests**

```bash
npx vitest run --project cloud-core
```

Expected: still green. (The interface addition doesn't break anything.)

- [ ] **Step 3: No commit yet** — pairs with B4

---

### Task B4: CLI extracts ADOBE_IMS_TOKEN and passes via envs

**Files:**

- Modify: `packages/node-server/src/cloud/start.ts`
- Modify: `packages/node-server/tests/cloud/start.test.ts`

- [ ] **Step 1: Update runStart**

Replace `packages/node-server/src/cloud/start.ts` contents with:

```ts
import { promises as fs } from 'node:fs';
import { startCone, type StartResult } from '@slicc/cloud-core';
import type { SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunStartOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  sliccVersion: string;
  workerBaseUrl: string;
  name?: string;
  template?: string;
  pollTimeoutMs?: number;
}

/**
 * Extract ADOBE_IMS_TOKEN (and DOMAINS) from an env-file body for env-var
 * bootstrap (start.sh writes /slicc/secrets.env from these BEFORE node-server
 * boots, eliminating the historical 5s race). Other secrets stay in the
 * envContents body which is still uploaded as /slicc/secrets.env for the
 * full agent surface.
 */
function extractAdobeBootstrap(envContents: string): Record<string, string> {
  const envs: Record<string, string> = {};
  for (const line of envContents.split('\n')) {
    const m = line.match(/^\s*(ADOBE_IMS_TOKEN(?:_DOMAINS)?)\s*=\s*(.*)$/);
    if (m) envs[m[1]!] = m[2]!.trim();
  }
  return envs;
}

export async function runStart(opts: RunStartOpts): Promise<StartResult> {
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const adobeBootstrap = extractAdobeBootstrap(envContents);
  const registry = new FileRegistry(opts.registryPath);
  return startCone(
    { substrate: opts.substrate, registry },
    {
      envContents,
      envs: adobeBootstrap,
      workerBaseUrl: opts.workerBaseUrl,
      template: opts.template,
      name: opts.name,
      sliccVersion: opts.sliccVersion,
      pollTimeoutMs: opts.pollTimeoutMs,
    }
  );
}
```

- [ ] **Step 2: Update start.test.ts**

Add a test asserting envs are passed through. Find the existing happy-path test in `packages/node-server/tests/cloud/start.test.ts` and add:

```ts
it('extracts ADOBE_IMS_TOKEN from env-file and passes via substrate.create envs', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-start-test-'));
  const envFile = path.join(dir, 'secrets.env');
  await fs.writeFile(
    envFile,
    [
      'ADOBE_IMS_TOKEN=eyJ-test-bearer',
      'ADOBE_IMS_TOKEN_DOMAINS=adobe-llm-proxy.example',
      'OTHER_SECRET=keep-me',
    ].join('\n')
  );
  const registryPath = path.join(dir, 'registry.json');
  const substrate = new FakeSubstrate();

  await runStart({
    substrate,
    envFilePath: envFile,
    registryPath,
    sliccVersion: 'test',
    workerBaseUrl: 'https://w',
    name: 'envs-smoke',
  });

  // The fake captures the most-recent create opts. Verify envs were threaded.
  expect(substrate.lastCreateOpts?.envVars).toMatchObject({
    ADOBE_IMS_TOKEN: 'eyJ-test-bearer',
    ADOBE_IMS_TOKEN_DOMAINS: 'adobe-llm-proxy.example',
  });
});
```

If `FakeSubstrate` doesn't already record `lastCreateOpts`, add it:

```ts
// in packages/cloud-core/tests/fake-substrate.ts
export class FakeSubstrate implements SandboxSubstrate {
  id: SubstrateId = 'e2b';
  lastCreateOpts: CreateOpts | null = null;
  // ...
  async create(opts: CreateOpts): Promise<SandboxHandle> {
    this.lastCreateOpts = opts;
    // ... existing impl ...
  }
}
```

- [ ] **Step 3: Verify**

```bash
npx vitest run --project node-server packages/node-server/tests/cloud/start.test.ts
npm run typecheck
```

Expected: tests pass, types clean.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(cloud/start): pass ADOBE_IMS_TOKEN via Sandbox.create envs for race-free boot"
```

---

### Task B5: CLI live-test the new bootstrap path

**Files:** none (validation step)

- [ ] **Step 1: Run the live test with a real token**

Ensure `~/.slicc/secrets.env` has both `ADOBE_IMS_TOKEN=...` and `ADOBE_IMS_TOKEN_DOMAINS=...`.

```bash
SLICC_TEST_E2B_API_KEY="$E2B_API_KEY" \
  npx vitest run --project node-server packages/node-server/tests/cloud-live.test.ts
```

Expected: 1 passed in ~12s.

- [ ] **Step 2: Manual smoke**

```bash
node dist/node-server/index.js --cloud start --name smoke-B
```

Then open the joinUrl in a browser. Chat panel should show "Logged in: Adobe" without the previous 5s race window — the token is present from boot.

- [ ] **Step 3: Inspect the sandbox to confirm the env-var path fired**

```bash
e2b sandbox connect <sandboxId>
# inside:
cat /tmp/slicc-stderr.log | head -5
ls -la /slicc/secrets.env
cat /slicc/secrets.env
exit
```

You should see `/slicc/secrets.env` with both keys present, created by start.sh BEFORE node-server's process timestamp.

- [ ] **Step 4: Clean up**

```bash
node dist/node-server/index.js --cloud kill smoke-B
```

- [ ] **Step 5: No commit** — validation only

---

### Task B6: Resume passes refresh secrets

**Files:**

- Modify: `packages/node-server/src/cloud/resume.ts`
- Modify: `packages/node-server/tests/cloud/resume.test.ts`

- [ ] **Step 1: Update runResume to pass refreshSecretsContents**

The cloud-core `resumeCone` already accepts `refreshSecretsContents?: string` (Plan A Task A12). Wire the CLI to pass it:

```ts
import { promises as fs } from 'node:fs';
import { resumeCone, type ResumeResult, type SandboxSubstrate } from '@slicc/cloud-core';
import { FileRegistry } from './registry-file.js';

export interface RunResumeOpts {
  substrate: SandboxSubstrate;
  envFilePath: string;
  registryPath: string;
  query: string;
  localSliccVersion: string;
  pollIntervalMs?: number;
  pollTimeoutMs?: number;
}

export async function runResume(opts: RunResumeOpts): Promise<ResumeResult> {
  const envContents = await fs.readFile(opts.envFilePath, 'utf-8');
  const registry = new FileRegistry(opts.registryPath);
  return resumeCone(
    { substrate: opts.substrate, registry },
    {
      query: opts.query,
      localSliccVersion: opts.localSliccVersion,
      // Refresh on resume so cones paused >24h pick up a freshly-issued token
      // from the local secrets.env. This was a pre-existing CLI gap (resume
      // would succeed but Adobe LLM calls would 401 on expired tokens).
      refreshSecretsContents: envContents,
      pollIntervalMs: opts.pollIntervalMs,
      pollTimeoutMs: opts.pollTimeoutMs,
    }
  );
}
```

- [ ] **Step 2: Update the resume dispatcher in node-server/src/index.ts**

Find where `runResume` is invoked (look in the cloud dispatcher) and pass `envFilePath: secretsFilePath` (the same path used by start).

- [ ] **Step 3: Add a test asserting refresh happens**

In `packages/node-server/tests/cloud/resume.test.ts`, add:

```ts
it('writes refresh secrets to /slicc/secrets.env before kicking leader-restart', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-resume-test-'));
  const envFile = path.join(dir, 'secrets.env');
  await fs.writeFile(envFile, 'ADOBE_IMS_TOKEN=fresh-bearer\n');
  const registryPath = path.join(dir, 'registry.json');

  // Seed registry with a paused cone.
  const reg = new FileRegistry(registryPath);
  await reg.append({
    sandboxId: 'sbx-1',
    name: 'paused',
    state: 'paused',
    createdAt: '2026-05-01T00:00:00Z',
    lastSeen: '2026-05-01T00:00:00Z',
    lastJoinUpdatedAt: '2026-05-01T00:00:00Z',
    joinUrl: 'https://w/old',
    trayId: 'old-tray',
  });

  const substrate = new FakeSubstrate();
  substrate.seedSandbox('sbx-1', {
    state: 'paused',
    joinJson: JSON.stringify({
      joinUrl: 'https://w/new',
      trayId: 'new-tray',
      updatedAt: new Date().toISOString(),
    }),
  });

  await runResume({
    substrate,
    envFilePath: envFile,
    registryPath,
    query: 'paused',
    localSliccVersion: 'test',
  });

  // FakeSubstrate records writes on its handle.
  const writes = substrate.getHandle('sbx-1')?.writes ?? [];
  expect(writes).toContainEqual({
    path: '/slicc/secrets.env',
    contents: 'ADOBE_IMS_TOKEN=fresh-bearer\n',
  });
});
```

If `FakeSubstrate.seedSandbox` / handle `.writes` aren't already implemented, add them in `packages/cloud-core/tests/fake-substrate.ts`:

```ts
// inside the fake handle factory:
const writes: Array<{ path: string; contents: string | Uint8Array }> = [];
return {
  // ...
  writeFile: async (path: string, contents: string | Uint8Array) => {
    writes.push({ path, contents });
  },
  writes, // expose for tests
  // ...
};
```

- [ ] **Step 4: Verify**

```bash
npx vitest run --project node-server packages/node-server/tests/cloud/resume.test.ts
npx vitest run --project cloud-core
npm run typecheck
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cloud/resume): refresh /slicc/secrets.env on resume so paused cones pick up fresh IMS tokens"
```

---

### Task B7: Confirm and document the two-layer secrets bootstrap

**Files:**

- Modify: `packages/cloud-core/src/operations/start.ts` — add comments only; do NOT remove the files.write
- Modify: `packages/dev-tools/e2b-template/start.sh` — make the env-var-derived file an additive boot, not a replacement

**Why the original B7 was wrong:** the laptop CLI's secrets.env contains MORE than just `ADOBE_IMS_TOKEN` — it carries the user's full set of secrets (S3 keys, GitHub PATs, OAuth-replica tokens, …). The env-var path only bootstraps `ADOBE_IMS_TOKEN` for race-free Adobe login; the agent still needs everything else. Dropping `handle.writeFile('/slicc/secrets.env', safeSecrets)` would silently regress CLI behavior — the agent inside the cone would lose access to every non-Adobe secret.

**The right shape (two layers, both contribute):**

1. **start.sh env-var bootstrap** (race-free): writes `/slicc/secrets.env` with `ADOBE_IMS_TOKEN` ONLY if the env is set. Runs before node-server boots; primarily benefits the worker (Plan D), which only has the IMS bearer to inject.

2. **`handle.writeFile` after `Sandbox.create`** (full payload): CLI's `runStart` continues to upload the full filtered secrets.env via `handle.writeFile('/slicc/secrets.env', safeSecrets)`. This OVERWRITES the env-bootstrapped file, but does so before the 5s page-side bootstrap fetch, so the page sees the complete picture. Worker doesn't do this step — it doesn't have a full secrets.env to upload.

- [ ] **Step 1: Update start.sh to not clobber a pre-existing file**

Already done in Task B1 — the script writes only if the file doesn't exist:

```sh
if [ -n "$ADOBE_IMS_TOKEN" ] && [ ! -f /slicc/secrets.env ]; then
  cat > /slicc/secrets.env <<EOF
…
EOF
fi
```

Confirm this is the current state. If the file is later overwritten by the CLI's `handle.writeFile`, that's correct: the full payload wins.

- [ ] **Step 2: Document the two-layer model in startCone**

In `packages/cloud-core/src/operations/start.ts`, KEEP the `handle.writeFile('/slicc/secrets.env', safeSecrets)` line and add a comment:

```ts
// Two-layer secrets bootstrap:
//   1) start.sh writes secrets.env from ADOBE_IMS_TOKEN env var BEFORE node-server
//      boots (eliminates the 5s page-side race for the Adobe login).
//   2) AFTER Sandbox.create returns (sandbox booted + leader registered), we
//      overwrite the file with the full filtered envContents — the CLI's user
//      may have S3 keys, GitHub PATs, etc. that the agent needs. This second
//      write lands before the agent's first LLM call, so the user-shell
//      surface sees everything by the time it's used.
// Worker (Plan D) only needs layer 1; it has nothing else to upload.
await handle.writeFile('/slicc/secrets.env', safeSecrets);
```

- [ ] **Step 3: Live test — verify both Adobe + non-Adobe secrets are present**

Manual smoke. Add a sentinel secret to `~/.slicc/secrets.env`:

```
SENTINEL_GITHUB_PAT=ghp_test_sentinel_value
SENTINEL_GITHUB_PAT_DOMAINS=api.github.com
```

Then:

```bash
node dist/node-server/index.js --cloud start --name smoke-B7
# get sandboxId from output, then inside:
e2b sandbox connect <sandboxId>
cat /slicc/secrets.env | grep -E 'ADOBE_IMS_TOKEN|SENTINEL_GITHUB_PAT' | wc -l
# expect: 4 (each key + each _DOMAINS line)
exit
node dist/node-server/index.js --cloud kill smoke-B7
```

Both layers landed: `ADOBE_IMS_TOKEN` from env-bootstrap, `SENTINEL_GITHUB_PAT` from file-write.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "docs(cloud/start): two-layer secrets bootstrap — env-var for IMS + file-write for full payload"
```

---

## Plan B done

End state:

- Template's start.sh writes /slicc/secrets.env from env vars before node-server boots — fixes the IMS-token race for the worker (Plan D) AND the CLI.
- CLI's `runStart` ALSO uploads the full filtered secrets.env after create — preserves non-Adobe secrets (GitHub PATs, S3 keys, etc.).
- CLI's `runResume` writes a fresh secrets.env on resume so long-paused cones can pick up a refreshed IMS token without re-creating.
- Two-layer model is documented inline so future readers understand why both writes exist.
