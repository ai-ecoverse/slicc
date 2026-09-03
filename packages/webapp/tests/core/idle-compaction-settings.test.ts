import { describe, expect, it } from 'vitest';
import {
  IDLE_COMPACTION_DEFAULTS,
  readIdleCompactionSettings,
} from '../../src/core/idle-compaction-settings.js';

describe('idle compaction settings', () => {
  it('exposes the fixed idle window and minimum context size', () => {
    expect(IDLE_COMPACTION_DEFAULTS).toEqual({ idleMinutes: 30, minTokens: 200_000 });
    expect(readIdleCompactionSettings()).toEqual(IDLE_COMPACTION_DEFAULTS);
  });
});
