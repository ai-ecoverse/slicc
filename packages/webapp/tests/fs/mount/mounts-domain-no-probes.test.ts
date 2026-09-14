import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', '..', 'src', ...parts), 'utf8');

const COMMENT_OR_STRING_RE =
  /'(?:\\[\s\S]|[^'\\\n])*'|"(?:\\[\s\S]|[^"\\\n])*"|`(?:\\[\s\S]|[^`\\])*`|\/\/[^\n]*|\/\*[\s\S]*?\*\//g;
const stripComments = (source: string): string =>
  source.replace(COMMENT_OR_STRING_RE, (m) =>
    m.startsWith('//') || m.startsWith('/*') ? m.replace(/[^\n]/g, ' ') : m
  );

const FLOAT_PROBE_NAMES = [
  'isExtensionRealm',
  'isChromeExtensionRealm',
  'resolveFloatTopology',
  'getChromeExtensionRealm',
  'setChromeExtensionRealm',
  'hasChromeRuntimeConnect',
  'canConnectToChromeRuntime',
  'getExtensionDelegateId',

  'routeSignAndForward',
] as const;

describe('#2276 slice C — fs/mount/signed-fetch.ts has no float/topology read', () => {
  it('contains none of the float-probe names, anywhere in the file — not just its imports', () => {
    const source = src('fs', 'mount', 'signed-fetch.ts');
    const found = FLOAT_PROBE_NAMES.filter((name) => source.includes(name));
    expect(found).toEqual([]);
  });

  it('sends the sign-and-forward request through the injected broker', () => {
    const source = src('fs', 'mount', 'signed-fetch.ts');

    expect(stripComments(source)).toContain('.mounts.signRequest(');
    expect(source).toContain("from './capability-broker.js'");
  });

  it('still maps server-encoded refusals via envelopeToResponse — behaviour unchanged', () => {
    const source = src('fs', 'mount', 'signed-fetch.ts');
    expect(source).toContain('function envelopeToResponse');
    expect(source).toContain("errorCode === 'profile_not_configured'");
  });
});

describe('#2276 slice C — fs/mount/capability-broker.ts is the one composition-time fact', () => {
  it('kernel/host.ts sets it right next to orchestrator.setCapabilityBroker', () => {
    const source = src('kernel', 'host.ts');
    const setBrokerLine = source.indexOf('orchestrator.setCapabilityBroker(capabilityBroker)');
    const setMountLine = source.indexOf('setMountCapabilityBroker(capabilityBroker)');
    expect(setBrokerLine).toBeGreaterThan(-1);
    expect(setMountLine).toBeGreaterThan(-1);

    const initLine = source.indexOf('await orchestrator.init(');
    expect(initLine).toBeGreaterThan(-1);
    expect(setMountLine).toBeLessThan(initLine);
  });

  it('is a separate module from signed-fetch.ts, so kernel/host.ts stays off the lazy mount-transport chunk', () => {
    const source = src('kernel', 'host.ts');
    expect(source).toContain("from '../fs/mount/capability-broker.js'");
    expect(source).not.toContain("from '../fs/mount/signed-fetch.js'");
  });
});

describe('#2276 slice C — the picker-gesture sites stay on isExtensionRealm (documented, not an oversight)', () => {
  it('fs/mount-commands.ts still branches on isExtensionRealm for the local-mount picker', () => {
    const source = src('fs', 'mount-commands.ts');
    expect(source).toContain('isExtensionRealm()');
  });

  it('fs/picker-popup.ts still branches on isExtensionRealm for the shared 4-kind popup launcher', () => {
    const source = src('fs', 'picker-popup.ts');
    expect(source).toContain('isExtensionRealm()');
  });
});
