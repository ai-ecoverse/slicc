import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * `built-in/azure-openai.ts` and `@earendil-works/pi-ai`'s OpenAI-compatible
 * providers must share ONE openai SDK copy. `AzureOpenAI` instantiates every
 * SDK resource, so nothing tree-shakes, and a second copy adds one full SDK
 * per realm (+443.8 KiB total JS for openai 7.59.0 beside pi-ai's 7.19.0,
 * #4373). The first-load gate cannot see it: both copies are lazy chunks.
 *
 * `renovate.json` caps openai at pi-ai's pin. When a pi-ai bump moves its own
 * openai pin, these assertions fail on that PR: move the webapp pin AND the
 * Renovate cap to pi-ai's new version, then run `npm install`.
 */

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const readJson = (path: string) => JSON.parse(readFileSync(resolve(repoRoot, path), 'utf8'));

interface LockEntry {
  version?: string;
  dependencies?: Record<string, string>;
}

const lockPackages = readJson('package-lock.json').packages as Record<string, LockEntry>;
const webappPin = readJson('packages/webapp/package.json').dependencies.openai as string;
const piAiOpenai = lockPackages['node_modules/@earendil-works/pi-ai']?.dependencies?.openai;

describe('openai single SDK copy', () => {
  it('pins the webapp to the openai version pi-ai declares', () => {
    expect(piAiOpenai, 'pi-ai no longer depends on openai; drop this guard').toBeDefined();
    expect(webappPin).toBe(piAiOpenai);
  });

  it('resolves exactly one openai install in the lockfile', () => {
    const installs = Object.keys(lockPackages).filter(
      (path) => path === 'node_modules/openai' || path.endsWith('/node_modules/openai')
    );
    expect(installs).toEqual(['node_modules/openai']);
    expect(lockPackages['node_modules/openai'].version).toBe(webappPin);
  });

  it('caps openai in renovate.json at the shared pin', () => {
    const rules = readJson('renovate.json').packageRules as {
      matchPackageNames?: string[];
      allowedVersions?: string;
    }[];
    const cap = rules.find((rule) => rule.matchPackageNames?.includes('openai'));
    expect(cap?.allowedVersions).toBe(`<=${webappPin}`);
  });
});
