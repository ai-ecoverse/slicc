import { fileURLToPath } from 'node:url';

export function managerEntries(entry: string[] = []): string[] {
  return [...entry, fileURLToPath(import.meta.resolve('./manager.tsx'))];
}
