import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export function piAiModelDataGeneratedAt(workspaceRoot: string): number | null {
  const manifestPath = resolve(
    workspaceRoot,
    'node_modules/@earendil-works/pi-ai/dist/providers/data/.manifest.json'
  );
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { generatedAt?: unknown };
  const generatedAt =
    typeof manifest.generatedAt === 'string' ? Date.parse(manifest.generatedAt) : Number.NaN;
  return Number.isNaN(generatedAt) ? null : generatedAt;
}
