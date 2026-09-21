import { afterEach, describe, expect, it, vi } from 'vitest';
import { setSecretRequestSurface } from '../../../src/base/secret-request-registry.js';
import { createStandalonePanelRpcHandlers } from '../../../src/ui/panel-rpc-handlers.js';

// The `secrets-bridge` handler dynamically imports `callSecretsBridge`; mock it
// so the handler's contract (forward {type, payload}, wrap the result in
// {response}) is tested in isolation. The real direct-Port path is covered by
// `tests/core/secrets-bridge-client.test.ts`.
const { mockCallSecretsBridge } = vi.hoisted(() => ({ mockCallSecretsBridge: vi.fn() }));
vi.mock('../../../src/core/secrets-bridge-client.js', () => ({
  callSecretsBridge: mockCallSecretsBridge,
}));

describe('createStandalonePanelRpcHandlers — secrets-bridge', () => {
  afterEach(() => {
    mockCallSecretsBridge.mockReset();
  });

  it('forwards type + payload to callSecretsBridge and wraps the response', async () => {
    mockCallSecretsBridge.mockResolvedValue({ text: '<masked>' });
    const handlers = createStandalonePanelRpcHandlers({});
    const handler = handlers['secrets-bridge'];
    expect(handler).toBeTypeOf('function');

    const result = await handler!({
      type: 'secrets.scrub-tool-result',
      payload: { text: 'sk-live-123' },
    });
    expect(mockCallSecretsBridge).toHaveBeenCalledWith('secrets.scrub-tool-result', {
      text: 'sk-live-123',
    });
    expect(result).toEqual({ response: { text: '<masked>' } });
  });

  it('forwards a payload-less call (e.g. secrets.list-masked-entries)', async () => {
    mockCallSecretsBridge.mockResolvedValue({ entries: [] });
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['secrets-bridge']!({ type: 'secrets.list-masked-entries' });
    expect(mockCallSecretsBridge).toHaveBeenCalledWith('secrets.list-masked-entries', undefined);
    expect(result).toEqual({ response: { entries: [] } });
  });

  it('wraps an undefined response (best-effort: bridge unavailable)', async () => {
    mockCallSecretsBridge.mockResolvedValue(undefined);
    const handlers = createStandalonePanelRpcHandlers({});
    const result = await handlers['secrets-bridge']!({ type: 'secrets.session.list' });
    expect(result).toEqual({ response: undefined });
  });
});

describe('createStandalonePanelRpcHandlers — secret-request', () => {
  afterEach(() => setSecretRequestSurface(null));

  it('answers "unavailable" instead of rejecting when no surface is installed', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    // A float that cannot collect a secret is an ANSWER the worker-side tool
    // reports to the user, not a transport failure it should retry.
    await expect(handlers['secret-request']!({ name: 'T', reason: 'why' })).resolves.toEqual({
      stored: false,
      reason: 'unavailable',
    });
  });

  it('forwards the request to the installed surface and returns its outcome verbatim', async () => {
    const outcome = {
      stored: true as const,
      name: 'GITHUB_TOKEN',
      maskedValue: 'ghp_MASKED',
      domains: ['api.github.com'],
      persisted: false,
    };
    const surface = vi.fn().mockResolvedValue(outcome);
    setSecretRequestSurface(surface);

    const handlers = createStandalonePanelRpcHandlers({});
    const request = { name: 'GITHUB_TOKEN', reason: 'push', domains: ['api.github.com'] };
    await expect(handlers['secret-request']!(request)).resolves.toEqual(outcome);
    expect(surface).toHaveBeenCalledWith(request);
  });

  it('resolves the surface per call, so one installed after boot is still found', async () => {
    const handlers = createStandalonePanelRpcHandlers({});
    setSecretRequestSurface(async () => ({ stored: false, reason: 'cancelled' }));
    await expect(handlers['secret-request']!({})).resolves.toEqual({
      stored: false,
      reason: 'cancelled',
    });
  });
});
