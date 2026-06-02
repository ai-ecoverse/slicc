/**
 * Tests for the "Always" pattern suggester. `quickLabel` is mocked so the
 * fail-soft and sanitization paths are exercised deterministically.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

const mockQuickLabel = vi.fn();
vi.mock('../../src/ui/quick-llm.js', () => ({
  quickLabel: (...args: unknown[]) => mockQuickLabel(...args),
}));

import { suggestPattern } from '../../src/sudo/suggest-pattern.js';
import type { SudoRequest } from '../../src/sudo/types.js';

afterEach(() => {
  mockQuickLabel.mockReset();
});

const CMD: SudoRequest = { kind: 'command', detail: 'git push origin main' };
const PATH: SudoRequest = { kind: 'write', detail: '/workspace/.git/config' };

describe('suggestPattern', () => {
  it('returns an explicit caller suggestedPattern without calling the LLM', async () => {
    const req: SudoRequest = { ...CMD, suggestedPattern: 'git push*' };
    expect(await suggestPattern(req)).toBe('git push*');
    expect(mockQuickLabel).not.toHaveBeenCalled();
  });

  it('uses the quickLabel proposal when available', async () => {
    mockQuickLabel.mockResolvedValue('git push*');
    expect(await suggestPattern(CMD)).toBe('git push*');
    expect(mockQuickLabel).toHaveBeenCalledOnce();
  });

  it('strips code fences and quotes from the proposal', async () => {
    mockQuickLabel.mockResolvedValue('`git push*`');
    expect(await suggestPattern(CMD)).toBe('git push*');
  });

  it('takes only the first line of a multi-line proposal', async () => {
    mockQuickLabel.mockResolvedValue('git push*\nsome explanation');
    expect(await suggestPattern(CMD)).toBe('git push*');
  });

  it('falls soft to the exact detail when quickLabel returns null', async () => {
    mockQuickLabel.mockResolvedValue(null);
    expect(await suggestPattern(CMD)).toBe('git push origin main');
  });

  it('falls soft to the exact detail when quickLabel throws', async () => {
    mockQuickLabel.mockRejectedValue(new Error('boom'));
    expect(await suggestPattern(PATH)).toBe('/workspace/.git/config');
  });

  it('falls soft to the exact detail when quickLabel returns only whitespace', async () => {
    mockQuickLabel.mockResolvedValue('   \n  ');
    expect(await suggestPattern(CMD)).toBe('git push origin main');
  });
});
