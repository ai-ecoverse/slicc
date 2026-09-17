import { describe, expect, it } from 'vitest';
import {
  LEADER_RUNTIME_QUERY_NAME,
  LEADER_RUNTIME_QUERY_VALUE,
} from '../../src/base/leader-runtime-query.js';

describe('leader-runtime-query', () => {
  it('is the pinned hosted-leader-tab query pair', () => {
    expect(LEADER_RUNTIME_QUERY_NAME).toBe('slicc');
    expect(LEADER_RUNTIME_QUERY_VALUE).toBe('leader');
  });
});
