---
name: writing-slicc-tests
description: |
  Use when writing or updating Vitest tests, setting up VirtualFS/fake-indexeddb tests, or when test:coverage fails a floor. Includes the ratchet rule (never hand-lower coverage-thresholds.json), VirtualFS dbCounter isolation pattern, RestrictedFS security test patterns, tool testing patterns, and the fake-LLM e2e framework. Also triggered by error strings like 'coverage below threshold', 'ENOENT', or 'fake-indexeddb'.
---

# writing-slicc-tests

Use these patterns, conventions, and procedures when writing tests for SLICC.

## Quick Reference

| Command                                                                 | Purpose                                     |
| ----------------------------------------------------------------------- | ------------------------------------------- |
| `npm run test`                                                          | Run Node-mode Vitest projects               |
| `npm test -w @slicc/webcomponents`                                      | Run Chromium browser-mode component tests   |
| `npm test -w @ai-ecoverse/spoon`                                        | Run Chromium launcher tests                 |
| `npx vitest run packages/webapp/tests/fs/virtual-fs.test.ts`            | Run a single test file                      |
| `npx vitest run packages/webapp/tests/fs/`                              | Run all tests in a directory                |
| `npx vitest run --reporter=verbose`                                     | Show full stack traces                      |
| `npm run test:coverage:<package>`                                       | Check a TypeScript package's coverage floor |
| `./packages/dev-tools/tools/swift-coverage-check.sh <pkg-dir> <bundle>` | Check Swift package coverage floors         |
| `npm run test:server-integration`                                       | Node-server integration tests               |
| `npm run test:e2e`                                                      | Run Playwright and fake-LLM E2E tests       |

## Set Up the Framework

- **Framework**: Vitest with `globals: true`, `environment: node`
- **Convention**: `foo.test.ts` in `packages/*/tests/` mirroring the `src/` structure
- **Import fake-indexeddb** when VirtualFS is used: `import 'fake-indexeddb/auto'`

**Note:** `npm run test` runs the default Node-mode Vitest projects only. It does
not include:

- **Browser-mode suites**: `npm test -w @slicc/webcomponents` and `npm test -w @ai-ecoverse/spoon` (real Chromium via `@vitest/browser`)
- **Server integration**: `npm run test:server-integration`
- **Playwright E2E**: `npm run test:e2e`

When changing web components or DOM rendering, run the browser-mode suites — they
require automated tests, not just manual verification.

## Set Up VirtualFS Tests

When testing filesystem code, import fake-indexeddb and create a VirtualFS with a unique dbName:

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from './virtual-fs.js';

describe('VirtualFS', () => {
  let vfs: VirtualFS;
  let dbCounter = 0;

  beforeEach(async () => {
    // Create fresh VirtualFS with unique DB name for test isolation
    vfs = await VirtualFS.create({
      dbName: `test-vfs-${dbCounter++}`,
      wipe: true,
    });
  });

  it('writes and reads text files', async () => {
    await vfs.writeFile('/test.txt', 'Hello VirtualFS!');
    const content = await vfs.readFile('/test.txt');
    expect(content).toBe('Hello VirtualFS!');
  });

  it('writes and reads binary files', async () => {
    const data = new Uint8Array([10, 20, 30]);
    await vfs.writeFile('/binary.dat', data);
    const result = (await vfs.readFile('/binary.dat', { encoding: 'binary' })) as Uint8Array;
    // LightningFS may return a view into a larger buffer, compare actual bytes
    expect(result.length).toBe(data.length);
    expect(Array.from(result)).toEqual(Array.from(data));
  });
});
```

Key pattern: increment `dbCounter` in `beforeEach` to ensure each test gets an isolated IndexedDB instance.

## Test RestrictedFS Security

Test path access control and ACL boundaries:

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeAll } from 'vitest';
import { VirtualFS } from './virtual-fs.js';
import { RestrictedFS } from './restricted-fs.js';

describe('RestrictedFS', () => {
  let vfs: VirtualFS;
  let restricted: RestrictedFS;

  beforeAll(async () => {
    vfs = await VirtualFS.create({ dbName: 'test-restricted-fs', wipe: true });
    // Set up scoop directories
    await vfs.mkdir('/scoops/andy-scoop', { recursive: true });
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.writeFile('/scoops/andy-scoop/file.txt', 'hello');
    await vfs.writeFile('/shared/data.txt', 'shared data');
    await vfs.writeFile('/root-file.txt', 'root');

    // Restrict to scoop + shared paths
    restricted = new RestrictedFS(vfs, ['/scoops/andy-scoop/', '/shared/']);
  });

  it('reads files within allowed dirs', async () => {
    const content = await restricted.readFile('/scoops/andy-scoop/file.txt', { encoding: 'utf-8' });
    expect(content).toBe('hello');
  });

  it('throws ENOENT for reads outside allowed dirs (not EACCES)', async () => {
    await expect(restricted.readFile('/root-file.txt')).rejects.toThrow('ENOENT');
  });

  it('prevents path traversal (returns ENOENT)', async () => {
    await expect(restricted.readFile('/scoops/andy-scoop/../../root-file.txt')).rejects.toThrow(
      'ENOENT'
    );
  });

  it('prevents writing outside allowed dirs', async () => {
    await expect(restricted.writeFile('/root-file.txt', 'hacked')).rejects.toThrow('EACCES');
  });

  // Parent directory traversal needed for 'cd'
  it('stat on parent dir of allowed path works (cd needs this)', async () => {
    const stat = await restricted.stat('/scoops');
    expect(stat.type).toBe('directory');
  });

  it('readDir on parent dir filters to only allowed children', async () => {
    const entries = await restricted.readDir('/scoops');
    const names = entries.map((e) => e.name);
    expect(names).toContain('andy-scoop');
  });
});
```

Key patterns:

- **ENOENT vs EACCES**: Outside reads → ENOENT. Outside writes → EACCES.
- **Path traversal**: Test `/../..` escapes → should throw ENOENT.
- **Parent traversal**: Reading parent dirs is allowed (needed for `cd`). Writing parent dirs is blocked.
- **readDir filtering**: Parent directories show only children leading toward allowed paths.

## Test Tools

Test tool execution with filesystem integration:

```typescript
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { VirtualFS } from '../fs/index.js';
import { AlmostBashShell } from '../shell/index.js';
import { createBashTool } from './bash-tool.js';
import type { ToolDefinition } from '../core/types.js';

describe('Bash Tool', () => {
  let fs: VirtualFS;
  let shell: AlmostBashShell;
  let bash: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({
      dbName: `test-bash-tool-${dbCounter++}`,
      wipe: true,
    });
    shell = new AlmostBashShell({ fs });
    bash = createBashTool(shell);
  });

  it('executes echo', async () => {
    const result = await bash.execute({ command: 'echo hello world' });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('hello world');
  });

  it('reports errors with isError', async () => {
    const result = await bash.execute({ command: 'cat /nonexistent' });
    expect(result.isError).toBe(true);
  });

  it('supports file creation and reading', async () => {
    await bash.execute({ command: 'echo "test content" > /test.txt' });
    const result = await bash.execute({ command: 'cat /test.txt' });
    expect(result.content).toContain('test content');
  });
});
```

Key patterns:

- Test command execution: call `tool.execute()` with args
- Check `isError` flag for error conditions
- Use file operations within tool tests (pipes, redirects)
- Test compound operations (e.g., zip → unzip)

## Test Shell Command Argument Parsing

Test supplemental commands with mocked context:

```typescript
import { describe, it, expect } from 'vitest';
import { createWhichCommand } from './which-command.js';
import type { IFileSystem } from 'just-bash';

function createMockCtx(
  overrides: {
    registeredCommands?: string[];
    fs?: Partial<IFileSystem>;
  } = {}
) {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
    ...overrides.fs,
  };
  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin: '',
    getRegisteredCommands: () => overrides.registeredCommands ?? ['ls', 'cat', 'node', 'git'],
  };
}

/** Create a minimal VirtualFS mock that yields the given file paths from walk(). */
function createMockVfs(files: string[]) {
  return {
    exists: async () => true,
    walk: async function* () {
      for (const f of files) yield f;
    },
  } as unknown as VirtualFS;
}

describe('which command', () => {
  it('resolves built-in command to /usr/bin/<name>', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute(['node'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/usr/bin/node\n');
  });

  it('returns error for no arguments', async () => {
    const cmd = createWhichCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('missing argument');
  });

  it('finds .jsh file on VFS', async () => {
    const mockVfs = createMockVfs(['/workspace/skills/test-skill/hello.jsh']);
    const cmd = createWhichCommand(mockVfs);
    const result = await cmd.execute(['hello'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('/workspace/skills/test-skill/hello.jsh\n');
  });
});
```

Key patterns:

- **Mock context**: Create minimal mock with only needed properties
- **Mock VFS**: Return specific files from `walk()` for file discovery tests
- **Test arg parsing separately**: Test command-line parsing logic without booting the just-bash runtime
- **Check exit codes and output**: Verify both success and error paths

## Apply Mocking Patterns

### Using vi.fn() for function mocks

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Module with callbacks', () => {
  it('calls the callback with data', async () => {
    const callback = vi.fn();
    await myAsyncFunction(callback);
    expect(callback).toHaveBeenCalledWith('expected data');
  });
});
```

### Using vi.spyOn() for partial mocks

```typescript
import { describe, it, expect, vi } from 'vitest';

describe('Module with internal methods', () => {
  it('calls internal helper', async () => {
    const spy = vi.spyOn(module, 'privateHelper');
    await publicFunction();
    expect(spy).toHaveBeenCalled();
  });
});
```

### Message helper functions for typed content

Create helpers for constructing typed test messages:

```typescript
function createMessage(role: 'user' | 'assistant' | 'toolResult', text: string): AgentMessage {
  return {
    role,
    content: [{ type: 'text' as const, text }],
  } as any;
}

function createToolResult(text: string): AgentMessage {
  return {
    role: 'toolResult',
    content: [{ type: 'text' as const, text }],
  } as any;
}

describe('createCompactContext', () => {
  it('calls generateSummary when threshold exceeded', async () => {
    const compact = createCompactContext({
      model: mockModel,
      getApiKey: () => 'test-key',
      contextWindow: 200000,
    });
    const baseMsg = 'x'.repeat(65000);
    const messages = Array.from({ length: 12 }, () => createMessage('user', baseMsg));

    const result = await compact(messages);

    expect(mockGenerateSummary).toHaveBeenCalledOnce();
    expect(result.length).toBeLessThan(messages.length);
    expect((result[0].content as any)[0].text).toContain('<context-summary>');
  });
});
```

Key pattern: Helper functions reduce boilerplate and make tests more readable.

## Test These Categories

- **Pure logic**: Utilities, adapters, data transformations
- **Path handling**: Filesystem operations, ACL checks, path normalization
- **Tool execution**: Command execution, error handling, output parsing
- **Message processing**: Agent message formatting, context compaction
- **Error conditions**: ENOENT, EACCES, type mismatches

## Manually Verify These Categories

- **just-bash runtime**: the shell interpreter itself (covered by tool tests)
- **Chrome API**: DebuggerClient, service workers — EXCEPT
  state-machine and lifecycle-reconciliation logic (e.g., the
  leader-tab pinning and service-worker lifecycle), which MUST be unit-tested
  with mocked `chrome.*` APIs. See
  `packages/chrome-extension/tests/service-worker-leader-tab.test.ts`
  for the established mock pattern.
- **xterm.js**: Terminal rendering (manually verified)

**Web components and DOM rendering** are covered by browser-mode Vitest suites
(`@slicc/webcomponents`, `@ai-ecoverse/spoon`). Changes to those packages require
automated browser tests, not just manual verification.

For skipped categories, ensure **manual verification in both CLI and extension modes** before committing.

## Import-Time Runtime Gating in Extension Tests

Some modules compute runtime mode at import time (for example
`const isExtension = isExtensionRealm()`). For those modules, extension-path
tests must stub `chrome` **before import**, then re-import the module after
`vi.resetModules()`.

Pattern:

```typescript
(globalThis as any).chrome = { runtime: { id: 'test-extension-id', sendMessage, onMessage } };
vi.resetModules();
const mod = await import('../../src/providers/oauth-service.js');
```

If one suite verifies both extension and non-extension paths, call
`vi.resetModules()` between cases so each import sees the intended runtime
globals.

## Enforce Coverage

Coverage thresholds are enforced in CI and stored in `coverage-thresholds.json` at the
repo root. Never hand-lower these values — use the commands below to measure and let
the ratchet raise floors automatically.

### Follow the Floors and Nightly Ratchet

`packages/dev-tools/tools/coverage-ratchet.mjs` (driven by
`.github/workflows/coverage-ratchet.yml`) is the single source of truth for floor
maintenance. It only ever **raises** floors toward measured coverage — whole-point steps
with ~0.5–1.5 pp headroom via a half-point safety margin — and opens a PR when anything
changed.

### Check TypeScript Packages

Run `npm run test:coverage:<package>` — this invokes `vitest --coverage` (v8 provider)
then `coverage-gate.mjs`, which reads the package's floors from
`coverage-thresholds.json`. CI runs the same script as the package's only test step.

Anything after the package name is forwarded verbatim to vitest, so a run-wide option can
be added without paying for a second pass over the same suite:

```bash
node packages/dev-tools/tools/coverage-gate.mjs webapp --reporter=json --outputFile=report.json
```

### Check Swift Packages

Run `packages/dev-tools/tools/swift-coverage-check.sh <package-dir> <test-bundle-name>`,
which executes `swift test --enable-code-coverage` followed by `xcrun llvm-cov report`.
`Tests/` and `.build` paths are excluded; the **TOTAL row** is checked against the
lines/functions/regions floors from `coverage-thresholds.json` (passed explicitly or
read from the file). The `swift-launcher` floor stays low because most of the bundle is
SwiftUI views that resist unit tests.

Both arguments are **required**:

```bash
./packages/dev-tools/tools/swift-coverage-check.sh \
  packages/swift-server SliccServerPackageTests

./packages/dev-tools/tools/swift-coverage-check.sh \
  packages/swift-launcher SliccstartPackageTests
```

## Retry Flaky Tests

Retries are configured **per vitest project** in `vitest.config.ts` and gated on `CI` so
local runs still fail fast:

| Project                                               | Retries in CI | Why                                                                         |
| ----------------------------------------------------- | ------------- | --------------------------------------------------------------------------- |
| `node-server`                                         | 1             | Spawns Chrome/Electron, binds ports, waits on child-process handshakes      |
| `chrome-extension`                                    | 1             | Timer- and message-ordering-sensitive state machines over mocked `chrome.*` |
| Playwright E2E (`packages/webapp/tests/e2e/`)         | 2             | Real browser + CDP + model staging under load                               |
| every other project (`webapp`, `shared`, `cherry`, …) | 0             | Deterministic in-process suites — a failure is a bug, not noise             |

Rules for changing this:

- **Do not add retries to a project to make a red suite green.** A retry hides
  nondeterminism; fix the ordering, fake the timer, or isolate the resource instead.
- Keep the count at 1 unless the flake is provably external (a real browser, a real port).
  Retried-but-passing tests still show up as `retried` in the run report, so the signal
  survives; a higher count buries it and doubles worst-case wall-clock.
- Never enable retries locally. `CI_RETRIES` in `vitest.config.ts` resolves to `0` without
  `CI`, so `npm run test` on a laptop reports the first failure.

## Read Test Timing

When `CI` is set, the root `test.reporters` adds vitest's `json` reporter and writes
per-test durations to `test-timing/vitest.json` (gitignored). `reporters` and `outputFile`
are root-only options in vitest 4, so this covers every project — including the
`vitest run --project <name>` invocations made by
`packages/dev-tools/tools/coverage-gate.mjs`.

CI uploads the file from the `webapp`, `node-server`, and `chrome-extension` jobs as
`test-timing-webapp` / `test-timing-node-server` / `test-timing-chrome-extension`
(`if: always()`, so a failing run still produces it).

Shape: `testResults[]` is one entry per file with `startTime` / `endTime`, and
`assertionResults[]` is one entry per test with a `duration` in milliseconds.

```json
{
  "numTotalTests": 341,
  "testResults": [
    {
      "name": "/…/packages/shared-ts/tests/base64.test.ts",
      "startTime": 1785156911234,
      "endTime": 1785156911814,
      "assertionResults": [
        {
          "fullName": "base64 codec round-trips an empty Uint8Array",
          "status": "passed",
          "duration": 1.2396669999999972
        }
      ]
    }
  ]
}
```

To find the slowest tests in a downloaded artifact:

```bash
node -e "const r=require('./test-timing/vitest.json').testResults.flatMap(f=>f.assertionResults.map(a=>[a.duration,a.fullName]));r.sort((a,b)=>b[0]-a[0]);console.log(r.slice(0,20))"
```

Reproduce it locally with `CI=1 npm run test`.

## Run Tests

| Command                                                      | Purpose                                   |
| ------------------------------------------------------------ | ----------------------------------------- |
| `npm run test`                                               | Run Node-mode Vitest projects             |
| `npm test -w @slicc/webcomponents`                           | Run Chromium browser-mode component tests |
| `npm test -w @ai-ecoverse/spoon`                             | Run Chromium launcher tests               |
| `npx vitest run packages/webapp/tests/fs/virtual-fs.test.ts` | Run single test file                      |
| `npx vitest run packages/webapp/tests/fs/`                   | Run all tests in directory                |
| `npx vitest run --reporter=verbose`                          | Verbose output with full stack traces     |
| `npx vitest run --reporter=dot`                              | Minimal output (one `.` per test)         |

## Organize Test Files

Tests live in `packages/*/tests/` mirroring the `src/` structure:

```
packages/webapp/tests/fs/
  virtual-fs.test.ts
  restricted-fs.test.ts

packages/webapp/tests/tools/
  bash-tool.test.ts
  file-tools.test.ts

packages/webapp/tests/shell/supplemental-commands/
  which-command.test.ts
  skill-command.test.ts

packages/webapp/tests/core/
  context-compaction.test.ts
  logger.test.ts
```

## Test with the Design-Time Chat Fixture

Load the app with `?ui-fixture=1` (also accepts `?ui-fixture` or `?ui-fixture=true`) to swap
the chat view for a synthetic session covering every message variant — user/assistant bubbles,
markdown + code blocks, all four tool-call states, the six lick channels, delegation, queued
messages, and a streaming tail.

Messages are defined in `packages/webapp/src/ui/chat-fixture.ts` (`createChatFixture()`) and
persist to a dedicated `session-ui-fixture` ID so real scoop storage is untouched. Clicking any
real scoop cleanly exits fixture mode. Vite HMR picks up CSS changes live against the fixture.

**When adding new message UI variants**: extend `createChatFixture()` and add a matching
assertion in `packages/webapp/tests/ui/chat-fixture.test.ts` so the fixture harness stays
comprehensive. The test file asserts that every variant type is present in the fixture — a
new type that appears in the fixture but has no test entry causes the test to fail fast.

## Build Test Data Fixtures

Avoid hardcoding test data. Use generators or helper functions:

```typescript
function generateLargeText(sizeChars: number): string {
  return 'x'.repeat(sizeChars);
}

function createTestFile(name: string, content: string) {
  return { name, content };
}

describe('File operations', () => {
  it('handles large files', async () => {
    const largeContent = generateLargeText(1_000_000);
    await vfs.writeFile('/large.txt', largeContent);
    const result = await vfs.readFile('/large.txt');
    expect(result).toBe(largeContent);
  });
});
```

## Debug Tests

Run a single test with verbose output:

```bash
npx vitest run --reporter=verbose packages/webapp/tests/fs/virtual-fs.test.ts
```

Add `console.log()` in test code — output appears in terminal:

```typescript
it('does something', async () => {
  const result = await operation();
  console.log('result:', result); // visible in test output
  expect(result).toBe(expected);
});
```

Watch mode for rapid iteration:

```bash
npx vitest watch packages/webapp/tests/fs/virtual-fs.test.ts
```

Make changes to test or source → Vitest re-runs automatically.

## Choose Integration or Unit Tests

- **Unit tests** (the default): Test one module in isolation with mocked dependencies
- **Integration tests** (acceptable): Test filesystem + shell + tool together if they can't be tested separately

Example of acceptable integration test:

```typescript
describe('Bash tool integration', () => {
  it('reads from VirtualFS via shell', async () => {
    // Test that bash tool talks correctly to VirtualFS
    // This requires both components together
    const fs = await VirtualFS.create({ dbName: 'test', wipe: true });
    const shell = new AlmostBashShell({ fs });
    const bash = createBashTool(shell);

    await bash.execute({ command: 'echo hello > /file.txt' });
    const content = await fs.readFile('/file.txt');
    expect(content).toBe('hello\n');
  });
});
```

But avoid testing implementation details across many layers. Keep most tests focused and fast.

## Test the Agent Loop with the Fake-LLM E2E Framework

End-to-end agent-loop tests run the real WC composer + kernel-worker
agent against a deterministic OpenAI-compatible fake LLM server. The
agent loop is identical to production — fixtures only change which
assistant turns stream back.

See [docs/architecture.md](../../../docs/architecture.md) for the standalone topology and protocol context.

Three pieces compose the framework:

- **Fake server** (`packages/webapp/tests/e2e/fake-llm/`): SSE-streaming
  OpenAI-compatible server with permissive CORS. Started by a second
  `webServer` entry in `playwright.config.ts` on port 5781.
- **Fixture** (`packages/webapp/tests/e2e/fake-llm/fixtures/*.json`):
  ordered list of scripted assistant `turns` (text + optional
  `tool_calls`). Turns are matched cursor-first; per-turn
  `whenUserMessageMatches` (substring or `{ pattern, flags }` regex)
  selects a specific turn for a specific user input.
- **Playwright harness** (`packages/webapp/tests/e2e/fake-llm-helpers.ts`):
  `seedLocalLlmProvider`, `submitUserMessage`, `waitForTurnComplete`,
  `runUserInputFixture`, and `readCdpPageState`.
- **Two-instance topology** (`packages/webapp/tests/e2e/two-instance-helpers.ts`):
  a second SLICC runtime joined to the leader through the real tray hub, plus
  the cone / freezer-rail / tab-strip / terminal helpers the multi-cone
  scenarios share. See "Write a Two-Instance Scenario" below.
- **Terminal-only smokes** (no fake LLM): drive
  `globalThis.__slicc_terminal_view.executeCommandInTerminal` after
  `slicc-dock.selectItem('term')` — same seam as the chat panel's "run in
  terminal". Examples: `git-clone-live.test.ts`, `python-print.test.ts`
  (browser `ipk add pyodide@<root pin>` then `python3 -c "print(1 + 1)"`).

### Write a Scenario

See `packages/webapp/tests/e2e/reference-scenario.test.ts` for the
working reference. It runs a single Playwright test against a
3-phase fixture and interleaves chat-transcript + CDP-state
assertions after each phase:

- **Phase 1** — user input `"open the reference page"` matches
  `turns[0]` (substring matcher); the agent runs one `bash`
  `playwright-cli tab-new` opening Page A
  (title `FAKE LLM REFERENCE TARGET`). `turns[1]` (cursor follow-up)
  delivers `"Done. Page A is open."`. The test then asserts both
  strings are in the thread and that `readCdpPageState` sees exactly
  one target at the Page A `data:` URL.
- **Phase 2** — user input `"open the comparison pages"` matches
  `turns[2]`, which emits **two** `bash` tool calls in one turn
  (Page B `FAKE LLM COMPARE ALPHA`, Page C `FAKE LLM COMPARE BETA`)
  with small `contentChunkSize` and `toolArgumentsChunkSize` to
  stress SSE delta reassembly. `turns[3]` (cursor) closes the
  phase with `"Done. Pages B and C are open."`. The test asserts
  the closing text and that `readCdpPageState` filtered to the two
  Page B/C URLs reports both distinct titles.
- **Phase 3** — user input `"give me a summary"` matches `turns[4]`
  via the object-form regex matcher
  (`{ "pattern": "summar(y|ize)", "flags": "i" }`); the turn returns
  text only (no tool call). The test asserts the summary text in the
  thread and that `readCdpPageState` filtered to all three `data:`
  URLs enumerates Pages A/B/C with their three distinct titles
  (sorted for a stable assertion).

Boilerplate from `reference-scenario.test.ts` (note: uses `gotoLeader`,
not `page.goto('/')`, and resets the fixture cursor before each attempt):

```typescript
import { expect, test } from '@playwright/test';
import {
  readCdpPageState,
  resetFakeLlm,
  seedLocalLlmProvider,
  submitUserMessage,
  waitForTurnComplete,
} from './fake-llm-helpers.js';
import { gotoLeader, seedSkipSwReload, waitForSW } from './helpers.js';

// Binds Chrome's CDP at the default port the helper probes AND the
// port the `node-server --serve-only --cdp-port=9222` proxy expects.
test.use({ launchOptions: { args: ['--remote-debugging-port=9222'] } });

test.describe('my scenario', () => {
  // Rewind the fake-LLM turn cursor before every attempt so Playwright
  // retries don't resume mid-fixture and fail with fixture_overflow.
  test.beforeEach(async () => {
    await resetFakeLlm();
  });

  test('scripted tool calls drive CDP navigations', async ({ page }) => {
    await seedLocalLlmProvider(page, { modelId: 'fake-coder-reference' });
    await seedSkipSwReload(page);
    // MUST use gotoLeader — it appends ?bridge=ws://…/cdp&bridgeToken=…
    // so the page-realm BrowserAPI dials the node-server CDP bridge.
    // page.goto('/') will NOT connect the agent to CDP.
    await gotoLeader(page);
    await waitForSW(page);
    await page.waitForSelector('slicc-input-card');
    await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC');

    // Drive one phase at a time so per-phase assertions can interleave.
    await submitUserMessage(page, 'open the reference page');
    await waitForTurnComplete(page);
    await expect(page.locator('slicc-chat-thread')).toContainText('Done. Page A is open.');
    await expect
      .poll(async () =>
        (await readCdpPageState({ filter: (t) => t.type === 'page' })).map((t) => t.title)
      )
      .toContain('FAKE LLM REFERENCE TARGET');

    // Phases 2 and 3 follow the same submit + wait + assert pattern.
  });
});
```

For full inputs, fixture content, and assertions, read the working
test directly. The fixture lives at
`packages/webapp/tests/e2e/fake-llm/fixtures/reference-scenario.json`
and uses `onOverflow: "error"` so a fixture/test mismatch fails fast
with a 400 from the fake server rather than hanging.

### Assert CDP State

`readCdpPageState` polls `http://127.0.0.1:9222/json` and returns the
browser's CDP target list. Use it whenever you need to observe the
agent-driven Chrome from the outside — it is runtime-agnostic and
works against any Chrome with `--remote-debugging-port` set, including
a cone-driven Chrome the test process never launched.

Why `data:text/html,…` instead of a seeded `/preview/*` page: tabs
opened via CDP `Target.createTarget` (which is what `playwright-cli
tab-new` does) are not claimed by the `preview-vfs` service worker —
the SW only controls clients that loaded the SLICC bootstrap. A `data:`
URL carries its HTML inline, so the agent-driven tab gets a
deterministic title without depending on SW interception. When a test
needs to assert on Playwright-controlled DOM, navigate the existing
`page` via `bash playwright-cli goto …` instead (and assert via
`page.locator(...)` before the navigation breaks the test page).

If a scenario needs a `/preview/*` page rendered for assertion,
`seedVFS` continues to work for content the _test page_ itself loads
— it just doesn't reach CDP-spawned tabs.

### Write a Two-Instance Scenario

Anything that crosses the tray — follower rails, cone mirroring, a follower
driving leader state — needs **two runtimes**, not two tabs.
`two-instance-helpers.ts` builds that pair on top of the servers the harness
already runs; `multiple-cones-follower.test.ts` is the worked example.

```ts
await bootMultiConeLeader(page, { fixture, tray: true });
const follower = await joinAsFollower(browser, await leaderJoinUrl(page));
try {
  await expect.poll(() => switcherLabels(follower.page)).toEqual(await switcherLabels(page));
} finally {
  await follower.close();
}
```

Four things make it work, and each is a trap if you rebuild it by hand:

- **The tray hub is real.** The harness's `wrangler dev` IS
  `packages/cloudflare-worker`, Durable Objects included, so the leader mints a
  tray against `http://localhost:<wrangler>` and the worker serves the SPA at
  `/join/<token>`. `bootMultiConeLeader({ tray: true })` appends
  `?trayWorkerUrl=`, which beats both the stored value and the node-server's
  `/api/runtime-config` — without it the page points its tray at the PRODUCTION
  hub and the run means nothing (the origin rule, see
  `.agents/skills/cdp-smoke-test/tier3-multi-harness.md`).
- **The follower needs its own browser CONTEXT.** `wc-tray.ts` elects one leader
  per origin per profile over the Web Locks API; a second page in the leader's
  context defers instead of following. `joinAsFollower` opens a context, and the
  caller closes it in a `finally` so a failing assertion cannot leak a runtime
  into the next test.
- **Read the join URL from `localStorage`, not from a module global.**
  `LeaderTrayManager` runs in the page realm; `slicc.leaderTrayStatus` is the
  shim the page keeps current, and `leaderJoinUrl` polls it for
  `state === 'leader'`.
- **This follower has no local CDP surface.** It can render, select and drive
  leader state; it can never host a teleported tab or advertise targets. Do not
  write a federated-CDP assertion against it.

Two more rules the cone scenarios paid for:

- **Assert the scripted REPLY, not `[data-processing]`.** A fake-LLM turn can
  open and close between two polls of the attribute, so
  `waitForTurnComplete({ mustObserveTurnRise: true })` fails turns that ran
  perfectly. The `chat()` helper waits for the reply text first, then lets the
  turn settle.
- **The workbench terminal is a LAZY mount.** `__slicc_terminal_view` only
  appears after the term surface is activated — `openTerminal()` (and therefore
  `execInTerminal()`) fires `dock.selectItem('term')` first. A bare wait on the
  global just burns its timeout.

Give a two-instance test its own `test.setTimeout` (`TWO_INSTANCE_TEST_TIMEOUT_MS`,
10 min; single-runtime cone specs use `CONE_TEST_TIMEOUT_MS`, 5). The config's
30s default covers one turn, not a cone lifecycle plus a tray handshake — a
healthy CI run of the follower scenario takes ~1.5 min against ~10s locally, so
size the ceiling for a LOADED runner, not merely a slow one.

**Bound every step, or a hang tells you nothing.** Playwright's default
`actionTimeout` / `navigationTimeout` is `0` — unbounded, cut off only by the
test timeout. A `goto` or `.click()` left at the default turns any stall into a
bare `Test timeout of Nms exceeded` whose stack points at whatever ran last
(usually your `finally`). This dropped #2328 out of the merge queue three
attempts in a row before the cause was even visible. Pass an explicit `timeout`
to every navigation and action.

**A failed turn never renders the reply you are waiting for.** When a turn dies
— provider error, fixture overflow, retries exhausted — the thread renders a
`<slicc-error-card>` and the scripted text never arrives, so `toContainText`
waits out the whole budget. Use `expectReply()`, which races the expected text
against that card and throws naming the agent error.

Capture both runtimes' console output with `watchBrowserDiagnostics()` and
re-throw through `diagnostics.annotate(err)`. Without it a CI failure's cause
lives only in the trace artifact, which for the `e2e` job is ~190 MB.

Tune `retries` per spec when an attempt is expensive: the follower spec sets
`test.describe.configure({ retries: 1 })` because three attempts at a 10-minute
ceiling would consume half the `e2e` job's budget and starve the specs after it.

### Run the E2E Framework

```bash
npm run test:e2e
```

`playwright.config.ts` boots three `webServer` entries, mirroring the
production "Standalone" topology now that node-server no longer serves
the UI:

- **wrangler dev on 8787** — serves the built `dist/ui` (the leader / UI
  origin and the Playwright `baseURL`) with SPA fallback, exactly as the
  production worker does. Requires `npm run build -w @slicc/webapp` first.
  Runs under the supervisor in `wrangler-server.ts` — see "Survive a wrangler
  crash" below.
- **node-server `--serve-only --cdp-port=9222` on 5710** — the thin `/cdp`
  bridge + `/api` surface only. `SLICC_BRIDGE_TOKEN` arms the `/cdp` upgrade
  gate + cross-origin `/api` token check, and `BRIDGE_DEV_ALLOWED_ORIGINS`
  allowlists the wrangler origin so its cross-origin requests pass.
- **fake LLM on 5781** — the agent talks to it via the seeded `local-llm`
  provider. Override the fixture with the `FAKE_LLM_FIXTURE` env var.

Because the UI is served cross-origin from the bridge, scenarios that drive
the agent (CDP) or the fetch proxy boot via the `gotoLeader` helper, which
appends `?bridge=ws://localhost:5710/cdp&bridgeToken=…` so the page-realm
BrowserAPI dials the bridge and `proxied-fetch` routes `/api/*` at the
node-server origin (the same launch params node-server appends in
production standalone mode).

The project pins `workers: 1` so only one CDP-binding scenario runs
at a time. The `node-server --serve-only --cdp-port=9222` proxy can
only point at one Chrome at a time, and every scenario that drives
the agent's `playwright-cli` (`reference-scenario.test.ts`,
`preview-serve.test.ts`) launches Playwright Chrome with
`--remote-debugging-port=9222` — running them in parallel would
collide on the port and on the proxy's outbound target. The fake-LLM
webServer entry also sets `reuseExistingServer: false` so each run
starts with a fresh turn cursor and fixture.

In CI the dedicated `e2e` job (in `.github/workflows/ci.yml`) runs this
suite as a hard PR gate feeding the required `ci` summary check. It
triggers on changes to any runtime the harness drives or bundles —
`webapp`, `vfs-root`, `assets`, `shared-ts`, `spoon`, `webcomponents`,
`cloud-core`, `node-server`, `cloudflare-worker` — plus `root-config`
(dependency bumps, tsconfigs).
The multi-cone leg (`multiple-cones*.test.ts`, #2313) rides the same job with
no extra gating: it exercises the `multiple-cones` flag end to end — cone
create / switch / drop, the rail's session actions and their freezer outcomes,
lick addressing across cones, and the leader + follower pair above.
Playwright retries twice in CI (`retries` in the config); locally it
fails fast. The real-Kokoro speech round-trip rides the same job as a
conditional leg: when the `speech` path filter matches, the run sets
`RUN_REAL_SPEECH_E2E=1` (un-skipping `speech-roundtrip.test.ts`) and
frees runner disk first so Chromium's free-disk-derived storage quota
can hold the staged weights.

### Survive a wrangler Crash

`wrangler dev` (workerd) dies mid-suite (#2372). Left alone, the first crash
turns every later spec into a ~200 ms `ERR_CONNECTION_REFUSED` failure — a wall
of red naming eighteen innocent tests. The likely cause is
[workers-sdk#15202](https://github.com/cloudflare/workers-sdk/issues/15202):
workerd exits with `kj/async-io-unix.c++: … Broken pipe` when the consumer of
its stdout (Playwright's `webServer` capture) stops draining the pipe.

Three pieces contain it, and one rule applies when you write a spec:

- **Import `test` from `./fixtures.js`, never from `@playwright/test`.** That
  is the whole rule. `fixtures.ts` re-exports `expect` unchanged and adds one
  auto fixture that probes `HEAD <baseURL>/status` before and after every test.
- **`wrangler-server.ts`** supervises wrangler instead of Playwright spawning it
  directly: it owns (and always drains) wrangler's stdout, mirrors it to
  `.wrangler/e2e-logs/wrangler-output.log`, re-spawns workerd when it exits, and
  serves `POST /restart` on `SLICC_E2E_WRANGLER_SUPERVISOR_PORT`
  (default: leader port + 1).
- **`leader-health.ts`** decides what happens on a dead origin: restart through
  the supervisor and fail _only_ the current spec with an error named
  `WRANGLER_CRASHED`. If the restart fails, the remaining specs fail instantly
  with the same named error instead of burning their timeouts — the job then
  names its cause. Its logic is dependency-injected and unit-tested in
  `packages/webapp/tests/e2e-harness/leader-health.test.ts`.

So a crash costs one spec (which CI then retries), not the run. Evidence lands
in `.wrangler/e2e-logs/`: wrangler's own `wrangler-<ts>.log`, the mirrored
output, and `crash-report.md` (one section per unexpected workerd exit, with
the output tail). The CI job prints the crash report and uploads the directory
as the `wrangler-logs-e2e` artifact.

Grep a red e2e job for `WRANGLER_CRASHED` before believing the failing spec
names are meaningful.

### Verify Risks with the Reference Scenario

- **localStorage → kernel-worker shim sync**: the test only passes if
  the seeded `slicc_accounts` + `selected-model` make it from page
  storage into the worker's `localStorage` shim — otherwise the agent
  never resolves the `local-llm` model and never calls the fake server.
- **`waitForTurnComplete` masking failures**: the per-phase
  chat-transcript + CDP-state assertions are positive — each one only
  succeeds when the prior scripted turn actually ran end to end, so a
  silent "turn never started" surfaces as a timeout, not a false green.
- **CDP port alignment**: the helper, the `node-server --serve-only`
  proxy, and the test's `launchOptions.args` all agree on 9222, and
  the per-phase `readCdpPageState` filters key on each target's
  distinct title/URL so multi-tab assertions stay unambiguous.
- **SSE delta reassembly**: phase 2's turn sets small
  `contentChunkSize` and `toolArgumentsChunkSize` so the agent has to
  reassemble both streamed content and multi-tool-call argument
  fragments before the bash commands run.
- **Matcher coverage**: the three matched turns exercise the
  substring form (phases 1 + 2) and the object-form regex
  (`{ pattern, flags }`, phase 3) of `whenUserMessageMatches`.
