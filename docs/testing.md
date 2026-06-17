# Testing Guide

Test patterns, conventions, and best practices for SLICC.

## Framework and Setup

- **Framework**: Vitest with `globals: true`, `environment: node`
- **Convention**: `foo.test.ts` in `packages/*/tests/` mirroring the `src/` structure
- **Test count**: 1513 tests across 84 files
- **Import fake-indexeddb** when VirtualFS is used: `import 'fake-indexeddb/auto'`

## VirtualFS Test Setup

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

## RestrictedFS and Security Testing

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

## Tool Testing

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

## Shell Command Testing (Arg Parsing)

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

## Mocking Patterns

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

## What MUST Have Tests

- **Pure logic**: Utilities, adapters, data transformations
- **Path handling**: Filesystem operations, ACL checks, path normalization
- **Tool execution**: Command execution, error handling, output parsing
- **Message processing**: Agent message formatting, context compaction
- **Error conditions**: ENOENT, EACCES, type mismatches

## What CAN Skip Tests

- **DOM rendering**: UI panels (ChatPanel, TerminalPanel, FilePanel)
- **just-bash runtime**: the shell interpreter itself (covered by tool tests)
- **Chrome API**: DebuggerClient, service workers — EXCEPT
  state-machine and lifecycle-reconciliation logic (e.g., the
  detached-popout SW state machine), which MUST be unit-tested
  with mocked `chrome.*` APIs. See
  `packages/chrome-extension/tests/service-worker-detached.test.ts`
  for the established mock pattern.
- **xterm.js**: Terminal rendering (manually verified)

For skipped categories, ensure **manual verification in both CLI and extension modes** before committing.

## Running Tests

| Command                                                      | Purpose                                      |
| ------------------------------------------------------------ | -------------------------------------------- |
| `npm run test`                                               | Run all tests once; fail fast on first error |
| `npx vitest run packages/webapp/tests/fs/virtual-fs.test.ts` | Run single test file                         |
| `npx vitest run packages/webapp/tests/fs/`                   | Run all tests in directory                   |
| `npx vitest run --reporter=verbose`                          | Verbose output with full stack traces        |
| `npx vitest run --reporter=dot`                              | Minimal output (one `.` per test)            |

## Test File Organization

Tests live in `packages/*/tests/` mirroring the `src/` structure:

```
packages/webapp/tests/fs/
  virtual-fs.test.ts
  restricted-fs.test.ts

packages/webapp/tests/tools/
  bash-tool.test.ts
  file-tools.test.ts
  search-tools.test.ts

packages/webapp/tests/shell/supplemental-commands/
  which-command.test.ts
  skill-command.test.ts

packages/webapp/tests/core/
  context-compaction.test.ts
  logger.test.ts
```

## Test Data Fixtures

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

## Debugging Tests

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

## Integration vs Unit Tests

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

## Fake-LLM E2E Framework

End-to-end agent-loop tests run the real WC composer + kernel-worker
agent against a deterministic OpenAI-compatible fake LLM server. The
agent loop is identical to production — fixtures only change which
assistant turns stream back.

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

### Writing a Scenario

See `packages/webapp/tests/e2e/reference-scenario.test.ts` for the
working reference. Boilerplate:

```typescript
import { expect, test } from '@playwright/test';
import { readCdpPageState, runUserInputFixture, seedLocalLlmProvider } from './fake-llm-helpers.js';
import { seedSkipSwReload, waitForSW } from './helpers.js';

// Binds Chrome's CDP at the default port the helper probes AND the
// port the `node-server --serve-only --cdp-port=9222` proxy expects.
// Run this file serially when other specs also touch 9222.
test.use({ launchOptions: { args: ['--remote-debugging-port=9222'] } });
test.describe.configure({ mode: 'serial' });

test('scripted tool call drives a real CDP navigation', async ({ page }) => {
  // 1. Seed the local-llm provider BEFORE goto so the kernel worker's
  //    localStorage shim picks the seed up at boot.
  await seedLocalLlmProvider(page, { modelId: 'fake-coder-reference' });
  await seedSkipSwReload(page);
  await page.goto('/');
  await waitForSW(page);

  // 2. Wait for the cone to be created AND selected. The composer
  //    renders earlier; submitting before this point produces a
  //    "No scoop selected" error card.
  await page.waitForSelector('slicc-input-card');
  await expect(page.locator('slicc-chat-thread')).toContainText('Welcome to SLICC');

  // 3. Submit the scripted user input. `runUserInputFixture` calls
  //    `submitUserMessage` + `waitForTurnComplete` for each entry.
  await runUserInputFixture(page, ['open the reference page']);

  // 4. Chat-transcript assertion — positive proof the fake LLM
  //    streamed back AND the agent loop ran the scripted turn.
  await expect(page.locator('slicc-chat-thread')).toContainText('Opening the reference');

  // 5. CDP/browser-state assertion — Chrome at 9222 reports the
  //    target the agent's `bash playwright-cli tab-new …` opened.
  await expect
    .poll(async () => {
      const targets = await readCdpPageState({
        filter: (t) => t.type === 'page' && t.url.startsWith('data:text/html'),
      });
      return targets.map((t) => t.title);
    })
    .toContain('FAKE LLM REFERENCE TARGET');
});
```

Matching fixture (`fixtures/reference-scenario.json`):

```json
{
  "model": "fake-coder-reference",
  "turns": [
    {
      "whenUserMessageMatches": "open the reference page",
      "content": "Opening the reference data: URL so the test can assert on the CDP target.",
      "tool_calls": [
        {
          "name": "bash",
          "arguments": {
            "command": "playwright-cli tab-new 'data:text/html,<!DOCTYPE html><title>FAKE LLM REFERENCE TARGET</title><h1>Agent landed here</h1>'"
          }
        }
      ]
    },
    { "content": "Done. The agent navigated to the reference page." }
  ],
  "onOverflow": "error"
}
```

### CDP Assertions

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

### Running

```bash
npm run test:e2e
```

`playwright.config.ts` boots both `webServer` entries (the app on
5780, the fake LLM on 5781) and the agent talks to the fake server
via the seeded `local-llm` provider. Override the fixture with the
`FAKE_LLM_FIXTURE` env var.

### Risks Covered by the Reference Scenario

- **localStorage → kernel-worker shim sync**: the test only passes if
  the seeded `slicc_accounts` + `selected-model` make it from page
  storage into the worker's `localStorage` shim — otherwise the agent
  never resolves the `local-llm` model and never calls the fake server.
- **`waitForTurnComplete` masking failures**: the popup + chat-transcript
  assertions are positive — they only succeed when the scripted turn
  actually ran end to end.
- **CDP port alignment**: the helper, the `node-server --serve-only`
  proxy, and the test's `launchOptions.args` all agree on 9222.
