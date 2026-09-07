/**
 * Regression guard for #2929: `ui/main.ts` MUST wire the local /api base and
 * bridge token BEFORE it calls `bootstrapOAuthReplicas()`.
 *
 * The bug this pins: the bootstrap re-pushes every stored OAuth token to the
 * local node-server's secrets replica, but the wiring only happened later, in
 * `setupStandalonePrelude`. With `localApiBaseUrl` still unset,
 * `resolveApiUrl('/api/secrets/oauth-update')` yields a bare relative path,
 * which on a thin-bridge leader resolves against the hosted origin
 * (`www.sliccy.ai`) rather than the node-server. The tray hub answers 200
 * with its route catalog for any unmatched path, so `r.ok` was true, no
 * `maskedValue` came back, and every account lost its mask on every page
 * load — `oauth-token <id>` then reported no usable token and demanded a
 * `--force-login` popup. Two bugs for the price of one, since the raw access
 * token was also handed to an origin that never needed it.
 *
 * Static-source guard, matching `main-telemetry.test.ts`: main.ts has a long
 * async boot sequence that is expensive to mock, and the invariant at stake
 * here is purely one of ORDER. The behaviour of the mask handling itself is
 * covered by `providers/oauth-sync.test.ts`.
 */

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
    // The node-server enforces `X-Bridge-Token` on cross-origin /api/*, so a
    // base without the token would swap one silent failure for another.
    const tokenIdx = source.indexOf('setBridgeToken(bridge.token)');
    const bootstrapIdx = source.indexOf('bootstrapOAuthReplicas()');
    expect(tokenIdx).toBeGreaterThan(-1);
    expect(tokenIdx).toBeLessThan(bootstrapIdx);
  });

  it('skips the wiring on the extension-delegate path, as the prelude does', () => {
    // `setupStandalonePrelude` does not parse bridge params when the
    // extension bridge is in play; wiring them here would diverge from it.
    expect(source).toMatch(
      /if\s*\(bridge\?\.apiBaseUrl\s*&&\s*!extensionDelegate\)\s*\{[\s\S]{0,200}setLocalApiBaseUrl/
    );
  });
});
