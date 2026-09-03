/**
 * `/etc/slicc/keys.json` — the user's keyboard-mode keymap.
 *
 * Shipped defaults live in code ({@link DEFAULT_KEYMAP}); this file is how a
 * user overrides them. It is seeded from `packages/vfs-root/etc/slicc/keys.json`
 * the first time it is missing — an edited config must survive every later
 * boot, so "seed once, then never write what the user might have touched" is
 * the whole write policy.
 *
 * ## The one exception, and why it exists
 *
 * The v1 seed listed all sixteen of its bindings explicitly. Since the file is
 * applied OVER the defaults, that made every v1 install permanently pinned to
 * the v1 keyboard: a newly shipped map would have reached nobody who had ever
 * started SLICC, and neither would the keys for commands that did not exist
 * yet. So a file that still holds the v1 map exactly
 * ({@link isUntouchedV1Document}) is replaced ONCE by the shipped document —
 * which now carries no bindings at all, precisely so this can never be needed
 * a second time. Anything else, including a v1 map with one line changed, is
 * somebody's config and is left alone.
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
import {
  type CommandId,
  DEFAULT_KEYMAP,
  DEFAULT_TRIGGER,
  isCommandId,
  type KeyboardTrigger,
  parseKeyboardTrigger,
  RESERVED_KEYS,
  V1_KEYMAP,
} from './wc-shortcuts.js';

const log = createLogger('wc-shortcut-config');

/** Where the keymap lives. Ungated, like `/workspace/layouts` — a preference, not a capability. */
export const SHORTCUT_KEYS_PATH = '/etc/slicc/keys.json';

export interface KeymapParseResult {
  /** The final map: defaults, with the file's entries applied over them. */
  keymap: Record<string, CommandId>;
  /**
   * How keyboard mode is entered. Omitted / unknown in the file →
   * {@link DEFAULT_TRIGGER}. Explicit `null` disables the mode.
   */
  trigger: KeyboardTrigger;
  /** Everything ignored, and why — each one a line the user can act on. */
  warnings: string[];
}

/** What the loader hands the live shell after a successful read. */
export interface ShortcutConfig {
  keymap: Readonly<Record<string, CommandId>>;
  trigger: KeyboardTrigger;
}

/** A named key the config may bind, beyond single characters. */
const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',
  // The arrows carry the tab strip in the shipped map. Bindable for the same
  // reason they were chosen: nothing else in the shell wants them while the
  // mode is on, and ↑/↓ still scroll the transcript because nothing binds them.
  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

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
  let trigger: KeyboardTrigger = DEFAULT_TRIGGER;

  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch (err) {
    warnings.push(`not valid JSON, keeping the defaults (${(err as Error).message})`);
    return { keymap, trigger, warnings };
  }

  const root = doc as { bindings?: unknown; trigger?: unknown } | null;
  if (root && Object.hasOwn(root, 'trigger')) {
    const parsed = parseKeyboardTrigger(root.trigger);
    if (parsed === undefined) {
      warnings.push(
        `"trigger": ${JSON.stringify(root.trigger)} is not null, "esc", or "auto"; keeping ${JSON.stringify(DEFAULT_TRIGGER)}`
      );
    } else {
      trigger = parsed;
    }
  }

  const bindings = root?.bindings;
  if (bindings === undefined) {
    warnings.push('no "bindings" object, keeping the defaults');
    return { keymap, trigger, warnings };
  }
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) {
    warnings.push('"bindings" is not an object, keeping the defaults');
    return { keymap, trigger, warnings };
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
  return { keymap, trigger, warnings };
}

/**
 * Does this document still hold the v1 keymap, entry for entry?
 *
 * The v1 seed wrote all sixteen bindings out EXPLICITLY, and the file is
 * applied over the defaults — so every install that ever booted v1 has a file
 * that pins v1 forever, and a new shipped map would reach nobody. This is the
 * "nobody has touched it" test that makes the one-time replacement safe: an
 * exact match on the whole set, so a single added, removed or re-pointed
 * binding (the shapes an edit takes) fails it and the file is left alone.
 *
 * Deliberately not a version stamp — the file it has to recognise was written
 * before there was anything to stamp.
 */
export function isUntouchedV1Document(text: string): boolean {
  let bindings: unknown;
  try {
    bindings = (JSON.parse(text) as { bindings?: unknown } | null)?.bindings;
  } catch {
    // Unparseable is not untouched: somebody edited it and broke it, and
    // overwriting would throw away what they were trying to say.
    return false;
  }
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return false;
  // Narrowed to an object above, which is all `Object.entries` needs — the
  // values stay unknown and are compared, never used as anything.
  const entries = Object.entries(bindings);
  if (entries.length !== Object.keys(V1_KEYMAP).length) return false;
  return entries.every(([key, value]) => V1_KEYMAP[key] === value);
}

export interface LoadShortcutConfigDeps {
  reader: Pick<LocalVfsClient, 'readFile'>;
  writer: Pick<WritableVfsClient, 'writeFile' | 'mkdir'>;
  /** Hand the merged keymap + trigger mode to the live wiring. */
  apply(config: ShortcutConfig): void;
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

  // A file nobody has edited is not a preference, it is a fossil of the map
  // SLICC shipped when the user first booted — and while it sits there they
  // can never receive another one. Replace it once, with the document that
  // holds no bindings at all, so the defaults are theirs again and every
  // later change reaches them. A write that fails changes nothing: the v1
  // keymap below is still applied, and the next boot tries again.
  if (isUntouchedV1Document(text)) {
    try {
      await deps.writer.writeFile(SHORTCUT_KEYS_PATH, defaultKeysDoc);
      logger.info(`Replaced the untouched v1 keymap at ${SHORTCUT_KEYS_PATH}`);
      return;
    } catch (err) {
      logger.warn('Could not replace the v1 shortcut config; keeping it', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const { keymap, trigger, warnings } = parseKeymapDocument(text);
  for (const warning of warnings) {
    logger.warn(`${SHORTCUT_KEYS_PATH}: ${warning}`);
  }
  deps.apply({ keymap, trigger });
}

/** On-disk shape of `/etc/slicc/keys.json` for in-place `trigger` patches. */
interface KeysJsonDocument {
  '//'?: unknown;
  trigger?: unknown;
  bindings?: unknown;
}

/**
 * Rewrite only the `trigger` field of `/etc/slicc/keys.json`, preserving the
 * comment and whatever bindings the user already has.
 *
 * Used by the Theme dialog's keyboard-mode switcher so a click is durable
 * without forcing a reload. Missing file → seed the shipped document first
 * (same policy as {@link loadShortcutConfig}), then patch.
 */
export async function writeShortcutTrigger(
  deps: {
    reader: Pick<LocalVfsClient, 'readFile'>;
    writer: Pick<WritableVfsClient, 'writeFile' | 'mkdir'>;
  },
  trigger: KeyboardTrigger
): Promise<void> {
  let text: string | null = null;
  try {
    const raw = await deps.reader.readFile(SHORTCUT_KEYS_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if (!isMissing(err)) throw err;
  }

  let doc: KeysJsonDocument;
  if (text === null) {
    await deps.writer.mkdir('/etc/slicc', { recursive: true });
    doc = JSON.parse(defaultKeysDoc) as KeysJsonDocument;
  } else {
    try {
      const parsed = JSON.parse(text) as unknown;
      doc =
        typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
          ? (parsed as KeysJsonDocument)
          : (JSON.parse(defaultKeysDoc) as KeysJsonDocument);
    } catch {
      doc = JSON.parse(defaultKeysDoc) as KeysJsonDocument;
    }
  }

  doc.trigger = trigger;
  if (typeof doc.bindings !== 'object' || doc.bindings === null || Array.isArray(doc.bindings)) {
    doc.bindings = {};
  }
  await deps.writer.writeFile(SHORTCUT_KEYS_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}
