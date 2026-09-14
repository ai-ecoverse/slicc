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

export const SHORTCUT_KEYS_PATH = '/etc/slicc/keys.json';

export interface KeymapParseResult {
  keymap: Record<string, CommandId>;

  trigger: KeyboardTrigger;

  warnings: string[];
}

export interface ShortcutConfig {
  keymap: Readonly<Record<string, CommandId>>;
  trigger: KeyboardTrigger;
}

const NAMED_KEYS = new Set([
  'Enter',
  'Tab',
  'Backspace',
  'Delete',
  'Home',
  'End',

  'ArrowLeft',
  'ArrowRight',
  'ArrowUp',
  'ArrowDown',
]);

function keyProblem(key: string): string | null {
  if (RESERVED_KEYS.includes(key)) {
    return `"${key}" is reserved (Esc toggles the mode; 1-9 address the tab strip)`;
  }

  if ([...key].length !== 1 && !NAMED_KEYS.has(key)) {
    return `"${key}" is not a key SLICC can bind (use one character, or ${[...NAMED_KEYS].join(', ')})`;
  }
  return null;
}

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

export function isUntouchedV1Document(text: string): boolean {
  let bindings: unknown;
  try {
    bindings = (JSON.parse(text) as { bindings?: unknown } | null)?.bindings;
  } catch {
    return false;
  }
  if (typeof bindings !== 'object' || bindings === null || Array.isArray(bindings)) return false;

  const entries = Object.entries(bindings);
  if (entries.length !== Object.keys(V1_KEYMAP).length) return false;
  return entries.every(([key, value]) => V1_KEYMAP[key] === value);
}

export interface LoadShortcutConfigDeps {
  reader: Pick<LocalVfsClient, 'readFile'>;
  writer: Pick<WritableVfsClient, 'writeFile' | 'mkdir'>;

  apply(config: ShortcutConfig): void;
  logger?: {
    info(msg: string, ...rest: unknown[]): void;
    warn(msg: string, ...rest: unknown[]): void;
  };
}

function isMissing(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === 'ENOENT';
}

export async function loadShortcutConfig(deps: LoadShortcutConfigDeps): Promise<void> {
  const logger = deps.logger ?? log;
  let text: string;
  try {
    const raw = await deps.reader.readFile(SHORTCUT_KEYS_PATH, { encoding: 'utf-8' });
    text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
  } catch (err) {
    if (!isMissing(err)) {
      logger.warn('Could not read the shortcut config; keeping the defaults', {
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

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

interface KeysJsonDocument {
  '//'?: unknown;
  trigger?: unknown;
  bindings?: unknown;
}

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
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error(
        `${SHORTCUT_KEYS_PATH} is not valid JSON; fix or remove it before changing trigger`,
        { cause: err }
      );
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error(`${SHORTCUT_KEYS_PATH} must be a JSON object`);
    }
    doc = parsed as KeysJsonDocument;
  }

  doc.trigger = trigger;
  if (typeof doc.bindings !== 'object' || doc.bindings === null || Array.isArray(doc.bindings)) {
    doc.bindings = {};
  }
  await deps.writer.writeFile(SHORTCUT_KEYS_PATH, `${JSON.stringify(doc, null, 2)}\n`);
}
