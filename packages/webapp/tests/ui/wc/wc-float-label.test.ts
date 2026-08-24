// @vitest-environment jsdom
/**
 * Floatbar runtime fingerprinting: /api/status names the serving runtime —
 * the native Sliccstart server vs the Node CLI — and unknown/unreachable
 * keeps the generic standalone kind.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { setBridgeToken, setLocalApiBaseUrl } from '../../../src/shell/proxied-fetch.js';
import {
  floatLabelForKind,
  resolveStandaloneFloatKind,
  resolveStandaloneFloatLabel,
} from '../../../src/ui/wc/wc-float-label.js';

function okJson(body: unknown): typeof fetch {
  return vi.fn(async () => ({ ok: true, json: async () => body })) as unknown as typeof fetch;
}

afterEach(() => {
  setLocalApiBaseUrl(null);
  setBridgeToken(null);
});

describe('resolveStandaloneFloatKind', () => {
  it('detects the native Sliccstart server', async () => {
    await expect(
      resolveStandaloneFloatKind({ fetchFn: okJson({ status: 'ok', service: 'slicc-server' }) })
    ).resolves.toBe('sliccstart');
  });

  it('detects the Node CLI', async () => {
    await expect(
      resolveStandaloneFloatKind({
        fetchFn: okJson({ status: 'ok', service: 'slicc-node-server' }),
      })
    ).resolves.toBe('npx');
  });

  it('falls back to standalone for unknown services', async () => {
    await expect(
      resolveStandaloneFloatKind({ fetchFn: okJson({ status: 'ok', service: 'mystery' }) })
    ).resolves.toBe('standalone');
  });
});

describe('floatLabelForKind', () => {
  it('returns the float kind name without tray suffixes', () => {
    expect(floatLabelForKind('npx')).toBe('npx');
    expect(floatLabelForKind('extension')).toBe('extension');
  });
});

describe('resolveStandaloneFloatLabel (deprecated)', () => {
  it('returns the float kind label', async () => {
    await expect(
      resolveStandaloneFloatLabel({
        fetchFn: okJson({ status: 'ok', service: 'slicc-node-server' }),
      })
    ).resolves.toBe('npx');
  });
});
