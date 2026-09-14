import { describe, expect, it } from 'vitest';
import { buildWebAuthFlowOptions, SILENT_RENEW_TIMEOUT_MS } from '../src/oauth-flow-options.js';

describe('buildWebAuthFlowOptions', () => {
  it('interactive flow → only url + interactive:true', () => {
    expect(buildWebAuthFlowOptions('https://idp/authorize', true)).toEqual({
      url: 'https://idp/authorize',
      interactive: true,
    });
  });

  it('silent flow → non-interactive options that survive IMS JS redirect', () => {
    expect(buildWebAuthFlowOptions('https://idp/authorize', false)).toEqual({
      url: 'https://idp/authorize',
      interactive: false,
      abortOnLoadForNonInteractive: false,
      timeoutMsForNonInteractive: SILENT_RENEW_TIMEOUT_MS,
    });
  });

  it('SILENT_RENEW_TIMEOUT_MS is a positive, bounded budget', () => {
    expect(SILENT_RENEW_TIMEOUT_MS).toBeGreaterThan(0);
    expect(SILENT_RENEW_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
