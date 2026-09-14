import { describe, expect, it } from 'vitest';
import { mountSlicc } from '../src/index.js';

describe('@ai-ecoverse/cherry public surface', () => {
  it('exports mountSlicc as a function', () => {
    expect(typeof mountSlicc).toBe('function');
  });

  it('throws when no container element is provided', () => {
    expect(() => mountSlicc({} as never)).toThrow(/container/i);
  });
});
