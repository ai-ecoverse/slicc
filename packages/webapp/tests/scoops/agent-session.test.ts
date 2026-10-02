import { describe, expect, it } from 'vitest';
import {
  AGENT_SESSION_IDLE_MS,
  cacheStableUserPrompt,
  classifySession,
  sessionFingerprint,
  sessionIdError,
  sumAssistantUsage,
} from '../../src/scoops/agent-session.js';

const base = {
  cwd: '/tmp/meep',
  allowedCommands: ['true'],
  modelId: 'claude-sonnet-5-5',
  thinkingLevel: 'low',
  escalate: false,
  cacheStablePrompt: true,
  toolSurface: 'auto',
};

describe('agent sessions', () => {
  it('rejects a session id the scoop-name grammar would also reject', () => {
    expect(sessionIdError('decider')).toBeNull();
    expect(sessionIdError('Meep.2:a')).toBeNull();
    expect(sessionIdError('')).toMatch(/invalid session id/);
    expect(sessionIdError('-nope')).toMatch(/invalid session id/);
    expect(sessionIdError('has space')).toMatch(/invalid session id/);
  });

  it('treats an omitted escalate as on, and ignores the prompt text', () => {
    const off = sessionFingerprint(base);
    const on = sessionFingerprint({ ...base, escalate: undefined });
    expect(sessionFingerprint({ ...base, escalate: true })).toBe(on);
    expect(off).not.toBe(on);
    expect(sessionFingerprint({ ...base, modelId: 'other' })).not.toBe(off);
    expect(sessionFingerprint({ ...base, allowedCommands: [' true '] })).toBe(
      sessionFingerprint({ ...base, allowedCommands: ['true'] })
    );
  });

  it('classifies create, resume, expiry, mismatch, and a busy session', () => {
    const fp = sessionFingerprint(base);
    const now = 10_000;
    expect(classifySession(undefined, fp, now, false, 's')).toEqual({
      action: 'create',
      drop: false,
    });
    expect(classifySession(undefined, fp, now, true, 's')).toEqual({
      action: 'error',
      exitCode: 2,
      finalText: 'agent: session not found: s',
    });
    const live = { fingerprint: fp, lastUsed: now - 1, busy: false };
    expect(classifySession(live, fp, now, true, 's')).toEqual({ action: 'resume' });
    expect(classifySession({ ...live, busy: true }, fp, now, false, 's')).toMatchObject({
      action: 'error',
      finalText: 'agent: session s is already running',
    });
    expect(classifySession(live, 'other', now, false, 's')).toMatchObject({
      action: 'error',
      finalText: 'agent: session s does not match this call',
    });
    const expired = { ...live, lastUsed: now - AGENT_SESSION_IDLE_MS - 1 };
    expect(classifySession(expired, fp, now, false, 's')).toEqual({ action: 'create', drop: true });
    expect(classifySession(expired, fp, now, true, 's')).toMatchObject({
      exitCode: 2,
      finalText: 'agent: session expired: s',
    });
  });

  it('puts the scratch folder in the user message, not a shared prefix', () => {
    expect(cacheStableUserPrompt('OK', '/tmp/meep', '/scoops/agent-quiet-vanilla')).toBe(
      'Working directory: /tmp/meep\nPrivate scratch directory: /scoops/agent-quiet-vanilla\n\nOK'
    );
  });

  it('sums only assistant turns appended during this call', () => {
    const messages = [
      {
        role: 'assistant',
        usage: { input: 1, output: 1, cacheRead: 1, cacheWrite: 1, cost: { total: 1 } },
      },
      { role: 'user' },
      {
        role: 'assistant',
        usage: { input: 4, output: 2, cacheRead: 8, cacheWrite: 0, cost: { total: 0.5 } },
      },
    ];
    expect(sumAssistantUsage(messages, 1)).toEqual({
      input: 4,
      output: 2,
      cacheRead: 8,
      cacheWrite: 0,
      cost: 0.5,
    });
  });
});
