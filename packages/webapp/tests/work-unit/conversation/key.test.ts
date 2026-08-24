/**
 * Conversation identity: work unit × workspace (#2275).
 */

import { describe, expect, it } from 'vitest';
import {
  conversationKeyFor,
  parseConversationKey,
  workspaceIdFor,
} from '../../../src/work-unit/conversation/key.js';
import { childRecord, rootRecord } from '../fixtures.js';

describe('conversationKeyFor', () => {
  it('keys the primary cone by its historical workspace', () => {
    expect(conversationKeyFor(rootRecord())).toBe('/workspace::cone_1');
  });

  it('gives an extra cone its own key', () => {
    const extra = rootRecord({ jid: 'cone_2', folder: 'cone-research' });
    expect(conversationKeyFor(extra)).toBe('/cones/cone-research/workspace::cone_2');
  });

  it('gives a scoop its own key', () => {
    expect(conversationKeyFor(childRecord('cone_1'))).toBe(
      '/scoops/worker-scoop/workspace::scoop_worker-scoop_1'
    );
  });

  it('two units never collide', () => {
    const keys = new Set([
      conversationKeyFor(rootRecord()),
      conversationKeyFor(rootRecord({ jid: 'cone_2', folder: 'cone-research' })),
      conversationKeyFor(childRecord('cone_1')),
      conversationKeyFor(childRecord('cone_1', { folder: 'other-scoop' })),
    ]);
    expect(keys.size).toBe(4);
  });

  it('reads the layout from workspaceFor, not from a hardcoded path', () => {
    expect(workspaceIdFor(rootRecord({ folder: 'cone-research' }))).toBe(
      '/cones/cone-research/workspace'
    );
  });
});

describe('parseConversationKey', () => {
  it('splits a key back into its halves', () => {
    expect(parseConversationKey('/workspace::cone_1')).toEqual({
      workspaceId: '/workspace',
      workUnitId: 'cone_1',
    });
  });

  it('splits on the LAST separator, so a path containing one is safe', () => {
    expect(parseConversationKey('/mnt/a::b/workspace::cone_1')).toEqual({
      workspaceId: '/mnt/a::b/workspace',
      workUnitId: 'cone_1',
    });
  });

  it('rejects anything that is not one of ours', () => {
    expect(parseConversationKey('cone_1')).toBeNull();
    expect(parseConversationKey('::cone_1')).toBeNull();
    expect(parseConversationKey('/workspace::')).toBeNull();
  });
});
