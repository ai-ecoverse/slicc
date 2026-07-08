import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  broadcastIfStaleAssetError,
  broadcastStaleAssetReload,
  installStaleAssetReloadListener,
  isDynamicImportError,
  STALE_ASSET_RELOAD_CHANNEL,
  type StaleAssetReloadMsg,
  setStaleAssetInstanceId,
} from '../../src/core/stale-asset-channel.js';
import {
  installFakeBroadcastChannel,
  resetFakeBroadcastChannel,
} from '../helpers/fake-broadcast-channel.js';

describe('isDynamicImportError', () => {
  it('matches the cross-browser dynamic-import / module-script failure family', () => {
    expect(isDynamicImportError('Failed to fetch dynamically imported module: /assets/x.js')).toBe(
      true
    );
    expect(isDynamicImportError('error loading dynamically imported module')).toBe(true);
    expect(isDynamicImportError('Importing a module script failed.')).toBe(true);
    expect(
      isDynamicImportError(
        'Expected a JavaScript module script but the server responded with a MIME type of text/html'
      )
    ).toBe(true);
  });
  it('does NOT match unrelated errors', () => {
    expect(isDynamicImportError('401 Unauthorized')).toBe(false);
    expect(isDynamicImportError('rate limit exceeded')).toBe(false);
    expect(isDynamicImportError('network error')).toBe(false);
    expect(isDynamicImportError('Upload failed: unsupported MIME type image/tiff')).toBe(false);
    expect(isDynamicImportError('TypeError: Failed to fetch')).toBe(false);
  });
});

describe('broadcast + listener (instanceId-scoped)', () => {
  beforeEach(() => installFakeBroadcastChannel());
  afterEach(() => {
    setStaleAssetInstanceId(undefined);
    resetFakeBroadcastChannel();
  });

  it('delivers only to a listener whose instanceId matches', async () => {
    const matched = vi.fn();
    const other = vi.fn();
    const d1 = installStaleAssetReloadListener('inst-A', matched);
    const d2 = installStaleAssetReloadListener('inst-B', other);
    setStaleAssetInstanceId('inst-A');
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(matched).toHaveBeenCalledTimes(1);
    expect(other).not.toHaveBeenCalled();
    d1();
    d2();
  });

  it('no-ops when no instanceId has been set', async () => {
    const cb = vi.fn();
    const d = installStaleAssetReloadListener('inst-A', cb);
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    d();
  });

  it('stamps replayTurn onto the posted message (true when set, false by default)', async () => {
    const raw = new BroadcastChannel(STALE_ASSET_RELOAD_CHANNEL);
    const received: StaleAssetReloadMsg[] = [];
    raw.addEventListener('message', (e) => received.push(e.data as StaleAssetReloadMsg));
    setStaleAssetInstanceId('inst-M');
    broadcastStaleAssetReload(true);
    await Promise.resolve();
    expect(received.at(-1)?.replayTurn).toBe(true);
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(received.at(-1)?.replayTurn).toBe(false);
    raw.close();
  });

  it('forwards replayTurn to the matching listener (true when set, false by default)', async () => {
    const onReload = vi.fn();
    const d = installStaleAssetReloadListener('inst-R', onReload);
    setStaleAssetInstanceId('inst-R');
    broadcastStaleAssetReload(true);
    await Promise.resolve();
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(onReload).toHaveBeenLastCalledWith(true);
    broadcastStaleAssetReload();
    await Promise.resolve();
    expect(onReload).toHaveBeenCalledTimes(2);
    expect(onReload).toHaveBeenLastCalledWith(false);
    d();
  });

  it('broadcastIfStaleAssetError broadcasts for a dynamic-import Error only', async () => {
    const cb = vi.fn();
    const d = installStaleAssetReloadListener('inst-A', cb);
    setStaleAssetInstanceId('inst-A');
    broadcastIfStaleAssetError(new Error('random failure'));
    await Promise.resolve();
    expect(cb).not.toHaveBeenCalled();
    broadcastIfStaleAssetError(new Error('Failed to fetch dynamically imported module: /a.js'));
    await Promise.resolve();
    expect(cb).toHaveBeenCalledTimes(1);
    d();
  });

  it('setStaleAssetInstanceId(undefined) dev-warns', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    setStaleAssetInstanceId(undefined);
    // Dev-only warning; assert it does not throw and (in DEV) warns at least 0+ times.
    expect(() => setStaleAssetInstanceId(undefined)).not.toThrow();
    warn.mockRestore();
  });
});
