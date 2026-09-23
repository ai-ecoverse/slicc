import 'fake-indexeddb/auto';
import type { Command, ResolvedCommandContext } from 'just-bash';
import { createCommandContext, EMPTY_BYTES } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import { builtinScoopGrants, mergePolicies, parseSudoers } from '../../../../src/base/sudoers.js';
import type { BrowserAPI } from '../../../../src/cdp/index.js';
import { VirtualFS } from '../../../../src/fs/index.js';
import { createSudoFs } from '../../../../src/fs/sudo-fs.js';
import { AlmostBashShellHeadless } from '../../../../src/shell/almost-bash-shell-headless.js';
import { createSupplementalCommands } from '../../../../src/shell/supplemental-commands/index.js';
import { screenshotHandler } from '../../../../src/shell/supplemental-commands/playwright/handlers/snapshot.js';
import { stateSaveHandler } from '../../../../src/shell/supplemental-commands/playwright/handlers/state.js';
import {
  DEFAULT_SESSION_ROOT,
  sessionRootFor,
} from '../../../../src/shell/supplemental-commands/playwright/session-log.js';
import type { SudoBroker } from '../../../../src/sudo/types.js';
import { createHandlerCtx } from '../../helpers/playwright-harness.js';

const SCOOP_TMP = '/tmp/cone/agent-zappy';

function memFs(): VirtualFS & { files: Map<string, string | Uint8Array> } {
  const files = new Map<string, string | Uint8Array>();
  return {
    files,
    mkdir: vi.fn(async () => undefined),
    writeFile: vi.fn(async (path: string, content: string | Uint8Array) => {
      files.set(path, content);
    }),
    readFile: vi.fn(async (path: string) => {
      const v = files.get(path);
      if (v === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
      return v;
    }),
  } as unknown as VirtualFS & { files: Map<string, string | Uint8Array> };
}

function denyingBroker() {
  const requestApproval = vi.fn(async () => ({ decision: 'deny' as const }));
  return { broker: { requestApproval } as unknown as SudoBroker, requestApproval };
}

function scoopFs() {
  const raw = memFs();
  const { broker, requestApproval } = denyingBroker();
  const policy = mergePolicies(
    builtinScoopGrants(),
    parseSudoers('NOPASSWD Write /scoops/agent-zappy/**')
  );
  const fs = createSudoFs(raw, {
    broker,
    getPolicy: () => policy,
    defaultDisposition: 'require-approval',
  });
  return { fs, raw, requestApproval };
}

function mockBrowser(): BrowserAPI {
  return {
    listPages: vi.fn(async () => []),
    withTab: async <T>(_t: string, fn: (tab: unknown) => Promise<T>) => fn({}),
  } as unknown as BrowserAPI;
}

function ctxWithTmp(tmp: string): ResolvedCommandContext {
  return createCommandContext({
    fs: {} as import('just-bash').IFileSystem,
    cwd: '/',
    env: new Map([['TMPDIR', tmp]]),
    stdin: EMPTY_BYTES,
  });
}

function playwrightFrom(commands: Command[]): Command {
  const cmd = commands.find((c) => c.name === 'playwright-cli');
  if (!cmd) throw new Error('playwright-cli not registered');
  return cmd;
}

describe('sessionRootFor', () => {
  it('keeps /.playwright for the cone and terminal', () => {
    expect(sessionRootFor(false, '/tmp/cone')).toBe(DEFAULT_SESSION_ROOT);
    expect(sessionRootFor(false, '/tmp')).toBe('/.playwright');
  });

  it("puts a scoop's session root under its own scratch dir", () => {
    expect(sessionRootFor(true, SCOOP_TMP)).toBe(`${SCOOP_TMP}/.playwright`);
    expect(sessionRootFor(true, `${SCOOP_TMP}/`)).toBe(`${SCOOP_TMP}/.playwright`);
  });
});

describe('playwright-cli session log in a sandboxed scoop (#3440)', () => {
  it('never calls the sudo broker and logs under the scoop scratch dir', async () => {
    const { fs, raw, requestApproval } = scoopFs();
    const cmd = playwrightFrom(
      createSupplementalCommands({ fs, browserAPI: mockBrowser(), isScoop: () => true })
    );

    const result = await cmd.execute(['tab-list'], ctxWithTmp(SCOOP_TMP));

    expect(result.exitCode).toBe(0);
    expect(requestApproval).not.toHaveBeenCalled();
    expect(raw.files.get(`${SCOOP_TMP}/.playwright/session.md`)).toContain(
      '### playwright-cli tab-list'
    );
    expect([...raw.files.keys()].some((p) => p.startsWith('/.playwright'))).toBe(false);
  });

  it('two scoops keep separate logs', async () => {
    const { fs, raw } = scoopFs();
    const cmd = playwrightFrom(
      createSupplementalCommands({ fs, browserAPI: mockBrowser(), isScoop: () => true })
    );

    await cmd.execute(['tab-list'], ctxWithTmp('/tmp/cone/a'));
    await cmd.execute(['tab-list'], ctxWithTmp('/tmp/cone/b'));

    expect(raw.files.has('/tmp/cone/a/.playwright/session.md')).toBe(true);
    expect(raw.files.has('/tmp/cone/b/.playwright/session.md')).toBe(true);
  });

  it('the cone still logs to /.playwright', async () => {
    const raw = memFs();
    const cmd = playwrightFrom(
      createSupplementalCommands({ fs: raw, browserAPI: mockBrowser(), isScoop: () => false })
    );

    await cmd.execute(['tab-list'], ctxWithTmp('/tmp/cone'));

    expect(raw.files.get('/.playwright/session.md')).toContain('### playwright-cli tab-list');
  });

  it('a shell with no scoop owner (terminal) still logs to /.playwright', async () => {
    const raw = memFs();
    const cmd = playwrightFrom(createSupplementalCommands({ fs: raw, browserAPI: mockBrowser() }));

    await cmd.execute(['tab-list'], ctxWithTmp('/tmp'));

    expect(raw.files.has('/.playwright/session.md')).toBe(true);
  });
});

describe('through a real scoop shell over a real VirtualFS', () => {
  let dbCounter = 0;

  async function scoopShell(isScoop: boolean) {
    const vfs = await VirtualFS.create({ dbName: `pw-scoop-log-${dbCounter++}`, wipe: true });
    const { broker, requestApproval } = denyingBroker();
    const policy = mergePolicies(
      builtinScoopGrants(),
      parseSudoers('NOPASSWD Write /scoops/agent-zappy/**')
    );
    const fs = createSudoFs(vfs, {
      broker,
      getPolicy: () => policy,
      defaultDisposition: 'require-approval',
    });
    const shell = new AlmostBashShellHeadless({
      fs,
      browserAPI: mockBrowser(),
      isScoop: () => isScoop,
      env: { TMPDIR: SCOOP_TMP },
    });
    return { vfs, shell, requestApproval };
  }

  it('a scoop shell runs playwright-cli with no approval and logs to $TMPDIR', async () => {
    const { vfs, shell, requestApproval } = await scoopShell(true);

    const r = await shell.executeCommand('playwright-cli tab-list');

    expect(r.exitCode).toBe(0);
    expect(requestApproval).not.toHaveBeenCalled();
    const log = await vfs.readTextFile(`${SCOOP_TMP}/.playwright/session.md`);
    expect(log).toContain('### playwright-cli tab-list');
    expect(await vfs.exists('/.playwright')).toBe(false);
  });

  it('the same sandbox would gate /.playwright, which is why scoops avoid it', async () => {
    const { shell, requestApproval } = await scoopShell(false);

    const r = await shell.executeCommand('playwright-cli tab-list');

    expect(r.exitCode).toBe(0);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'write', detail: '/.playwright' })
    );
  });
});

describe('session root drives the screenshot archive and state-save default', () => {
  it('archives a screenshot under the session root without an approval', async () => {
    const { fs, raw, requestApproval } = scoopFs();
    const page = { screenshot: vi.fn(async () => btoa('img')) };
    const browser = {
      withTab: async <T>(_t: string, fn: (tab: typeof page) => Promise<T>) => fn(page),
    } as unknown as BrowserAPI;

    const r = await screenshotHandler(
      createHandlerCtx({
        browser,
        fs,
        flags: { tab: 'tab-1' },
        scratchDir: SCOOP_TMP,
        sessionRoot: `${SCOOP_TMP}/.playwright`,
      })
    );

    expect(r.exitCode).toBe(0);
    expect(requestApproval).not.toHaveBeenCalled();
    const archived = [...raw.files.keys()].filter((p) =>
      p.startsWith(`${SCOOP_TMP}/.playwright/screenshots/screenshot-`)
    );
    expect(archived).toHaveLength(1);
  });

  it('state-save defaults to <sessionRoot>/storage-state.json', async () => {
    const raw = memFs();
    const send = vi.fn(async (method: string, params?: { expression?: string }) => {
      if (method === 'Network.getCookies') return { cookies: [] };
      if (params?.expression === 'location.origin') {
        return { result: { value: 'https://example.com' } };
      }
      return { result: { value: '[]' } };
    });
    const page = { sessionId: 's', transport: { send }, send };
    const browser = {
      withTab: async <T>(_t: string, fn: (tab: typeof page) => Promise<T>) => fn(page),
    } as unknown as BrowserAPI;

    const r = await stateSaveHandler(
      createHandlerCtx({
        browser,
        fs: raw,
        flags: { tab: 'tab-1' },
        sessionRoot: `${SCOOP_TMP}/.playwright`,
      })
    );

    expect(r.exitCode).toBe(0);
    expect(raw.files.has(`${SCOOP_TMP}/.playwright/storage-state.json`)).toBe(true);
  });
});
