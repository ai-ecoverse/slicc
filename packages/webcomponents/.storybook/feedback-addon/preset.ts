import { fileURLToPath } from 'node:url';

/**
 * Local dev-only addon preset. Registers the manager-side panel entry so
 * Storybook's manager builder bundles `manager.tsx` (esbuild handles JSX),
 * rather than Node importing it directly.
 */
export function managerEntries(entry: string[] = []): string[] {
  return [...entry, fileURLToPath(import.meta.resolve('./manager.tsx'))];
}
