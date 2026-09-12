import { describe, expect, it } from 'vitest';
import { SessionTrayDurableObject } from '../src/session-tray.js';
import type { TrayRecord } from '../src/shared.js';
import { FakeDurableObjectState } from './fake-do-state.js';

const NOW = Date.parse('2026-09-01T00:00:00Z');

async function confirmationHarness(overrides: Partial<TrayRecord> = {}) {
  const state = new FakeDurableObjectState();
  const tray: TrayRecord = {
    trayId: 'tray',
    createdAt: new Date(NOW).toISOString(),
    controllerToken: 'tray.controller',
    joinToken: 'tray.join',
    webhookToken: 'tray.webhook',
    controllers: {},
    bootstraps: {},
    leader: null,
    ...overrides,
  };
  await state.storage.put('tray', tray);
  const object = new SessionTrayDurableObject(state, {}, { now: () => NOW });
  return async (ownershipOnly: boolean, controllerToken = tray.controllerToken) => {
    const route = ownershipOnly ? 'confirm-controller-ownership' : 'confirm-controller';
    const response = await object.fetch(
      new Request(`https://internal/internal/${route}`, {
        method: 'POST',
        body: JSON.stringify({ controllerToken }),
      })
    );
    expect(response.status).toBe(200);
    return response.json();
  };
}

describe('controller ownership versus rebind target confirmation', () => {
  it('allows a fresh target before its leader connects', async () => {
    const confirm = await confirmationHarness();
    expect(await confirm(false)).toEqual({ confirmed: true });
  });

  it.each([
    { expiredAt: new Date(NOW - 1).toISOString() },
    { supersededByJoinUrl: 'https://hub/join/replacement.secret' },
    { supersededByWebhookUrl: 'https://hub/wh/replacement.secret' },
  ])('rejects unavailable bind targets while retaining ownership proof: %j', async (overrides) => {
    const confirm = await confirmationHarness(overrides);
    expect(await confirm(false)).toEqual({ confirmed: false });
    expect(await confirm(true)).toEqual({ confirmed: true });
    expect(await confirm(true, 'wrong')).toEqual({ confirmed: false });
    expect(await confirm(false, 'wrong')).toEqual({ confirmed: false });
  });
});
