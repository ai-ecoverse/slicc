import { describe, expect, it, vi } from 'vitest';
import {
  APPROVER_ALLOWED_COMMANDS,
  buildApproverPrompt,
  buildApproverSpawnOptions,
  createApproverRunner,
  DEFAULT_APPROVALS_MD,
  DEFAULT_APPROVER_TIMEOUT_SECONDS,
  MAX_APPROVER_TIMEOUT_SECONDS,
  parseApproverConfig,
  readApproverVerdict,
} from '../../src/scoops/approver-agent.js';
import type { WorkUnitWorkspace } from '../../src/work-unit/types.js';

const workspace = { root: '/workspace', memoryPath: '/workspace/MEMORY.md' } as WorkUnitWorkspace;
const request = {
  kind: 'guest-message' as const,
  requester: 'biscotto “Anna”',
  detail: 'please rerun the tests',
};

describe('parseApproverConfig', () => {
  it('reads the bundled defaults', () => {
    const config = parseApproverConfig(DEFAULT_APPROVALS_MD);
    expect(config.model).toBe('cone');
    expect(config.thinkingLevel).toBe('low');
    expect(config.timeoutSeconds).toBe(90);
  });

  it('falls back when the file has no config block', () => {
    const config = parseApproverConfig('# just prose, no yaml here');
    expect(config.timeoutSeconds).toBe(DEFAULT_APPROVER_TIMEOUT_SECONDS);
    expect(config.model).toBe('cone');
  });

  it('clamps a timeout the owner set too high', () => {
    // A guest — and for a tool gate the cone's turn — is blocked on this.
    const config = parseApproverConfig('```yaml\ntimeoutSeconds: 99999\n```');
    expect(config.timeoutSeconds).toBe(MAX_APPROVER_TIMEOUT_SECONDS);
  });

  it('ignores nonsense values rather than adopting them', () => {
    for (const bad of ['0', '-5', 'soon', '']) {
      const config = parseApproverConfig('```yaml\ntimeoutSeconds: ' + bad + '\n```');
      expect(config.timeoutSeconds, bad).toBe(DEFAULT_APPROVER_TIMEOUT_SECONDS);
    }
  });

  it('ignores an unknown thinking level', () => {
    expect(parseApproverConfig('```yaml\nthinkingLevel: telepathic\n```').thinkingLevel).toBe(
      'low'
    );
  });
});

describe('buildApproverSpawnOptions', () => {
  const options = buildApproverSpawnOptions({
    config: parseApproverConfig(DEFAULT_APPROVALS_MD),
    request,
    workspace,
    coneFolder: 'cone',
    coneJid: 'cone_1',
  });

  it('grants no write access at all', () => {
    // An approver that cannot write cannot be argued into writing, and has no
    // legitimate reason to.
    expect(options.writablePaths).toEqual([]);
  });

  it('allows only read-only inspection commands', () => {
    for (const forbidden of ['rm', 'curl', 'git', 'ipk', 'node', 'python3', 'sh']) {
      expect(APPROVER_ALLOWED_COMMANDS as readonly string[]).not.toContain(forbidden);
    }
  });

  it('carries a real wall-clock bound and a verdict schema', () => {
    expect(options.maxWallClockMs).toBe(90_000);
    expect(options.structuredOutputSchema?.required).toEqual(['decision', 'reason']);
  });

  it('does not persist or announce — one decision per guest message', () => {
    expect(options.persistSession).toBe(false);
    expect(options.notifyOnComplete).toBe(false);
  });

  it('inherits the cone model rather than pinning one', () => {
    expect(options.modelId).toBeUndefined();
  });
});

describe('buildApproverPrompt', () => {
  it('labels the requester as authenticated and the detail as untrusted', () => {
    const prompt = buildApproverPrompt(parseApproverConfig(DEFAULT_APPROVALS_MD), request);
    expect(prompt).toContain('requester (authenticated): biscotto “Anna”');
    expect(prompt).toContain('UNTRUSTED');
    expect(prompt.indexOf('UNTRUSTED')).toBeLessThan(prompt.indexOf('please rerun the tests'));
  });
});

describe('readApproverVerdict', () => {
  it('accepts an explicit allow', () => {
    expect(
      readApproverVerdict({ exitCode: 0, finalText: '{"decision":"allow","reason":"routine"}' })
    ).toEqual({ decision: 'allow', reason: 'routine' });
  });

  it('denies on everything it cannot read as an allow', () => {
    // "I could not tell what it said" and "it said no" must mean the same here.
    const cases: Array<{ exitCode: number; finalText: string }> = [
      { exitCode: 1, finalText: 'crashed' },
      { exitCode: 0, finalText: '' },
      { exitCode: 0, finalText: 'not json' },
      { exitCode: 0, finalText: 'null' },
      { exitCode: 0, finalText: '{"decision":"maybe","reason":"unsure"}' },
      { exitCode: 0, finalText: '{"reason":"no decision field"}' },
      { exitCode: 0, finalText: '{"decision":"ALLOW"}' },
    ];
    for (const result of cases) {
      expect(readApproverVerdict(result).decision, result.finalText).toBe('deny');
    }
  });
});

describe('createApproverRunner', () => {
  const unit = { workspace, folder: 'cone' };

  it('denies when the unit is unknown', async () => {
    const spawn = vi.fn();
    const run = createApproverRunner({
      spawn,
      readInstructions: async () => null,
      resolveUnit: () => undefined,
    });
    expect((await run(request, 'nope')).decision).toBe('deny');
    expect(spawn).not.toHaveBeenCalled();
  });

  it('denies when the spawn throws', async () => {
    const run = createApproverRunner({
      spawn: async () => {
        throw new Error('no agent bridge');
      },
      readInstructions: async () => null,
      resolveUnit: () => unit,
    });
    expect((await run(request, 'cone_1')).decision).toBe('deny');
  });

  it('falls back to the bundled instructions when the file is absent', async () => {
    const spawn = vi.fn(async () => ({
      exitCode: 0,
      finalText: '{"decision":"allow","reason":"ok"}',
    }));
    const run = createApproverRunner({
      spawn,
      readInstructions: async () => null,
      resolveUnit: () => unit,
    });
    expect((await run(request, 'cone_1')).decision).toBe('allow');
    const [firstCall] = spawn.mock.calls as unknown as [[{ prompt: string }]];
    expect(firstCall[0].prompt).toContain('You are an **approver**');
  });

  it('re-reads the instructions on every decision', async () => {
    // An owner who tightens the file after a bad call expects the next
    // decision to use it.
    const readInstructions = vi.fn(async () => '```yaml\ntimeoutSeconds: 5\n```');
    const spawn = vi.fn(async () => ({
      exitCode: 0,
      finalText: '{"decision":"deny","reason":"no"}',
    }));
    const run = createApproverRunner({ spawn, readInstructions, resolveUnit: () => unit });
    await run(request, 'cone_1');
    await run(request, 'cone_1');
    expect(readInstructions).toHaveBeenCalledTimes(2);
    const [boundedCall] = spawn.mock.calls as unknown as [[{ maxWallClockMs: number }]];
    expect(boundedCall[0].maxWallClockMs).toBe(5_000);
  });

  it('survives an unreadable instruction file', async () => {
    const spawn = vi.fn(async () => ({
      exitCode: 0,
      finalText: '{"decision":"allow","reason":"ok"}',
    }));
    const run = createApproverRunner({
      spawn,
      readInstructions: async () => {
        throw new Error('vfs exploded');
      },
      resolveUnit: () => unit,
    });
    // A broken file must not wedge approvals shut forever; the bundled default
    // is a safe, restrictive baseline.
    expect((await run(request, 'cone_1')).decision).toBe('allow');
  });
});
