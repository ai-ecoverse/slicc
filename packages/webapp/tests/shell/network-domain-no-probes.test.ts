/**
 * #2276 slice C, network domain: `scoops/tray-leader.ts` (`createTrayFetch`),
 * `shell/proxied-fetch.ts` (`createProxiedFetch`'s extension-realm branch)
 * and `shell/mcp/redirect-uri.ts` (`resolveMcpRedirectUri`) no longer probe
 * the float themselves.
 *
 * All three asked the same question — "is this realm the real Chrome
 * extension page?" / "what float am I on?" — at call time, each with its own
 * import of `isExtensionRealm` / `isChromeExtensionRealm` /
 * `resolveFloatTopology`. They now take the answer by injection:
 * `tray-leader.ts` and `proxied-fetch.ts` read `getChromeExtensionRealm()`
 * (`base/api-endpoint.ts`'s lazily-cached, per-realm answer — the same fact,
 * asked once, not re-probed per call); `redirect-uri.ts` takes `topology` as
 * a parameter, resolved by its two callers (`shell/mcp/provider.ts`,
 * `shell/supplemental-commands/mcp-command.ts`) at the point they actually
 * need a redirect URI.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', 'src', ...parts), 'utf8');

/** Import statements only — prose may still mention a probe while explaining why it's gone. */
function staticImports(source: string): string {
  return [...source.matchAll(/^import[\s\S]*?from\s+'[^']+';$/gm)].map((m) => m[0]).join('\n');
}

const BANNED_PROBE_PATTERN =
  /isExtensionRealm|isChromeExtensionRealm|hasLocalNodeServer|resolveFloatTopology/;

describe('#2276 slice C — network domain call sites no longer probe the float', () => {
  it.each([
    ['scoops/tray-leader.ts', ['scoops', 'tray-leader.ts']],
    ['shell/proxied-fetch.ts', ['shell', 'proxied-fetch.ts']],
    ['shell/mcp/redirect-uri.ts', ['shell', 'mcp', 'redirect-uri.ts']],
  ] as const)('%s no longer imports a float probe', (file, parts) => {
    const imports = staticImports(src(...parts));
    expect({ file, probes: BANNED_PROBE_PATTERN.test(imports) }).toEqual({ file, probes: false });
  });

  it('tray-leader.ts reads the shared cached answer instead of probing', () => {
    const source = src('scoops', 'tray-leader.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('proxied-fetch.ts reads the shared cached answer instead of probing', () => {
    const source = src('shell', 'proxied-fetch.ts');
    expect(source).toContain('getChromeExtensionRealm()');
  });

  it('base/api-endpoint.ts is the one place left that imports the probe, and caches it', () => {
    const source = src('base', 'api-endpoint.ts');
    const imports = staticImports(source);
    expect(imports).toMatch(/isChromeExtensionRealm/);
    // Cached (read once, reused), not re-probed on every getter call.
    expect(source).toContain('let chromeExtensionRealm: boolean | null = null;');
  });

  it('redirect-uri.ts takes topology as a parameter, not a return of its own probe', () => {
    const source = src('shell', 'mcp', 'redirect-uri.ts');
    expect(source).toContain('resolveMcpRedirectUri(topology: FloatTopology)');
  });

  it('resolveMcpRedirectUri callers resolve topology at their own call site', () => {
    for (const parts of [
      ['shell', 'mcp', 'provider.ts'],
      ['shell', 'supplemental-commands', 'mcp-command.ts'],
    ] as const) {
      const source = src(...parts);
      expect(source).toContain('resolveMcpRedirectUri(resolveFloatTopology())');
    }
  });
});
