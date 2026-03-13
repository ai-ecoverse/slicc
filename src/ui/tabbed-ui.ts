/** Built-in extension tab specs. Dynamic panels (SHTML) are added at runtime. */
export const EXTENSION_TAB_SPECS = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'memory', label: 'Memory' },
] as const;

/** Built-in tab id union. Dynamic panels use arbitrary string ids. */
export type BuiltinExtensionTabId = (typeof EXTENSION_TAB_SPECS)[number]['id'];

/**
 * Extension tab id — widened to `string` so dynamic panel ids (e.g. 'shtml-dash')
 * work without type errors. Built-in ids are still checked where needed.
 */
export type ExtensionTabId = string;

export const DEFAULT_EXTENSION_TAB_ID: ExtensionTabId = 'chat';

const BUILTIN_TAB_ID_SET = new Set<string>(EXTENSION_TAB_SPECS.map(tab => tab.id));

/** Check if a value is a built-in extension tab id. */
export function isBuiltinExtensionTabId(value: string): value is BuiltinExtensionTabId {
  return BUILTIN_TAB_ID_SET.has(value);
}

/**
 * @deprecated Use isBuiltinExtensionTabId for strict checks.
 * This now returns true for any non-empty string (dynamic panels are valid).
 */
export function isExtensionTabId(value: string): value is ExtensionTabId {
  return value.length > 0;
}

/**
 * Normalize a tab id. Returns the value if non-empty, otherwise the fallback.
 * Accepts both built-in and dynamic panel ids.
 */
export function normalizeExtensionTabId(
  value: string | null | undefined,
  fallback: ExtensionTabId = DEFAULT_EXTENSION_TAB_ID,
): ExtensionTabId {
  return value && value.length > 0 ? value : fallback;
}
