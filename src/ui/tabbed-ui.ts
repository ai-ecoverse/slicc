export const EXTENSION_TAB_SPECS = [
  { id: 'chat', label: 'Chat' },
  { id: 'terminal', label: 'Terminal' },
  { id: 'files', label: 'Files' },
  { id: 'memory', label: 'Memory' },
] as const;

export type ExtensionTabId = (typeof EXTENSION_TAB_SPECS)[number]['id'];

export const DEFAULT_EXTENSION_TAB_ID: ExtensionTabId = 'chat';

const EXTENSION_TAB_ID_SET = new Set<string>(EXTENSION_TAB_SPECS.map(tab => tab.id));

export function isExtensionTabId(value: string): value is ExtensionTabId {
  return EXTENSION_TAB_ID_SET.has(value);
}

export function normalizeExtensionTabId(
  value: string | null | undefined,
  fallback: ExtensionTabId = DEFAULT_EXTENSION_TAB_ID,
): ExtensionTabId {
  return value && isExtensionTabId(value) ? value : fallback;
}