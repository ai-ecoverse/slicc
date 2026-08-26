/**
 * `/etc/slicc/keys.json` — the user's keyboard-mode keymap.
 *
 * Shipped defaults live in code ({@link DEFAULT_KEYMAP}); this file is how a
 * user overrides them. It is seeded from `packages/vfs-root/etc/slicc/keys.json`
 * the first time it is missing and never written again — an edited config must
 * survive every later boot, so "seed once" is the whole write policy.
 *
 * ## Why keys map onto command IDS
 *
 * A config that named internals (`"x": "dock.collapse"`) would break whenever
 * the internals moved, and one that named keys only (`"x": "y"`) could not say
 * what a key should DO. {@link CommandId} is the stable middle: a user rebinds
 * `t` to `terminal` without knowing anything about the code, and a default key
 * can change without invalidating anyone's file.
 *
 * ## Failure policy: never lose the keyboard
 *
 * Every failure — missing file, unparseable JSON, unknown command, a key that
 * is not ours to give — degrades to "keep the default for that entry" and logs
 * a warning. A typo in one line must not cost the user the other twelve
 * bindings, and a corrupt file must not cost them the keyboard entirely. Which
 * is also why {@link parseKeymapDocument} returns warnings instead of throwing.
 *
 * ## Boot
 *
 * Loaded lazily, off the boot critical path (see `docs/pitfalls.md` — a VFS
 * read from a boot-time observer starves the terminal's lazy mount). The
 * shortcuts are wired with the defaults synchronously at mount; this arrives
 * later and replaces the map. The window where a custom key is not yet live is
 * the same window in which the shell itself is still assembling.
 */

import defaultKeysDoc from '../../../../vfs-root/etc/slicc/keys.json?raw';
import { createLogger } from '../../base/logger.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { type CommandId, DEFAULT_KEYMAP, isCommandId, RESERVED_KEYS } from './wc-shortcuts.js';

const log = createLogger('wc-shortcut-config');

/** Where the keymap lives. Ungated, like `/workspace/layouts` — a preference, not a capability. */
export const SHORTCUT_KEYS_PATH = '/etc/slicc/keys.json';

export interface KeymapParseResult {
  /** The final map: defaults, with the file's entries applied over them. */
  keymap: Record<string, CommandId>;
  /** Everything ignored, and why — each one a line the user can act on. */
  warnings: string[];
}

/** A named key the config may bind, beyond single characters. */
const NAMED_KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Home', 'End']);

/** Is `key` something a keypress can actually produce, and ours to give away? */
function keyProblem(key: string): string | null {
  if (RESERVED_KEYS.includes(key)) {
    return `"${key}" is reserved (Esc toggles the mode; 1-9 address the tab strip)`;
  }
  // A single character is any printable key; anything longer must be a name we
  // know, or the entry could never match a `KeyboardEvent.key` and would sit
  // in the file looking bound forever.
  if ([...key].length !== 1 && !NAMED_KEYS.has(key)) {
    return `"${key}" is not a key SLICC can bind (use one character, or ${[...NAMED_KEYS].join(', ')})`;
  }
  return null;
}

/**
 * Merge a `keys.json` document over the defaults.
 *
 * Pure and total: any shape of input produces a usable keymap. `null` (or
 * `false`, or `""`) unbinds the default for that key, which is the only way to
 * say "give me nothing here".
 */
export function parseKeymapDocument(
  text: string,
  defaults: Readonly<Record<string, CommandId>> = DEFAULT_KEYMAP
): KeymapParseResult {
  const keymap: Record<string, CommandId> = { ...defaults };
  const warnings: string[] = [];

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    warnings.push(`not valid JSON, keeping the defaults (${(err as Error).message})`);
    return { keymap, warnings };
  }

  const bindings = (doc as { bindings?: unknown } | null)?.bindings;
  if (bindings === undefined) {
    warnings.push('no "bindings" object, keeping the defaults');
    return { keymap, warnings };
  }
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    warnings.push('"bindings" is not an object, keeping the defaults');
    return { keymap, warnings };
  }

  for (const [key, value] of Object.entries(bindings)) {
    const problem = keyProblem(key);
    if (problem) {
      warnings.push(problem);
      continue;
    }
    // Unbind: the default for this key goes away and nothing replaces it.
    if (value === null || value === false || value === '') {
      delete keymap[key];
      continue;
    }
    if (!isCommandId(value)) {
      warnings.push(`"${key}": ${JSON.stringify(value)} is not a known command`);
      continue;
    }
    keymap[key] = value;
  }
  return { keymap, warnings };
}

export interface LoadShortcutConfigDeps {
  reader: Pick<LocalVfsClient, 'readFile'>;
  writer: Pick<WritableVfsClient, 'writeFile' | 'mkdir'>;
  /** Hand the merged keymap to the live wiring. */
  apply(keymap: Readonly<Record<string, CommandId>>): void;
  logger?: {
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
  };
}

/**
 * Does this failure mean the file is not there — as opposed to "I could not
 * ask"? The VFS RPC rejects with an `FsError`-shaped error carrying a code;
 * duck-typed rather than imported so this module keeps no dependency on which
 * side of the worker boundary produced it.
 */
function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

/**
 * Read the user's keymap and apply it, seeding the shipped default the FIRST
 * time — and only then.
 *
 * Never throws and never rejects: a float with no VFS, a worker that went away
 * mid-read, a read-only filesystem all leave the defaults in force, which is a
 * working keyboard.
 *
 * The seed is gated on `ENOENT` specifically, and that is not fussiness. An
 * earlier version seeded on ANY read failure, so a read that failed because
 * the worker's VFS host was not attached yet (an RPC sent too early is lost,
 * not queued) rewrote the file — silently reverting the user's edits on the
 * next boot. A config that can eat your config is worse than no config.
 */
export async function loadShortcutConfig(deps: LoadShortcutConfigDeps): Promise<void> {
  const logger = deps.logger ?? log;
  let text: string;
  try {
    const raw = await deps.reader.readFile(SHORTCUT_KEYS_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if (!isMissing(err)) {
      // Present but unreadable, or unreachable. Either way this is not our
      // file to replace.
      logger.warn('Could not read the shortcut config; keeping the defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }
    // A fresh VFS. Seed the shipped file so the user has something to edit,
    // and stay on defaults — the seed IS the defaults, so there is nothing to
    // apply.
    try {
      await deps.writer.mkdir('/etc/slicc', { recursive: true });
      await deps.writer.writeFile(SHORTCUT_KEYS_PATH, defaultKeysDoc);
      logger.info(`Seeded ${SHORTCUT_KEYS_PATH}`);
    } catch (seedErr) {
      logger.warn('Could not seed the shortcut config', {
        error: seedErr instanceof Error ? seedErr.message : String(seedErr),
      });
    }
    return;
  }

  const { keymap, warnings } = parseKeymapDocument(text);
  for (const warning of warnings) {
    logger.warn(`${SHORTCUT_KEYS_PATH}: ${warning}`);
  }
  deps.apply(keymap);
}
