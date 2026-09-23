import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Generation time (epoch ms) of pi-ai's bundled model catalogue, for the
 * `__PI_AI_MODELS_GENERATED_AT__` define. `getBuiltinModelDataGeneratedAt()`
 * returns the same value at runtime, but importing it bundles pi-ai's whole
 * data manifest (a hash per provider file) into the eager boot graph just to
 * read one timestamp. The manifest path is not in pi-ai's package exports, so
 * it is read from `node_modules` like the other pi-ai aliases in these configs.
 */
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
