import { describe, expect, it } from 'vitest';
import type { PreviewRecord, TrayRecord } from '../src/shared.js';
import { makeTrayWithConnectedLeader } from './preview-bridge-harness.js';

function restoredState(messages: unknown[], previewToken: string) {
  return messages.find(
    (message) =>
      (message as { type?: string; previewToken?: string }).type === 'preview.state' &&
      (message as { previewToken?: string }).previewToken === previewToken
  );
}

describe('durable preview announcement state replay', () => {
  it('restores announced normal and quiet previews with zero live bridge sockets', async () => {
    const normal = await makeTrayWithConnectedLeader({ bridge: true });
    await normal.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: normal.previewToken,
      announced: true,
    });
    const normalReplay = await normal.reconnectLeader();
    expect(restoredState(normalReplay, normal.previewToken)).toEqual({
      type: 'preview.state',
      previewToken: normal.previewToken,
      quiet: false,
      announced: true,
    });
    expect(normalReplay).not.toContainEqual(expect.objectContaining({ type: 'bridge.connected' }));

    const quiet = await makeTrayWithConnectedLeader({ bridge: true, quiet: true });
    const quietReplay = await quiet.reconnectLeader();
    expect(restoredState(quietReplay, quiet.previewToken)).toEqual({
      type: 'preview.state',
      previewToken: quiet.previewToken,
      quiet: true,
      announced: false,
    });
  });

  it('preserves an unvisited preview and a truncated preview as re-armed across restart', async () => {
    const unvisited = await makeTrayWithConnectedLeader({ bridge: true });
    expect(restoredState(await unvisited.reconnectLeader(), unvisited.previewToken)).toEqual(
      expect.objectContaining({ quiet: false, announced: false })
    );

    const truncated = await makeTrayWithConnectedLeader({ bridge: true });
    await truncated.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: truncated.previewToken,
      announced: true,
    });
    await truncated.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: truncated.previewToken,
      announced: false,
    });
    expect(restoredState(await truncated.reconnectLeader(), truncated.previewToken)).toEqual(
      expect.objectContaining({ quiet: false, announced: false })
    );

    const quiet = await makeTrayWithConnectedLeader({ bridge: true, quiet: true });
    await quiet.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: quiet.previewToken,
      announced: true,
    });
    await quiet.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: quiet.previewToken,
      announced: false,
    });
    expect(restoredState(await quiet.reconnectLeader(), quiet.previewToken)).toEqual(
      expect.objectContaining({ quiet: true, announced: false })
    );
  });

  it('survives Durable Object reconstruction', async () => {
    const harness = await makeTrayWithConnectedLeader({ bridge: true });
    await harness.deliverLeaderMessage({
      type: 'preview.state.update',
      previewToken: harness.previewToken,
      announced: true,
    });
    harness.reconstructDO();

    expect(restoredState(await harness.reconnectLeader(), harness.previewToken)).toEqual(
      expect.objectContaining({ quiet: false, announced: true })
    );
  });

  it('defaults legacy records without latch fields to silence-biased state', async () => {
    const harness = await makeTrayWithConnectedLeader({ bridge: true });
    const tray = await harness.state.storage.get<TrayRecord>('tray');
    const legacy = tray?.previews?.[harness.previewToken] as Partial<PreviewRecord> | undefined;
    expect(legacy).toBeDefined();
    delete legacy?.quiet;
    delete legacy?.announced;
    await harness.state.storage.put('tray', tray);
    harness.reconstructDO();

    expect(restoredState(await harness.reconnectLeader(), harness.previewToken)).toEqual({
      type: 'preview.state',
      previewToken: harness.previewToken,
      quiet: true,
      announced: true,
    });
  });
});
