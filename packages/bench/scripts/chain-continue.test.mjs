import { describe, expect, it, vi } from 'vitest';
import { chainContinue, nextChainInputs, summaryLines } from './chain-continue.mjs';

describe('nextChainInputs', () => {
  it('copies inputs and sets chain-from to this run id', () => {
    expect(
      nextChainInputs(
        { sets: 'bu-v2', tasks: '@bu-v2-explore-40', continue: true, 'chain-from': '1' },
        '99'
      )
    ).toEqual({
      sets: 'bu-v2',
      tasks: '@bu-v2-explore-40',
      continue: 'true',
      'chain-from': '99',
    });
  });
});

describe('chainContinue', () => {
  it('skips when continue is false', async () => {
    const result = await chainContinue({
      repo: 'o/r',
      runId: '1',
      ref: 'main',
      inputs: { continue: 'false' },
      token: 't',
      fetchImpl: vi.fn(),
    });
    expect(result).toEqual({ action: 'skipped', reason: 'continue=false' });
  });

  it('dispatches the memory-chain workflow', async () => {
    const fetchImpl = vi.fn(async () => ({ ok: true, status: 204, json: async () => null }));
    const result = await chainContinue({
      repo: 'o/r',
      runId: '42',
      ref: 'feat/x',
      inputs: { sets: 'bu-v2', continue: true },
      token: 'tok',
      fetchImpl,
    });
    expect(result.action).toBe('continued');
    expect(fetchImpl).toHaveBeenCalledOnce();
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toContain('/repos/o/r/actions/workflows/bench-memory-chain.yml/dispatches');
    expect(JSON.parse(init.body)).toEqual({
      ref: 'feat/x',
      inputs: { sets: 'bu-v2', continue: 'true', 'chain-from': '42' },
    });
  });
});

describe('summaryLines', () => {
  it('describes continued and skipped', () => {
    expect(summaryLines({ action: 'continued', reason: 'dispatched' }, '7').join('\n')).toContain(
      'dispatched'
    );
    expect(summaryLines({ action: 'skipped', reason: 'continue=false' }, '7').join('\n')).toContain(
      'Not continued'
    );
  });
});
