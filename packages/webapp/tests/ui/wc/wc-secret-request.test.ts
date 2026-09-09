// @vitest-environment jsdom
/**
 * The secret-entry surface: the one module that holds a plaintext credential.
 * These tests pin the two properties that make it safe to expose to an
 * agent-invoked tool — the value goes to the store and NOWHERE else, and the
 * resolved outcome carries only the mask.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import {
  getSecretRequestSurface,
  setSecretRequestSurface,
} from '../../../src/base/secret-request-registry.js';
import type { SecretBackend } from '../../../src/shell/supplemental-commands/secret-backends.js';
import { TRUSTED_LAYER_CLASS } from '../../../src/ui/wc/trusted-layer.js';
import {
  installSecretRequestSurface,
  requestSecretFromUser,
} from '../../../src/ui/wc/wc-secret-request.js';

/** A recording stand-in for the trusted-realm secret store. */
function fakeBackend(overrides: Partial<SecretBackend> = {}) {
  const calls = {
    session: [] as Array<{ name: string; value: string; domains: string[] }>,
    persisted: [] as Array<{ name: string; value: string; domains: string[] }>,
  };
  const backend = {
    setSession: vi.fn(async (name: string, value: string, domains: string[]) => {
      calls.session.push({ name, value, domains });
    }),
    setPersisted: vi.fn(async (name: string, value: string, domains: string[]) => {
      calls.persisted.push({ name, value, domains });
    }),
    getMasked: vi.fn(async (name: string) => ({
      name,
      maskedValue: `masked-${name}`,
      domains: [],
    })),
    ...overrides,
  } as unknown as SecretBackend;
  return { backend, calls };
}

/**
 * A stub dialog with the component's contract: `open()` resolves what the human
 * "typed", running the host's `submitHandler` first, exactly as the real element
 * does. Keeps this suite off a real custom-element registry.
 */
function stubDialog(
  typed: { name: string; value: string; domains: string[]; persist: boolean } | null
) {
  const element = document.createElement('div') as unknown as HTMLElement & {
    submitHandler?: (d: typeof typed) => Promise<string | null> | string | null;
    open: (req?: unknown) => Promise<typeof typed>;
    errors: string[];
    lastRequest?: unknown;
  };
  element.errors = [];
  element.open = async (req?: unknown) => {
    element.lastRequest = req;
    if (!typed) return null;
    const problem = await element.submitHandler?.(typed);
    if (problem) {
      element.errors.push(problem);
      return null;
    }
    return typed;
  };
  return element;
}

const TYPED = {
  name: 'GITHUB_TOKEN',
  value: 'ghp_realsecret',
  domains: ['api.github.com'],
  persist: false,
};

describe('requestSecretFromUser', () => {
  beforeEach(() => {
    document.body.replaceChildren();
    setSecretRequestSurface(null);
  });

  it('writes the value to the session store and returns only the mask', async () => {
    const { backend, calls } = fakeBackend();
    const dialog = stubDialog(TYPED);

    const outcome = await requestSecretFromUser(
      { name: 'GITHUB_TOKEN', reason: 'push', domains: ['api.github.com'] },
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect(calls.session).toEqual([
      { name: 'GITHUB_TOKEN', value: 'ghp_realsecret', domains: ['api.github.com'] },
    ]);
    expect(calls.persisted).toEqual([]);
    expect(outcome).toEqual({
      stored: true,
      name: 'GITHUB_TOKEN',
      maskedValue: 'masked-GITHUB_TOKEN',
      domains: ['api.github.com'],
      persisted: false,
    });
    // The plaintext is not in the outcome under any key.
    expect(JSON.stringify(outcome)).not.toContain('ghp_realsecret');
  });

  it('routes a persist opt-in to the saved store instead', async () => {
    const { backend, calls } = fakeBackend();
    const dialog = stubDialog({ ...TYPED, persist: true });

    const outcome = await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect(calls.persisted).toHaveLength(1);
    expect(calls.session).toEqual([]);
    expect(outcome).toMatchObject({ stored: true, persisted: true });
  });

  it('forwards the request framing to the dialog', async () => {
    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);
    await requestSecretFromUser(
      { name: 'T', domains: ['a.example'], reason: 'because', requester: 'Cone', persist: true },
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect(dialog.lastRequest).toMatchObject({
      name: 'T',
      domains: ['a.example'],
      reason: 'because',
      requester: 'Cone',
      persist: true,
    });
  });

  it('falls back to the page provider when the caller named none', async () => {
    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);
    await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect((dialog.lastRequest as { provider?: string }).provider).toBe('Anthropic');
  });

  // A background scoop can run on a provider the page's selection knows nothing
  // about; naming the wrong company is worse than naming none.
  it('prefers the asking unit’s provider over the page selection', async () => {
    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);
    await requestSecretFromUser(
      { provider: 'OpenAI' },
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect((dialog.lastRequest as { provider?: string }).provider).toBe('OpenAI');
  });

  it('reports a dismissal as cancelled and writes nothing', async () => {
    const { backend, calls } = fakeBackend();
    const dialog = stubDialog(null);

    const outcome = await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect(outcome).toEqual({ stored: false, reason: 'cancelled' });
    expect(calls.session).toEqual([]);
  });

  it('hands a store failure back to the dialog instead of throwing', async () => {
    const { backend } = fakeBackend({
      setSession: vi.fn(async () => {
        throw new Error('Keychain did not respond within 10s');
      }),
    });
    const dialog = stubDialog(TYPED);

    const outcome = await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    // The component keeps itself open on a returned message; from here the call
    // reads as "nothing stored".
    expect(dialog.errors).toEqual(['Keychain did not respond within 10s']);
    expect(outcome).toEqual({ stored: false, reason: 'cancelled' });
  });

  it('still reports success when the mask cannot be read back', async () => {
    const { backend } = fakeBackend({
      getMasked: vi.fn(async () => {
        throw new Error('store unreachable');
      }),
    });
    const dialog = stubDialog(TYPED);

    const outcome = await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );

    expect(outcome).toMatchObject({ stored: true, maskedValue: null });
  });

  it('mounts into the trusted layer so no panel can spoof or cover it', async () => {
    const layer = document.createElement('div');
    layer.className = TRUSTED_LAYER_CLASS;
    document.body.append(layer);
    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);

    let mountedIn: Element | null = null;
    dialog.open = async () => {
      mountedIn = dialog.parentElement;
      await dialog.submitHandler?.(TYPED);
      return TYPED;
    };

    await requestSecretFromUser({}, { backend, createDialog: () => dialog as never });
    expect(mountedIn).toBe(layer);
  });

  // Fail closed: `document.body` is coverable and impersonable by any panel, so a
  // float without the trusted layer must not ask for a credential at all.
  it('refuses to prompt at all when the float has no trusted layer', async () => {
    const { backend, calls } = fakeBackend();
    const dialog = stubDialog(TYPED);
    const opened = vi.fn(async () => TYPED);
    dialog.open = opened;

    const outcome = await requestSecretFromUser(
      {},
      { backend, createDialog: () => dialog as never }
    );

    expect(outcome).toEqual({ stored: false, reason: 'unavailable' });
    expect(opened).not.toHaveBeenCalled();
    expect(calls.session).toEqual([]);
    expect(dialog.isConnected).toBe(false);
  });

  it('removes the dialog once the flow ends, so no value lingers in the DOM', async () => {
    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);
    await requestSecretFromUser(
      {},
      { backend, mount: (el) => document.body.append(el), createDialog: () => dialog as never }
    );
    expect(dialog.isConnected).toBe(false);
  });
});

describe('installSecretRequestSurface', () => {
  beforeEach(() => setSecretRequestSurface(null));

  it('publishes the surface for the tool layer and clears it on dispose', async () => {
    expect(getSecretRequestSurface()).toBeNull();

    const { backend } = fakeBackend();
    const dialog = stubDialog(TYPED);
    const dispose = installSecretRequestSurface({
      backend,
      mount: (el) => document.body.append(el),
      createDialog: () => dialog as never,
    });

    const surface = getSecretRequestSurface();
    expect(surface).not.toBeNull();
    await expect(surface?.({ name: 'GITHUB_TOKEN', reason: 'push' })).resolves.toMatchObject({
      stored: true,
      name: 'GITHUB_TOKEN',
    });

    dispose();
    expect(getSecretRequestSurface()).toBeNull();
  });
});
