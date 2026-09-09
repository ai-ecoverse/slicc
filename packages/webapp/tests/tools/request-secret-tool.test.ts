/**
 * `request_secret`: the tool asks a human for a credential and is told only
 * the name, the mask, and the scope. The tests that matter most assert what it
 * does NOT get — a real value — plus how each decline reads back to the model.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type SecretRequestOutcome,
  setSecretRequestSurface,
} from '../../src/base/secret-request-registry.js';
import { createRequestSecretTool } from '../../src/tools/request-secret-tool.js';

const STORED: SecretRequestOutcome = {
  stored: true,
  name: 'GITHUB_TOKEN',
  maskedValue: 'ghp_MASKED000',
  domains: ['api.github.com'],
  persisted: false,
};

describe('request_secret', () => {
  beforeEach(() => {
    setSecretRequestSurface(null);
  });

  it('declares a schema that requires a name and a reason', () => {
    const tool = createRequestSecretTool();
    expect(tool.name).toBe('request_secret');
    expect(tool.inputSchema.required).toEqual(['name', 'reason']);
    expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual([
      'name',
      'reason',
      'domains',
      'persist',
    ]);
  });

  it('forwards the request to the page surface and reports name, mask, and scope', async () => {
    const surface = vi.fn().mockResolvedValue(STORED);
    setSecretRequestSurface(surface);

    const tool = createRequestSecretTool({ requester: 'Cone' });
    const result = await tool.execute({
      name: 'GITHUB_TOKEN',
      reason: 'push to the repo',
      domains: ['api.github.com', ' ', '*.github.com'],
      persist: true,
    });

    expect(surface).toHaveBeenCalledWith({
      name: 'GITHUB_TOKEN',
      reason: 'push to the repo',
      // Blank entries dropped; the rest passed through as suggestions.
      domains: ['api.github.com', '*.github.com'],
      persist: true,
      requester: 'Cone',
    });
    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('GITHUB_TOKEN');
    expect(result.content).toContain('ghp_MASKED000');
    expect(result.content).toContain('api.github.com');
    expect(result.content).toContain('this session only');
  });

  it('never reports a real value — the surface has no channel to return one', async () => {
    setSecretRequestSurface(async () => STORED);
    const tool = createRequestSecretTool();
    const result = await tool.execute({ name: 'GITHUB_TOKEN', reason: 'why' });
    // The only credential-shaped string in the report is the mask.
    expect(result.content).not.toContain('ghp_real');
    expect(result.content).toContain('never see the real value');
  });

  it('injects the mask as $NAME and says so', async () => {
    setSecretRequestSurface(async () => STORED);
    const setEnv = vi.fn();
    const tool = createRequestSecretTool({ setEnv });
    const result = await tool.execute({ name: 'GITHUB_TOKEN', reason: 'why' });

    expect(setEnv).toHaveBeenCalledWith('GITHUB_TOKEN', 'ghp_MASKED000');
    expect(result.content).toContain('$GITHUB_TOKEN');
  });

  it('skips env injection for a name no shell could resolve', async () => {
    setSecretRequestSurface(async () => ({
      ...STORED,
      name: 's3.r2.secret_access_key',
    }));
    const setEnv = vi.fn();
    const tool = createRequestSecretTool({ setEnv });
    const result = await tool.execute({ name: 's3.r2.secret_access_key', reason: 'mount' });

    expect(setEnv).not.toHaveBeenCalled();
    expect(result.content).not.toContain('available as $');
  });

  it('still succeeds when the store reports no mask', async () => {
    setSecretRequestSurface(async () => ({ ...STORED, maskedValue: null }));
    const setEnv = vi.fn();
    const result = await createRequestSecretTool({ setEnv }).execute({
      name: 'GITHUB_TOKEN',
      reason: 'why',
    });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('secret get GITHUB_TOKEN');
    expect(setEnv).not.toHaveBeenCalled();
  });

  it('reports a dismissal as an error so the model does not proceed regardless', async () => {
    setSecretRequestSurface(async () => ({ stored: false, reason: 'cancelled' }));
    const result = await createRequestSecretTool().execute({ name: 'T', reason: 'why' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/dismissed/i);
    expect(result.content).toMatch(/do not retry/i);
  });

  it('points at `secret set` when this float cannot prompt at all', async () => {
    // No surface, no panel-RPC client (node test realm) — the tool must answer
    // rather than hang on a human who is not there.
    const result = await createRequestSecretTool().execute({ name: 'T', reason: 'why' });

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/secret set/);
  });

  it('bridges to the page over panel-RPC when this realm has no surface', async () => {
    const callPanelRpc = vi.fn().mockResolvedValue(STORED);
    const result = await createRequestSecretTool({ callPanelRpc }).execute({
      name: 'GITHUB_TOKEN',
      reason: 'why',
    });

    expect(callPanelRpc).toHaveBeenCalledTimes(1);
    expect(result.isError).toBeFalsy();
  });

  it('prefers the in-realm surface over the bridge', async () => {
    const callPanelRpc = vi.fn();
    setSecretRequestSurface(async () => STORED);
    await createRequestSecretTool({ callPanelRpc }).execute({ name: 'T', reason: 'why' });

    expect(callPanelRpc).not.toHaveBeenCalled();
  });

  it('rejects a call missing name or reason without prompting anyone', async () => {
    const surface = vi.fn();
    setSecretRequestSurface(surface);
    const tool = createRequestSecretTool();

    expect((await tool.execute({ reason: 'why' })).isError).toBe(true);
    expect((await tool.execute({ name: 'T' })).isError).toBe(true);
    expect((await tool.execute({ name: '  ', reason: '  ' })).isError).toBe(true);
    expect(surface).not.toHaveBeenCalled();
  });

  it('surfaces a thrown transport failure as a tool error', async () => {
    setSecretRequestSurface(async () => {
      throw new Error('bridge closed');
    });
    const result = await createRequestSecretTool().execute({ name: 'T', reason: 'why' });

    expect(result.isError).toBe(true);
    expect(result.content).toContain('bridge closed');
  });

  it('does not fail a stored secret when env injection throws', async () => {
    setSecretRequestSurface(async () => STORED);
    const result = await createRequestSecretTool({
      setEnv: () => {
        throw new Error('shell gone');
      },
    }).execute({ name: 'GITHUB_TOKEN', reason: 'why' });

    expect(result.isError).toBeFalsy();
    expect(result.content).toContain('GITHUB_TOKEN');
  });
});
