/**
 * Guard for the whole verb-dispatching command family: asking a subcommand
 * for help must PRINT help, never DO the thing.
 *
 * A dispatcher that only checks `args[0] === '--help'` routes
 * `cmd <verb> --help` into the verb's handler. Handlers that default a
 * missing argument then run for real — `playwright-cli record --help` opened
 * a tab and started a HAR recording, `v86 stop --help` powered the VM off,
 * `layout reset --help` rearranged the workbench, `mcp delete x --help`
 * deleted the server.
 *
 * Two layers here:
 *
 *  1. Every command is built with dependencies that throw on *use* (see
 *     `hostile`), then every verb is run with `--help`. A help path that
 *     touches the browser, the VFS, the network, or a manager fails the
 *     test with the call site in the message.
 *  2. `DISPATCHERS` is checked against a scan of the source directory, so a
 *     new verb-dispatching command — or a new verb on an existing one —
 *     cannot be added without landing in layer 1.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createSupplementalCommands } from '../../../src/shell/supplemental-commands/index.js';
import { playwrightHandlers } from '../../../src/shell/supplemental-commands/playwright/handlers/index.js';
import {
  createSkillCommand,
  createUpskillCommand,
} from '../../../src/shell/supplemental-commands/upskill/index.js';

const SRC_DIR = new URL('../../../src/shell/supplemental-commands/', import.meta.url).pathname;

/**
 * A dependency that is safe to hold but explodes on use: property reads
 * return another hostile stub (so factories can destructure), while any call
 * throws. A `--help` path must never get as far as calling one.
 */
function hostile(label: string): any {
  return new Proxy(function hostileTarget() {} as any, {
    get: (_target, prop) => {
      if (typeof prop === 'symbol' || prop === 'then') return undefined;
      return hostile(`${label}.${String(prop)}`);
    },
    apply: () => {
      throw new Error(`--help reached a live dependency: ${label}()`);
    },
  });
}

/**
 * Verb-dispatching commands, with the verbs they accept. `verbs: 'source'`
 * derives them from the dispatcher itself (see {@link extractDispatchVerbs})
 * so a newly added `case` is covered automatically.
 */
interface Dispatcher {
  /** Registered command name. */
  command: string;
  /** Source file under `src/shell/supplemental-commands/`. */
  source: string;
  /** Explicit verb list, or `'source'` to derive it from the dispatcher. */
  verbs: readonly string[] | 'source';
  /** Verbs the source scan cannot see (parsed by a helper, not the dispatcher). */
  extraVerbs?: readonly string[];
}

const DISPATCHERS: readonly Dispatcher[] = [
  // Fixed here: help used to open a tab / start a HAR recording.
  {
    command: 'playwright-cli',
    source: 'playwright-command.ts',
    verbs: [...playwrightHandlers.keys()],
  },
  // Fixed here: help used to stop the VM, start the frame pump, type into the guest.
  { command: 'v86', source: 'v86-command.ts', verbs: 'source' },
  // Fixed here: help used to reset/rearrange the workbench.
  { command: 'layout', source: 'layout-command.ts', verbs: 'source', extraVerbs: ['list'] },
  // Fixed here: help used to render itself as Tool-UI HTML.
  { command: 'sprinkle', source: 'sprinkle-command.ts', verbs: 'source' },
  // Fixed here: help used to delete/remove the named server/plugin.
  { command: 'mcp', source: 'mcp-command.ts', verbs: 'source' },
  { command: 'plugin', source: 'plugin-command.ts', verbs: 'source' },
  // Fixed here: help exited non-zero with an arg error instead of helping.
  { command: 'workflow', source: 'workflow-command.ts', verbs: 'source', extraVerbs: ['run'] },
  { command: 'session', source: 'session-command.ts', verbs: 'source' },
  { command: 'hf', source: 'hf-command.ts', verbs: 'source' },
  { command: 'fswatch', source: 'fswatch-command.ts', verbs: ['create', 'list', 'delete'] },
  { command: 'di', source: 'di-command.ts', verbs: 'source' },
  // Already correct (top-level `args.includes('--help')`) — pinned so they stay that way.
  { command: 'crontask', source: 'crontask-command.ts', verbs: 'source' },
  { command: 'diskutil', source: 'df-command.ts', verbs: 'source' },
  { command: 'esptool', source: 'esptool-command.ts', verbs: 'source' },
  { command: 'hid', source: 'hid-command.ts', verbs: 'source' },
  { command: 'host', source: 'host-command.ts', verbs: 'source' },
  { command: 'ipk', source: 'ipk-command.ts', verbs: 'source' },
  { command: 'local-llm', source: 'local-llm-command.ts', verbs: 'source' },
  { command: 'oauth-domain', source: 'oauth-domain-command.ts', verbs: 'source' },
  { command: 'secret', source: 'secret-command.ts', verbs: 'source' },
  { command: 'serial', source: 'serial-command.ts', verbs: 'source' },
  { command: 'theme', source: 'theme-command.ts', verbs: 'source' },
  { command: 'upgrade', source: 'upgrade-command.ts', verbs: 'source' },
  { command: 'usb', source: 'usb-command.ts', verbs: 'source' },
  { command: 'webhook', source: 'webhook-command.ts', verbs: 'source' },
  { command: 'skill', source: 'upskill/skill-command.ts', verbs: 'source' },
  { command: 'upskill', source: 'upskill/upskill-command.ts', verbs: 'source' },
];

/**
 * Files that pattern-match as verb dispatchers but are not: pass-through
 * runners forward `--help` to the program they run, which is correct.
 */
const NOT_DISPATCHERS = new Map<string, string>([
  ['ipx-command.ts', "npx-like runner — `ipx <bin> --help` is the bin's help, not ours"],
]);

/** Read the balanced `{...}` block that starts at `open`. */
function balancedBlock(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}' && --depth === 0) return source.slice(open, i);
  }
  return source.slice(open);
}

/**
 * Verbs a dispatcher accepts: the `case` labels of its `switch (sub)` (only
 * that switch — unrelated switches elsewhere in the file are ignored) plus
 * `sub === '...'` / `args[0] === '...'` comparisons.
 */
function extractDispatchVerbs(source: string): string[] {
  const verbs = new Set<string>();
  for (const m of source.matchAll(/switch \((?:sub|subcommand|verb|action)\)\s*\{/g)) {
    const block = balancedBlock(source, m.index + m[0].length - 1);
    for (const label of block.matchAll(/case '([^']+)':/g)) verbs.add(label[1]);
  }
  for (const cmp of source.matchAll(
    /(?:args\[0\]|sub|subcommand|verb) (?:===|!==) '([a-z][\w:-]*)'/g
  )) {
    verbs.add(cmp[1]);
  }
  verbs.delete('help');
  return [...verbs];
}

function verbsFor(entry: Dispatcher): string[] {
  const declared =
    entry.verbs === 'source'
      ? extractDispatchVerbs(readFileSync(join(SRC_DIR, entry.source), 'utf8'))
      : [...entry.verbs];
  return [...new Set([...declared, ...(entry.extraVerbs ?? [])])];
}

const commands = new Map(
  createSupplementalCommands({
    fs: hostile('fs'),
    fetch: hostile('fetch'),
    browserAPI: hostile('browserAPI'),
  }).map((c) => [c.name, c])
);
commands.set('skill', createSkillCommand(hostile('fs')));
commands.set(
  'upskill',
  createUpskillCommand(hostile('fs'), hostile('fetch'), hostile('browserAPI'))
);

const run = (command: string, args: string[]) =>
  (commands.get(command) as any).execute(args, { cwd: '/', env: {}, fs: hostile('ctx.fs') });

describe('subcommand --help', () => {
  for (const entry of DISPATCHERS) {
    describe(entry.command, () => {
      it('is registered', () => {
        expect(commands.has(entry.command)).toBe(true);
      });

      it('answers bare --help', async () => {
        const r = await run(entry.command, ['--help']);
        expect(r.exitCode).toBe(0);
        expect(r.stdout).not.toBe('');
      });

      for (const verb of verbsFor(entry)) {
        it(`answers \`${entry.command} ${verb} --help\` without running ${verb}`, async () => {
          const r = await run(entry.command, [verb, '--help']);
          // Any side effect on the help path throws out of `hostile`, so
          // reaching these assertions already proves the verb did not run.
          expect(r.stderr).toBe('');
          expect(r.exitCode).toBe(0);
          expect(r.stdout.length).toBeGreaterThan(0);
        });
      }
    });
  }
});

describe('subcommand --help coverage', () => {
  /** Same detection the reviewer would do by eye: does this file dispatch on a verb? */
  function dispatchesOnVerb(source: string): boolean {
    return (
      /switch \((?:sub|subcommand|verb|action)\)/.test(source) ||
      /\b(?:sub|subcommand|verb)\s*=\s*args\[0\]/.test(source) ||
      /args\[0\] === '(?!help)[a-z]/.test(source)
    );
  }

  function sourceFiles(): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(SRC_DIR, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        for (const nested of readdirSync(join(SRC_DIR, entry.name))) {
          if (nested.endsWith('.ts')) files.push(`${entry.name}/${nested}`);
        }
      } else if (entry.name.endsWith('.ts')) {
        files.push(entry.name);
      }
    }
    return files;
  }

  it('every verb-dispatching command is covered above', () => {
    const covered = new Set(DISPATCHERS.map((d) => d.source));
    const missing = sourceFiles().filter(
      (file) =>
        !covered.has(file) &&
        !NOT_DISPATCHERS.has(file) &&
        dispatchesOnVerb(readFileSync(join(SRC_DIR, file), 'utf8'))
    );
    // Add the command to DISPATCHERS (and make `<verb> --help` print help
    // before the handler runs), or to NOT_DISPATCHERS with the reason.
    expect(missing).toEqual([]);
  });
});
