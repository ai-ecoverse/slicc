import { describe, expect, it, vi } from 'vitest';
import { consumeAutoPrompt } from '../../../src/ui/boot/auto-prompt.js';

describe('consumeAutoPrompt', () => {
  it('returns null when the param is absent', () => {
    const replace = vi.fn();
    expect(consumeAutoPrompt('', replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('returns null for an empty prompt value', () => {
    const replace = vi.fn();
    expect(consumeAutoPrompt('?prompt=', replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('returns null for a whitespace-only prompt', () => {
    const replace = vi.fn();
    expect(consumeAutoPrompt('?prompt=%20%20%20', replace)).toBeNull();
    expect(replace).not.toHaveBeenCalled();
  });

  it('returns the decoded prompt text', () => {
    const replace = vi.fn();
    const result = consumeAutoPrompt('?prompt=ls%20%2Fworkspace', replace);
    expect(result).toBe('ls /workspace');
  });

  it('strips the prompt param via replaceState', () => {
    const replace = vi.fn();
    consumeAutoPrompt('?prompt=hello', replace);
    expect(replace).toHaveBeenCalledOnce();
    // The cleaned URL should not contain `prompt=`
    const cleaned = replace.mock.calls[0]![0] as string;
    expect(cleaned).not.toContain('prompt=');
  });

  it('preserves other query params when stripping', () => {
    const replace = vi.fn();
    consumeAutoPrompt('?bridge=ws://localhost:5710/cdp&prompt=test&token=abc', replace);
    const cleaned = replace.mock.calls[0]![0] as string;
    expect(cleaned).toContain('bridge=');
    expect(cleaned).toContain('token=abc');
    expect(cleaned).not.toContain('prompt=');
  });

  it('returns null on reload after the param was stripped', () => {
    const replace = vi.fn();
    // First call consumes the param
    consumeAutoPrompt('?prompt=hello', replace);
    // Simulated reload: the cleaned URL has no prompt param
    const cleaned = replace.mock.calls[0]![0] as string;
    const search = cleaned.includes('?') ? cleaned.slice(cleaned.indexOf('?')) : '';
    expect(consumeAutoPrompt(search, replace)).toBeNull();
  });
});
