import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const source = readFileSync(join(here, '..', '..', 'src', 'ui', 'main.ts'), 'utf8');

describe('ui/main.ts OAuth replica bridge wiring', () => {
  it('imports both setters from the proxied-fetch module', () => {
    expect(source).toMatch(
      /import\s+\{\s*setBridgeToken,\s*setLocalApiBaseUrl\s*\}\s+from\s+['"]\.\.\/shell\/proxied-fetch\.js['"]/
    );
  });

  it('sets the local API base before the OAuth bootstrap runs', () => {
    const wiringIdx = source.indexOf('setLocalApiBaseUrl(bridge.apiBaseUrl)');
    const bootstrapIdx = source.indexOf('bootstrapOAuthReplicas()');
    expect(wiringIdx).toBeGreaterThan(-1);
    expect(bootstrapIdx).toBeGreaterThan(-1);
    expect(wiringIdx).toBeLessThan(bootstrapIdx);
  });

  it('pairs the API base with the bridge token', () => {
    const tokenIdx = source.indexOf('setBridgeToken(bridge.token)');
    const bootstrapIdx = source.indexOf('bootstrapOAuthReplicas()');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeLessThan(bootstrapIdx);
  });

  it('skips the wiring on the extension-delegate path, as the prelude does', () => {
    expect(source).toMatch(
      /if\s*\(bridge\?\.apiBaseUrl\s*&&\s*!extensionDelegate\)\s*\{[\s\S]{0,200}setLocalApiBaseUrl/
    );
  });
});
