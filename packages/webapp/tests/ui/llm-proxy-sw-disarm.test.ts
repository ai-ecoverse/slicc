/**
 * Tests for seven's off switch on six's LLM-proxy SW (`llm-proxy-sw-disarm.ts`).
 *
 * Pins the contract slicc-bios relies on: the exact message shape, the
 * top-level-window gate, the retired cookie that keeps a restarted worker
 * disarmed, and that a disarmed worker never calls `respondWith` (so the
 * request reaches the network as if no worker were there).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  answerUnlessDisarmed,
  createSixDisarmSwitch,
  isSixDisarmMessage,
  maySixDisarm,
  readSixRetired,
  SIX_RETIRED_COOKIE,
  SW_SIX_DISARM_MESSAGE,
  SW_SIX_DISARMED_MESSAGE,
} from '../../src/ui/llm-proxy-sw-disarm.js';

const flush = () => new Promise((done) => setTimeout(done, 0));

function fakeEvent(url = 'https://registry.npmjs.org/x.tgz') {
  const request = new Request(url);
  const respondWith = vi.fn<(response: Promise<Response> | Response) => void>();
  return { event: { request, respondWith }, request, respondWith };
}

describe('the disarm message', () => {
  it('is slicc-six-disarm, answered with slicc-six-disarmed', () => {
    expect(SW_SIX_DISARM_MESSAGE).toBe('slicc-six-disarm');
    expect(SW_SIX_DISARMED_MESSAGE).toBe('slicc-six-disarmed');
    expect(SIX_RETIRED_COOKIE).toBe('__Host-slicc-six-retired');
  });

  it('accepts exactly { type } and nothing else', () => {
    expect(isSixDisarmMessage({ type: 'slicc-six-disarm' })).toBe(true);
    expect(isSixDisarmMessage({ type: 'slicc-six-disarm', extra: 1 })).toBe(false);
    expect(isSixDisarmMessage({ type: 'slicc-six-disarmed' })).toBe(false);
    expect(isSixDisarmMessage(['slicc-six-disarm'])).toBe(false);
    expect(isSixDisarmMessage('slicc-six-disarm')).toBe(false);
    expect(isSixDisarmMessage(null)).toBe(false);
  });

  it('comes only from a top-level window', () => {
    expect(maySixDisarm({ type: 'window', frameType: 'top-level', id: 'bios' })).toBe(true);
    expect(maySixDisarm({ type: 'window', frameType: 'nested', id: 'sprinkle' })).toBe(false);
    expect(maySixDisarm({ type: 'window', frameType: 'auxiliary', id: 'popup' })).toBe(false);
    expect(maySixDisarm({ type: 'worker', id: 'installer' })).toBe(false);
    expect(maySixDisarm(null)).toBe(false);
  });
});

describe('readSixRetired', () => {
  it('reads the retired cookie', async () => {
    const get = vi.fn(async (name: string) =>
      name === SIX_RETIRED_COOKIE ? { name, value: '1' } : null
    );
    expect(await readSixRetired({ get })).toBe(true);
    expect(get).toHaveBeenCalledWith('__Host-slicc-six-retired');
    expect(await readSixRetired({ get: async () => null })).toBe(false);
  });

  it('reads no store, or a failing one, as not retired', async () => {
    expect(await readSixRetired(undefined)).toBe(false);
    expect(
      await readSixRetired({
        get: async () => {
          throw new Error('no cookies here');
        },
      })
    ).toBe(false);
  });
});

describe('createSixDisarmSwitch', () => {
  it('is unknown until the startup check settles, then armed without the cookie', async () => {
    const sixSwitch = createSixDisarmSwitch(async () => false);
    expect(sixSwitch.disarmed).toBeNull();
    expect(await sixSwitch.ready).toBe(false);
    expect(sixSwitch.disarmed).toBe(false);
  });

  it('starts disarmed when seven has retired six', async () => {
    const sixSwitch = createSixDisarmSwitch(async () => true);
    expect(await sixSwitch.ready).toBe(true);
    expect(sixSwitch.disarmed).toBe(true);
  });

  it('reads a failing check as armed', async () => {
    const sixSwitch = createSixDisarmSwitch(() => Promise.reject(new Error('boom')));
    expect(await sixSwitch.ready).toBe(false);
  });

  it('stays disarmed after a disarm, even when the startup check answers later', async () => {
    let answer!: (value: boolean) => void;
    const sixSwitch = createSixDisarmSwitch(() => new Promise<boolean>((done) => (answer = done)));
    sixSwitch.disarm();
    expect(sixSwitch.disarmed).toBe(true);
    answer(false);
    expect(await sixSwitch.ready).toBe(true);
    expect(sixSwitch.disarmed).toBe(true);
  });

  it('disarms an armed worker', async () => {
    const sixSwitch = createSixDisarmSwitch(async () => false);
    await sixSwitch.ready;
    sixSwitch.disarm();
    expect(sixSwitch.disarmed).toBe(true);
  });
});

describe('answerUnlessDisarmed', () => {
  it('answers while armed', async () => {
    const sixSwitch = createSixDisarmSwitch(async () => false);
    await sixSwitch.ready;
    const { event, respondWith } = fakeEvent();
    const proxied = new Response('proxied');
    const passOn = vi.fn();
    answerUnlessDisarmed(sixSwitch, event, async () => proxied, passOn);
    expect(respondWith).toHaveBeenCalledOnce();
    expect(await respondWith.mock.calls[0][0]).toBe(proxied);
    expect(passOn).not.toHaveBeenCalled();
  });

  it('never calls respondWith once disarmed, so the request goes to the network', async () => {
    const sixSwitch = createSixDisarmSwitch(async () => false);
    await sixSwitch.ready;
    sixSwitch.disarm();
    const { event, respondWith } = fakeEvent();
    const answer = vi.fn();
    const passOn = vi.fn();
    answerUnlessDisarmed(sixSwitch, event, answer, passOn);
    expect(respondWith).not.toHaveBeenCalled();
    expect(answer).not.toHaveBeenCalled();
    expect(passOn).not.toHaveBeenCalled();
  });

  it('while the startup check runs, passes the request on when it turns out retired', async () => {
    let answer!: (value: boolean) => void;
    const sixSwitch = createSixDisarmSwitch(() => new Promise<boolean>((done) => (answer = done)));
    const { event, request, respondWith } = fakeEvent();
    const network = new Response('npm');
    const passOn = vi.fn(async () => network);
    const proxy = vi.fn(async () => new Response('proxied'));
    answerUnlessDisarmed(sixSwitch, event, proxy, passOn);
    expect(respondWith).toHaveBeenCalledOnce();
    answer(true);
    expect(await respondWith.mock.calls[0][0]).toBe(network);
    expect(passOn).toHaveBeenCalledWith(request);
    expect(proxy).not.toHaveBeenCalled();
  });

  it('while the startup check runs, proxies when six is still armed', async () => {
    let answer!: (value: boolean) => void;
    const sixSwitch = createSixDisarmSwitch(() => new Promise<boolean>((done) => (answer = done)));
    const { event, respondWith } = fakeEvent();
    const proxied = new Response('proxied');
    const passOn = vi.fn();
    answerUnlessDisarmed(sixSwitch, event, async () => proxied, passOn);
    await flush();
    answer(false);
    expect(await respondWith.mock.calls[0][0]).toBe(proxied);
    expect(passOn).not.toHaveBeenCalled();
  });
});
