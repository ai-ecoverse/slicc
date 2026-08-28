/**
 * Drift guards between playwright-cli's four flag vocabularies:
 * the manifest (`slicc-commands.json`, runtime-enforced by validate-args),
 * the global parser spec (`PLAYWRIGHT_FLAG_SPEC`), the help text
 * (`help.ts`), and the handlers themselves.
 *
 * Each invariant here pins a shipped bug class: help documented
 * `--fullPage=true` (a form the boolean-flag parser rejects), `resize --help`
 * omitted the required `--tab`, eight registered verbs had no help entry at
 * all (their `--help` fell back to the full text without mentioning them),
 * and `eval --output=<path>` validated cleanly but was never read — exit 0,
 * file never written.
 */

import { createCommandContext, EMPTY_BYTES } from 'just-bash';
import { describe, expect, it, vi } from 'vitest';
import type { BrowserAPI } from '../../../../src/cdp/index.js';
import type { VirtualFS } from '../../../../src/fs/index.js';
import { playwrightHandlers } from '../../../../src/shell/supplemental-commands/playwright/handlers/index.js';
import { formatHelp } from '../../../../src/shell/supplemental-commands/playwright/help.js';
import manifest from '../../../../src/shell/supplemental-commands/playwright/slicc-commands.json';
import { PLAYWRIGHT_FLAG_SPEC } from '../../../../src/shell/supplemental-commands/playwright/state.js';
import { createPlaywrightCommand } from '../../../../src/shell/supplemental-commands/playwright-command.js';
import { extractSubcommandHelp } from '../../../../src/shell/supplemental-commands/subcommand-help.js';

const HELP_TEXT = formatHelp('playwright-cli');
const COMMANDS = manifest.commands as Record<
  string,
  { args?: string[]; variadic?: boolean; flags?: Record<string, string> }
>;

/** Verbs that accept --tab but do not require it (no requireTab in the handler). */
const TAB_OPTIONAL = new Set(['fetch', 'record', 'stop-recording']);

/** Flags the dispatcher special-cases outside PLAYWRIGHT_FLAG_SPEC. */
const SPECIAL_FLAGS = new Set(['no-iframes', 'help', 'h']);

describe('playwright-cli help/manifest/parser drift', () => {
  it('every manifest command has an extractable help entry', () => {
    const missing = Object.keys(COMMANDS).filter(
      (verb) => extractSubcommandHelp(HELP_TEXT, verb) === null
    );
    expect(missing).toEqual([]);
  });

  it('every registered handler verb has an extractable help entry', () => {
    const missing = [...playwrightHandlers.keys()].filter(
      (verb) => extractSubcommandHelp(HELP_TEXT, verb) === null
    );
    expect(missing).toEqual([]);
  });

  it('every manifest flag is declared in PLAYWRIGHT_FLAG_SPEC', () => {
    const known = new Set([
      ...(PLAYWRIGHT_FLAG_SPEC.string ?? []),
      ...(PLAYWRIGHT_FLAG_SPEC.boolean ?? []),
      ...Object.keys(PLAYWRIGHT_FLAG_SPEC.alias ?? {}),
      ...Object.values(PLAYWRIGHT_FLAG_SPEC.alias ?? {}).flat(),
    ]);
    const undeclared = Object.entries(COMMANDS).flatMap(([verb, spec]) =>
      Object.keys(spec.flags ?? {})
        .filter((flag) => !known.has(flag) && !SPECIAL_FLAGS.has(flag))
        .map((flag) => `${verb} --${flag}`)
    );
    expect(undeclared).toEqual([]);
  });

  it('every tab-requiring verb shows --tab in its help entry', () => {
    const missing = Object.entries(COMMANDS)
      .filter(([verb, spec]) => spec.flags?.['tab'] && !TAB_OPTIONAL.has(verb))
      .filter(([verb]) => {
        const entry = extractSubcommandHelp(HELP_TEXT, verb);
        return entry !== null && !entry.includes('--tab');
      })
      .map(([verb]) => verb);
    expect(missing).toEqual([]);
  });

  it('help never documents an attached value on a boolean flag', () => {
    // The known-flag walk only accepts boolean flags as the exact token, so a
    // documented `--flag=true` is a documented parse error (`--fullPage=true`).
    const documented = (PLAYWRIGHT_FLAG_SPEC.boolean ?? []).filter((flag) =>
      HELP_TEXT.includes(`--${flag}=`)
    );
    expect(documented).toEqual([]);
  });
});

const mockCtx = createCommandContext({
  fs: {} as import('just-bash').IFileSystem,
  cwd: '/',
  env: new Map<string, string>(),
  stdin: EMPTY_BYTES,
});

function mkBrowser(): BrowserAPI {
  return {
    listPages: vi
      .fn()
      .mockResolvedValue([
        { targetId: 'tab-1', title: 'T', url: 'https://x.com', type: 'page', attached: false },
      ]),
    attachToPage: vi.fn().mockResolvedValue(undefined),
    evaluate: vi.fn().mockResolvedValue('42'),
    sendCDP: vi.fn().mockResolvedValue({}),
    withTab: async (_t: string, fn: (s: string) => Promise<unknown>) => fn('sess'),
    getTransport: () => ({ send: vi.fn(), on: vi.fn(), off: vi.fn() }),
  } as unknown as BrowserAPI;
}

function mkFs(): { fs: VirtualFS; writes: Map<string, unknown> } {
  const writes = new Map<string, unknown>();
  const fs = {
    writeFile: vi.fn(async (p: string, c: unknown) => void writes.set(p, c)),
    mkdir: vi.fn().mockResolvedValue(undefined),
    readTextFile: vi.fn().mockResolvedValue('1+1'),
    exists: vi.fn().mockResolvedValue(false),
  } as unknown as VirtualFS;
  return { fs, writes };
}

describe('playwright-cli output-flag aliases (regressions)', () => {
  it('eval --output=<path> writes the result file', async () => {
    const { fs, writes } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    const result = await cmd.execute(
      ['eval', '--tab=tab-1', '--output=/tmp/out.txt', '1+1'],
      mockCtx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Result saved to /tmp/out.txt');
    expect(writes.get('/tmp/out.txt')).toBe('42');
  });

  it('rejects --filename and --output together on both verbs (aliases with no defined precedence)', async () => {
    const { fs, writes } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    for (const argv of [
      ['eval', '--tab=tab-1', '--filename=/tmp/a', '--output=/tmp/b', '1+1'],
      ['eval-file', '--tab=tab-1', '--filename=/tmp/a', '--output=/tmp/b', '/script.js'],
    ]) {
      const result = await cmd.execute(argv, mockCtx);
      expect(result.exitCode, argv[0]).toBe(1);
      expect(result.stderr).toContain('pass one, not both');
    }
    // Neither alias path may have been written (the session log is unrelated).
    expect([...writes.keys()].filter((k) => k.startsWith('/tmp'))).toEqual([]);
  });

  it('eval-file --filename=<path> writes the result file', async () => {
    const { fs, writes } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    const result = await cmd.execute(
      ['eval-file', '--tab=tab-1', '--filename=/tmp/out.txt', '/script.js'],
      mockCtx
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Result saved to /tmp/out.txt');
    expect(writes.get('/tmp/out.txt')).toBe('42');
  });
});

describe('playwright-cli per-verb help (regressions)', () => {
  it('resize --help mentions --tab', async () => {
    const { fs } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    const result = await cmd.execute(['resize', '--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('--tab');
  });

  it('upload --help shows the upload entry, not the full-help fallback', async () => {
    const { fs } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    const result = await cmd.execute(['upload', '--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: playwright-cli upload');
  });

  it('close --help resolves via the tab-close|close alias head', async () => {
    const { fs } = mkFs();
    const cmd = createPlaywrightCommand('playwright-cli', mkBrowser(), fs);
    const result = await cmd.execute(['close', '--help'], mockCtx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Close tab by targetId');
  });

  it('screenshot help documents the bare boolean form only', () => {
    const entry = extractSubcommandHelp(HELP_TEXT, 'screenshot');
    expect(entry).toContain('--fullPage|--full-page');
    expect(entry).not.toContain('--fullPage=');
  });
});
