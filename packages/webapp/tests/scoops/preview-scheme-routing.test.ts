import { describe, expect, it } from 'vitest';
import { buildLeaderSyncWithConn } from './bridge-leader-sync.test';

describe('preview: scheme routing', () => {
  it('routes runtimeId=preview to the bridge transport', () => {
    const { mgr } = buildLeaderSyncWithConn('c1', 't.s');
    const t = mgr.createRemoteTransport('preview', 't.s:c1');
    expect(t).toBe(mgr.getBridgeTransport('c1'));
  });

  it('throws when the connId does not exist', () => {
    const { mgr } = buildLeaderSyncWithConn('c1', 't.s');
    expect(() => mgr.createRemoteTransport('preview', 't.s:nonexistent')).toThrow(
      /not found|unknown/i
    );
  });

  it('uses follower path for non-preview runtimeIds', () => {
    const { mgr } = buildLeaderSyncWithConn('c1', 't.s');
    // Non-preview runtime should create a RemoteCDPTransport, not return undefined
    const t = mgr.createRemoteTransport('someFollowerRuntime', 'target1');
    // The transport is created even if no follower is connected (it will error on send)
    expect(t).toBeDefined();
    expect(t).not.toBe(mgr.getBridgeTransport('c1'));
  });
});
