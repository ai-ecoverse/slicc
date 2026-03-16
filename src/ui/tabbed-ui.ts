/** All built-in extension tab specs. Dynamic sprinkles are added at runtime. */
const ALL_EXTENSION_TAB_SPECS = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'memory', label: 'Memory' },
] as const;

const HIDDEN_TABS_KEY = 'slicc-hidden-tabs';
const DEFAULT_HIDDEN_TABS = ['terminal', 'memory'];

/** Read hidden tab IDs from localStorage. */
function getHiddenTabs(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_TABS_KEY);
    if (!raw) return new Set(DEFAULT_HIDDEN_TABS);
    return new Set(JSON.parse(raw) as string[]);
  } catch { return new Set(DEFAULT_HIDDEN_TABS); }
}

/** Set hidden tab IDs in localStorage. Chat cannot be hidden. */
export function setHiddenTabs(ids: string[]): void {
  const filtered = ids.filter(id => id !== 'chat');
  localStorage.setItem(HIDDEN_TABS_KEY, JSON.stringify(filtered));
}

/** Visible extension tab specs (filtered by localStorage config). */
export const EXTENSION_TAB_SPECS = ALL_EXTENSION_TAB_SPECS.filter(
  tab => !getHiddenTabs().has(tab.id),
);

/** Built-in tab id union. Dynamic sprinkles use arbitrary string ids. */
export type BuiltinExtensionTabId = (typeof ALL_EXTENSION_TAB_SPECS)[number]['id'];

/**
 * Extension tab id — widened to `string` so dynamic sprinkle ids (e.g. 'sprinkle-dash')
 * work without type errors. Built-in ids are still checked where needed.
 */
export type ExtensionTabId = string;

export const DEFAULT_EXTENSION_TAB_ID: ExtensionTabId = 'chat';

const BUILTIN_TAB_ID_SET = new Set<string>(ALL_EXTENSION_TAB_SPECS.map(tab => tab.id));

/** Check if a value is a built-in extension tab id. */
export function isBuiltinExtensionTabId(value: string): value is BuiltinExtensionTabId {
  return BUILTIN_TAB_ID_SET.has(value);
}

/**
 * @deprecated Use isBuiltinExtensionTabId for strict checks.
 * This now returns true for any non-empty string (dynamic sprinkles are valid).
 */
export function isExtensionTabId(value: string): value is ExtensionTabId {
  return value.length > 0;
}

/**
 * Normalize a tab id. Returns the value if non-empty, otherwise the fallback.
 * Accepts both built-in and dynamic sprinkle ids.
 */
export function normalizeExtensionTabId(
  value: string | null | undefined,
  fallback: ExtensionTabId = DEFAULT_EXTENSION_TAB_ID,
): ExtensionTabId {
  return value && value.length > 0 ? value : fallback;
}
