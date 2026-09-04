/**
 * #2276 slice C, mounts domain (review-patterns category 10): the
 * sign-and-forward transport asks the injected `CapabilityBroker`, not a
 * `isExtensionRealm()` / `getExtensionDelegateId()` branch it maintains
 * itself.
 *
 * `fs/mount/signed-fetch.ts` used to build the S3/DA sign-and-forward
 * request AND decide its own transport (`chrome.runtime` message vs the
 * `mount.sign-and-forward` bridge vs an HTTP POST) — the same
 * "business logic re-implements a topology-branching transport" shape the
 * secrets domain removed from `scoops/scoop-context/shell-and-skills.ts`.
 * It now calls `broker.mounts.signRequest({ backend, envelope })`, an
 * operation every slice-B adapter already implements; `envelopeToResponse`
 * — the error-code → `FsError` mapping — is UNCHANGED, since a
 * server-encoded refusal travels as a `SignAndForwardReply` value inside a
 * successful `CapabilityResult`, not as a broker-level failure.
 *
 * The broker itself is a module-level fact (`fs/mount/capability-broker.ts`),
 * set once by `kernel/host.ts` — `fs/` sits at the BOTTOM of the layer stack
 * and mount construction happens far from any composition root
 * (`VirtualFS.mount()`, `mount-commands.ts`, `mount-recovery.ts`), so
 * constructor injection would have to fan out through all of them. This
 * mirrors `base/api-endpoint.ts`'s `chromeExtensionRealm` idiom, not a new
 * pattern.
 *
 * `fs/mount-commands.ts` (~line 293, the extension-popup vs direct-picker
 * branch) and `fs/picker-popup.ts` (`canOpenPickerPopup`) both still read
 * `isExtensionRealm()` directly and are NOT migrated in this slice: both
 * decide how to host a directory-picker'S REQUIRED PAGE GESTURE, which is
 * exactly what `CapabilityBroker`'s `PageGestureChannel` / `mounts.
 * pickDirectory()` was designed for (slice B's own doc comment) — but no
 * real `PageGestureChannel` implementation exists anywhere in the codebase
 * today (`kernel/host.ts`'s `config.pageGestures` is never supplied), so
 * `mounts.pickDirectory()` is unconditionally `CapabilityUnavailable` in
 * production. Routing the picker through it now would BREAK local-mount
 * picking outright, not migrate it. Wiring a real page-gesture channel
 * (bridging a page-realm gesture from the kernel worker, the same class of
 * problem `hear-*` panel-RPC solves for speech) is its own feature, tracked
 * separately — not #2276 slice C scope creep.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const src = (...parts: string[]): string =>
  readFileSync(join(here, '..', '..', '..', 'src', ...parts), 'utf8');

// One source token at a time: a string literal, a `//` line comment, or a
// `/* */` block comment — mirrors `check-no-ui-imports-in-providers.mjs`'s
// `stripComments`. Without this, a doc comment that merely NAMES the call
// (as this file's own header does, a few lines up) would satisfy a raw
// substring scan even if the real code regressed (round-1 review finding 5d).
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
  // The topology-branching function this slice removed from
  // fs/mount/signed-fetch.ts.
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
    // Stripped of comments: a doc comment merely naming the call must not
    // satisfy this — only the real call site does.
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
    // Set before orchestrator.init() (which mounts the shared FS) runs —
    // the actual call, not its mention in the file's top-of-file doc comment.
    const initLine = source.indexOf('await orchestrator.init(');
    expect(initLine).toBeGreaterThan(-1);
    expect(setMountLine).toBeLessThan(initLine);
  });

  it('is a separate module from signed-fetch.ts, so kernel/host.ts stays off the lazy mount-transport chunk', () => {
    // A static import of signed-fetch.ts itself from kernel/host.ts would
    // drag backend-s3.js / backend-da.js / profile.js onto the eager boot
    // graph — the same class of mistake the network-slice PR's round-1
    // review caught (createTrayFetch had to move to its own file for the
    // same reason).
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
