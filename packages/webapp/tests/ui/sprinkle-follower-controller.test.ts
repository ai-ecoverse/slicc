// @vitest-environment jsdom
import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';
import type { SprinkleSummary } from '../../src/scoops/tray-sync-protocol.js';
import {
  SprinkleFollowerController,
  type SprinkleFollowerSync,
} from '../../src/ui/sprinkle-follower-controller.js';
import type { SprinkleAddOptions } from '../../src/ui/sprinkle-manager.js';

vi.mock('../../src/ui/sprinkle-renderer.js', () => {
  const manualRenderGate = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

  class FakeRenderer {
    container: HTMLElement;
    api: unknown;
    rendered = '';
    disposed = false;
    pushed: unknown[] = [];
    sprinkleName = '';

    constructor(container: HTMLElement, api: unknown) {
      this.container = container;
      this.api = api;
      FakeRenderer.instances.push(this);
    }
    async render(content: string, sprinkleName?: string): Promise<void> {
      this.rendered = content;
      this.sprinkleName = sprinkleName ?? '';
      const gate = sprinkleName ? manualRenderGate.get(sprinkleName) : undefined;
      if (gate) {
        manualRenderGate.delete(sprinkleName!);
        return new Promise<void>((resolve, reject) => {
          gate.resolve = resolve;
          gate.reject = reject;
        });
      }
    }
    dispose(): void {
      this.disposed = true;
    }
    activateBridgeLifecycle(): void {
      if (FakeRenderer.closeOnActivate.delete(this.sprinkleName)) {
        (this.api as { close(): void }).close();
      }
    }
    pushUpdate(data: unknown): void {
      this.pushed.push(data);
    }

    static instances: FakeRenderer[] = [];
    static closeOnActivate = new Set<string>();
    static reset(): void {
      FakeRenderer.instances = [];
      manualRenderGate.clear();
      FakeRenderer.closeOnActivate.clear();
    }
    static installManualRender(name: string): {
      resolve: () => void;
      reject: (err: Error) => void;
    } {
      const handle = {
        resolve: () => {},
        reject: (() => {}) as (err: Error) => void,
      };
      manualRenderGate.set(name, handle);
      return handle;
    }
    static installCloseOnActivate(name: string): void {
      FakeRenderer.closeOnActivate.add(name);
    }
  }
  return { SprinkleRenderer: FakeRenderer };
});

import type { SprinkleUsbApi } from '../../src/ui/sprinkle-bridge.js';

import { SprinkleRenderer } from '../../src/ui/sprinkle-renderer.js';

const FakeRenderer = SprinkleRenderer as unknown as {
  instances: Array<{
    rendered: string;
    disposed: boolean;
    pushed: unknown[];
    api: {
      lick: (e: unknown) => void;
      close: () => void;
      stopCone: () => void;
      selectScoop: (target: string) => Promise<boolean>;
      selectedScoop: () => Promise<string | null>;
      on: (event: 'update', cb: (data: unknown) => void) => void;
      off: (event: 'update', cb: (data: unknown) => void) => void;
      usb: SprinkleUsbApi;
    };
  }>;
  reset(): void;
  installManualRender(name: string): { resolve: () => void; reject: (err: Error) => void };
  installCloseOnActivate(name: string): void;
};

function makeSprinkle(name: string, opts: Partial<SprinkleSummary> = {}): SprinkleSummary {
  return {
    name,
    title: opts.title ?? `Title ${name}`,
    path: opts.path ?? `/sprinkles/${name}.shtml`,
    open: opts.open ?? false,
    autoOpen: opts.autoOpen ?? false,
    icon: opts.icon,
  };
}

interface FakeSync extends SprinkleFollowerSync {
  fetched: string[];
  licks: Array<{ name: string; body: unknown; targetScoop?: string }>;
  cancels: Array<{ name: string; reason?: string }>;

  instanceReports: string[][];
  contentByName: Map<string, string>;

  installManualFetch(name: string): {
    resolve: (content: string) => void;
    reject: (err: Error) => void;
  };
}

function makeFakeSync(): FakeSync {
  const contentByName = new Map<string, string>();
  const fetched: string[] = [];
  const licks: Array<{ name: string; body: unknown; targetScoop?: string }> = [];
  const cancels: Array<{ name: string; reason?: string }> = [];
  const instanceReports: string[][] = [];
  const manualGate = new Map<
    string,
    { resolve: (content: string) => void; reject: (err: Error) => void }
  >();

  const sync: FakeSync = {
    fetched,
    licks,
    cancels,
    instanceReports,
    contentByName,
    reportSprinkleInstances: vi.fn((names: string[]): void => {
      instanceReports.push([...names]);
    }),
    fetchSprinkleContent: vi.fn(async (name: string): Promise<string> => {
      fetched.push(name);
      const gate = manualGate.get(name);
      if (gate) {
        manualGate.delete(name);
        return new Promise<string>((resolve, reject) => {
          gate.resolve = resolve;
          gate.reject = reject;
        });
      }
      const content = contentByName.get(name);
      if (content === undefined) throw new Error(`no content stub for ${name}`);
      return content;
    }),
    sendSprinkleLick: vi.fn((name: string, body: unknown, targetScoop?: string) => {
      licks.push({ name, body, targetScoop });
    }),
    cancelSprinkleFetch: vi.fn((name: string, reason?: string) => {
      cancels.push({ name, reason });
    }),
    installManualFetch(name: string) {
      const handle = {
        resolve: (() => {}) as (content: string) => void,
        reject: (() => {}) as (err: Error) => void,
      };
      manualGate.set(name, handle);
      return handle;
    },
  };
  return sync;
}

describe('SprinkleFollowerController', () => {
  let addSprinkle: Mock<
    (
      name: string,
      title: string,
      element: HTMLElement,
      zone?: string,
      options?: SprinkleAddOptions
    ) => void
  >;
  let removeSprinkle: Mock<(name: string) => void>;
  let sync: ReturnType<typeof makeFakeSync>;
  let controller: SprinkleFollowerController;

  beforeEach(() => {
    FakeRenderer.reset();
    addSprinkle =
      vi.fn<
        (
          name: string,
          title: string,
          element: HTMLElement,
          zone?: string,
          options?: SprinkleAddOptions
        ) => void
      >();
    removeSprinkle = vi.fn<(name: string) => void>();
    sync = makeFakeSync();
    controller = new SprinkleFollowerController({
      sync,
      addSprinkle,
      removeSprinkle,
    });
  });

  describe('updateAvailable + open-state mirroring', () => {
    it('opens sprinkles marked open:true on the leader', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');

      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      expect(sync.fetched).toEqual(['welcome']);
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      const callArgs = addSprinkle.mock.calls[0];
      expect(callArgs[0]).toBe('welcome');
      expect(callArgs[1]).toBe('Title welcome');
      expect(FakeRenderer.instances).toHaveLength(1);
      expect(FakeRenderer.instances[0].rendered).toBe('<p>hi</p>');
    });

    it('forwards the leader-supplied icon spec to addSprinkle', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');

      await controller.updateAvailable([makeSprinkle('welcome', { open: true, icon: 'rocket' })]);

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      const callArgs = addSprinkle.mock.calls[0];
      expect(callArgs[4]).toEqual({ icon: 'rocket' });
    });

    it('passes an undefined icon when the summary omits one', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');

      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      const callArgs = addSprinkle.mock.calls[0];
      expect(callArgs[4]).toEqual({ icon: undefined });
    });

    it('does not open sprinkles with open:false', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');

      await controller.updateAvailable([makeSprinkle('welcome', { open: false })]);

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(FakeRenderer.instances).toHaveLength(0);
    });

    it('closes a sprinkle when the leader flips open:true → open:false', async () => {
      sync.contentByName.set('welcome', '<p>v1</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      addSprinkle.mockClear();

      await controller.updateAvailable([makeSprinkle('welcome', { open: false })]);

      expect(removeSprinkle).toHaveBeenCalledWith('welcome');
      expect(FakeRenderer.instances[0].disposed).toBe(true);
    });

    it('closes a sprinkle that vanishes from the list entirely', async () => {
      sync.contentByName.set('welcome', '<p>v1</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      await controller.updateAvailable([]);

      expect(removeSprinkle).toHaveBeenCalledWith('welcome');
    });

    it('does not re-render or re-add when a sprinkle is already open', async () => {
      sync.contentByName.set('welcome', '<p>v1</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(FakeRenderer.instances).toHaveLength(1);

      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(FakeRenderer.instances).toHaveLength(1);
    });

    it('opens new sprinkles while keeping existing ones', async () => {
      sync.contentByName.set('a', '<p>a</p>');
      sync.contentByName.set('b', '<p>b</p>');

      await controller.updateAvailable([makeSprinkle('a', { open: true })]);
      await controller.updateAvailable([
        makeSprinkle('a', { open: true }),
        makeSprinkle('b', { open: true }),
      ]);

      expect(addSprinkle).toHaveBeenCalledTimes(2);
      expect(FakeRenderer.instances).toHaveLength(2);
    });

    it('tolerates a fetch failure without throwing or losing other sprinkles', async () => {
      sync.contentByName.set('good', '<p>ok</p>');

      await controller.updateAvailable([
        makeSprinkle('bad', { open: true }),
        makeSprinkle('good', { open: true }),
      ]);

      const calledNames = addSprinkle.mock.calls.map((c) => c[0]);
      expect(calledNames).toContain('good');

      expect(calledNames).not.toContain('bad');
    });
  });

  describe('sprinkle.update routing', () => {
    it('pushes the update to the open sprinkle renderer', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      controller.handleSprinkleUpdate('welcome', { step: 3 });

      expect(FakeRenderer.instances[0].pushed).toEqual([{ step: 3 }]);
    });

    it('drops updates for closed sprinkles silently', () => {
      expect(() => controller.handleSprinkleUpdate('unknown', { x: 1 })).not.toThrow();
    });
  });

  describe('bridge wiring', () => {
    it('forwards lick events from the bridge to sync.sendSprinkleLick', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      FakeRenderer.instances[0].api.lick({ action: 'go', data: { x: 1 } });

      expect(sync.licks).toEqual([
        { name: 'welcome', body: { action: 'go', data: { x: 1 } }, targetScoop: undefined },
      ]);
    });

    it('forwards an explicit lick target as targetScoop instead of dropping it (#3089)', async () => {
      sync.contentByName.set('review', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('review', { open: true })]);

      FakeRenderer.instances[0].api.lick({ action: 'publish', data: { id: 7 }, target: 'cone-b' });
      FakeRenderer.instances[0].api.lick({ action: 'done', target: '' });

      expect(sync.licks).toEqual([
        { name: 'review', body: { action: 'publish', data: { id: 7 } }, targetScoop: 'cone-b' },
        { name: 'review', body: { action: 'done', data: undefined }, targetScoop: undefined },
      ]);
    });

    it('forwards stopCone via a special __stopCone__ sprinkle lick', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      FakeRenderer.instances[0].api.stopCone();

      expect(sync.licks).toEqual([
        { name: 'welcome', body: { action: '__stopCone__' }, targetScoop: undefined },
      ]);
    });

    it('close() from the bridge removes the sprinkle from the layout', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      FakeRenderer.instances[0].api.close();

      expect(removeSprinkle).toHaveBeenCalledWith('welcome');
      expect(FakeRenderer.instances[0].disposed).toBe(true);
    });

    it('every slicc.usb method rejects on a follower, none is undefined', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const { usb } = FakeRenderer.instances[0].api;

      const calls: Array<[string, Promise<unknown>]> = [
        ['list', usb.list()],
        ['request', usb.request()],
        ['open', usb.open('usb1')],
        ['close', usb.close('usb1')],
        ['reset', usb.reset('usb1')],
        ['selectConfiguration', usb.selectConfiguration('usb1', 1)],
        ['claimInterface', usb.claimInterface('usb1', 1)],
        ['releaseInterface', usb.releaseInterface('usb1', 1)],
        ['clearHalt', usb.clearHalt('usb1', 'in', 3)],
        ['transferIn', usb.transferIn('usb1', 3, 64)],
        ['transferOut', usb.transferOut('usb1', 2, new Uint8Array([1]))],
      ];

      for (const [name, promise] of calls) {
        await expect(promise, name).rejects.toThrow(/usb not supported/);
      }
    });

    it('publishes the renderer before releasing a queued close lifecycle call', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      FakeRenderer.installCloseOnActivate('welcome');

      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);

      expect(removeSprinkle).toHaveBeenCalledWith('welcome');
      expect(FakeRenderer.instances[0].disposed).toBe(true);
    });
  });

  describe('dispose', () => {
    it('closes every open sprinkle and clears state', async () => {
      sync.contentByName.set('a', '<p>a</p>');
      sync.contentByName.set('b', '<p>b</p>');
      await controller.updateAvailable([
        makeSprinkle('a', { open: true }),
        makeSprinkle('b', { open: true }),
      ]);

      controller.dispose();

      expect(removeSprinkle).toHaveBeenCalledWith('a');
      expect(removeSprinkle).toHaveBeenCalledWith('b');
      expect(FakeRenderer.instances.every((r) => r.disposed)).toBe(true);
    });

    it('handleSprinkleUpdate after dispose is a no-op (I7 disposed guard)', async () => {
      sync.contentByName.set('a', '<p>a</p>');
      await controller.updateAvailable([makeSprinkle('a', { open: true })]);
      const renderer = FakeRenderer.instances[0];

      controller.dispose();
      controller.handleSprinkleUpdate('a', { stale: true });

      expect(renderer.pushed).toEqual([]);
    });
  });

  describe('C2: close-during-open race', () => {
    it('does not attach a sprinkle the leader closed while content was still loading', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);

      await controller.updateAvailable([makeSprinkle('x', { open: false })]);

      gate.resolve('<p>late</p>');
      await first;

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(removeSprinkle).not.toHaveBeenCalled();

      expect(FakeRenderer.instances).toHaveLength(0);
    });

    it('does not attach when the sprinkle vanishes from the list while fetching', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      await controller.updateAvailable([]);
      gate.resolve('<p>late</p>');
      await first;

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(FakeRenderer.instances).toHaveLength(0);
    });

    it('still attaches if the latest list keeps the sprinkle open', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);

      await controller.updateAvailable([makeSprinkle('x', { open: true })]);
      gate.resolve('<p>ok</p>');
      await first;

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(FakeRenderer.instances).toHaveLength(1);
    });
  });

  describe('C1: sprinkle.update during in-flight open', () => {
    it('preserves arrival order across the fetch+render boundary (no live-replay inversion)', async () => {
      const fetchGate = sync.installManualFetch('x');
      const renderGate = FakeRenderer.installManualRender('x');

      const reconcile = controller.updateAvailable([makeSprinkle('x', { open: true })]);

      controller.handleSprinkleUpdate('x', { step: 'U1-before-render' });

      fetchGate.resolve('<p>ok</p>');

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(FakeRenderer.instances).toHaveLength(1);
      const renderer = FakeRenderer.instances[0];
      expect(renderer.pushed).toEqual([]);

      controller.handleSprinkleUpdate('x', { step: 'U2-during-render' });

      renderGate.resolve();
      await reconcile;

      expect(renderer.pushed).toEqual([{ step: 'U2-during-render' }]);
    });

    it('buffers a sprinkle.update arriving before the open finishes and replays it', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);

      controller.handleSprinkleUpdate('x', { step: 1 });

      controller.handleSprinkleUpdate('x', { step: 2 });
      gate.resolve('<p>ok</p>');
      await first;

      const renderer = FakeRenderer.instances[0];
      expect(renderer.pushed).toEqual([{ step: 2 }]);
    });

    it('does not buffer when the sprinkle gets cancelled mid-fetch', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      controller.handleSprinkleUpdate('x', { step: 1 });

      await controller.updateAvailable([makeSprinkle('x', { open: false })]);
      gate.resolve('<p>late</p>');
      await first;

      expect(FakeRenderer.instances).toHaveLength(0);
    });
  });

  describe('C3: bridge on/off update listeners (CLI inline mode)', () => {
    it('delivers handleSprinkleUpdate payloads to bridge.on("update") listeners', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const received: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => received.push(data));

      controller.handleSprinkleUpdate('welcome', { step: 1 });
      controller.handleSprinkleUpdate('welcome', { step: 2 });

      expect(received).toEqual([{ step: 1 }, { step: 2 }]);
    });

    it('off() removes the listener so further updates are not delivered to it', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const received: unknown[] = [];
      const cb = (data: unknown) => received.push(data);
      FakeRenderer.instances[0].api.on('update', cb);
      FakeRenderer.instances[0].api.off('update', cb);

      controller.handleSprinkleUpdate('welcome', { step: 1 });

      expect(received).toEqual([]);
    });

    it('fans out to listeners AND to renderer.pushUpdate', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const received: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => received.push(data));

      controller.handleSprinkleUpdate('welcome', { step: 1 });

      expect(received).toEqual([{ step: 1 }]);
      expect(FakeRenderer.instances[0].pushed).toEqual([{ step: 1 }]);
    });

    it('drops listener errors without breaking sibling listeners', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const ok: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', () => {
        throw new Error('listener bug');
      });
      FakeRenderer.instances[0].api.on('update', (data) => ok.push(data));

      controller.handleSprinkleUpdate('welcome', { step: 1 });

      expect(ok).toEqual([{ step: 1 }]);
    });

    it('clears listeners when the sprinkle is closed locally', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const received: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => received.push(data));

      await controller.updateAvailable([makeSprinkle('welcome', { open: false })]);

      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      controller.handleSprinkleUpdate('welcome', { step: 1 });

      expect(received).toEqual([]);
    });
  });

  describe('bridge selectScoop()', () => {
    it('returns false when no selectScoop handler is wired', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const api = FakeRenderer.instances[0]!.api;
      await expect(api.selectScoop('scoop:issue-triage-1')).resolves.toBe(false);
    });

    it('delegates to the injected selectScoop handler', async () => {
      const selectScoop = vi.fn().mockReturnValue(true);
      sync.contentByName.set('welcome', '<p>hi</p>');
      const customController = new SprinkleFollowerController({
        sync,
        addSprinkle,
        removeSprinkle,
        selectScoop,
      });
      await customController.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const api = FakeRenderer.instances[0]!.api;
      await expect(api.selectScoop('cone:cone-research')).resolves.toBe(true);
      expect(selectScoop).toHaveBeenCalledWith('cone:cone-research');
    });
  });

  describe('bridge selectedScoop()', () => {
    it('resolves null when no selectedScoop handler is wired', async () => {
      sync.contentByName.set('welcome', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const api = FakeRenderer.instances[0]!.api;
      await expect(api.selectedScoop()).resolves.toBeNull();
    });

    it('returns the current target without calling selectScoop', async () => {
      const selectScoop = vi.fn().mockReturnValue(true);
      const selectedScoop = vi.fn().mockReturnValue('scoop:helper');
      sync.contentByName.set('welcome', '<p>hi</p>');
      const customController = new SprinkleFollowerController({
        sync,
        addSprinkle,
        removeSprinkle,
        selectScoop,
        selectedScoop,
      });
      await customController.updateAvailable([makeSprinkle('welcome', { open: true })]);
      const api = FakeRenderer.instances[0]!.api;
      await expect(api.selectedScoop()).resolves.toBe('scoop:helper');
      expect(selectedScoop).toHaveBeenCalledOnce();
      expect(selectScoop).not.toHaveBeenCalled();
    });
  });

  describe('bridge open() hook', () => {
    it('delegates bridge open() to the provided open option', async () => {
      const openPath = vi.fn();
      sync.contentByName.set('welcome', '<p>hi</p>');
      const customController = new SprinkleFollowerController({
        sync,
        addSprinkle,
        removeSprinkle,
        open: openPath,
      });

      await customController.updateAvailable([makeSprinkle('welcome', { open: true })]);

      const api = FakeRenderer.instances[0]!.api as unknown as { open: (path: string) => void };
      api.open('foo/bar.html');

      expect(openPath).toHaveBeenCalledWith('foo/bar.html');
    });
  });

  describe('R3-CRIT-1: post-render cleanup', () => {
    it('clears updateListeners when leader closes mid-render (and a re-open does not inherit them)', async () => {
      sync.contentByName.set('x', '<p>ok</p>');
      const renderGate = FakeRenderer.installManualRender('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);

      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(FakeRenderer.instances).toHaveLength(1);

      const firstReceived: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => firstReceived.push(data));

      await controller.updateAvailable([]);

      renderGate.resolve();
      await first;
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(removeSprinkle).toHaveBeenCalledWith('x');

      sync.contentByName.set('x', '<p>v2</p>');
      await controller.updateAvailable([makeSprinkle('x', { open: true })]);
      expect(FakeRenderer.instances).toHaveLength(2);
      controller.handleSprinkleUpdate('x', { step: 'after-reopen' });

      expect(firstReceived).toEqual([]);

      expect(FakeRenderer.instances[1].pushed).toEqual([{ step: 'after-reopen' }]);
    });

    it('clears updateListeners when controller is disposed mid-render', async () => {
      sync.contentByName.set('x', '<p>ok</p>');
      const renderGate = FakeRenderer.installManualRender('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      const firstReceived: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => firstReceived.push(data));

      controller.dispose();
      renderGate.resolve();
      await first;

      controller.handleSprinkleUpdate('x', { step: 'post-dispose' });
      expect(firstReceived).toEqual([]);
    });

    it('post-render cleanup calls renderer.dispose, container.remove, removeSprinkle', async () => {
      sync.contentByName.set('x', '<p>ok</p>');
      const renderGate = FakeRenderer.installManualRender('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      const renderer = FakeRenderer.instances[0];

      await controller.updateAvailable([]);
      renderGate.resolve();
      await first;

      expect(renderer.disposed).toBe(true);
      expect(removeSprinkle).toHaveBeenCalledWith('x');
    });
  });

  describe('handleSprinkleReloaded', () => {
    it('re-renders the sprinkle in place without removing it from the layout', async () => {
      sync.contentByName.set('dash', '<div>v1</div>');
      await controller.updateAvailable([makeSprinkle('dash', { open: true })]);

      expect(FakeRenderer.instances).toHaveLength(1);
      const firstRenderer = FakeRenderer.instances[0];
      expect(firstRenderer.rendered).toBe('<div>v1</div>');

      sync.contentByName.set('dash', '<div>v2</div>');
      await controller.handleSprinkleReloaded('dash');

      expect(firstRenderer.disposed).toBe(true);
      expect(FakeRenderer.instances).toHaveLength(2);
      expect(FakeRenderer.instances[1].rendered).toBe('<div>v2</div>');
      expect(removeSprinkle).not.toHaveBeenCalled();
    });

    it('does not re-run addSprinkle on reload (keeps parked/minimized placement)', async () => {
      sync.contentByName.set('dash', '<div>v1</div>');
      await controller.updateAvailable([
        makeSprinkle('dash', { open: true, title: 'Dash', icon: 'gauge' }),
      ]);
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      addSprinkle.mockClear();

      sync.contentByName.set('dash', '<div>v2</div>');
      await controller.handleSprinkleReloaded('dash');

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(removeSprinkle).not.toHaveBeenCalled();
    });

    it('no-ops for a sprinkle that is not open', async () => {
      await controller.handleSprinkleReloaded('nonexistent');

      expect(FakeRenderer.instances).toHaveLength(0);
      expect(sync.fetched).toHaveLength(0);
    });

    it('clears update listeners so re-registered ones work after reload', async () => {
      sync.contentByName.set('dash', '<div>v1</div>');
      await controller.updateAvailable([makeSprinkle('dash', { open: true })]);

      const listener = vi.fn();
      const api = FakeRenderer.instances[0].api;
      api.on('update', listener);

      sync.contentByName.set('dash', '<div>v2</div>');
      await controller.handleSprinkleReloaded('dash');

      controller.handleSprinkleUpdate('dash', { x: 1 });
      expect(listener).not.toHaveBeenCalled();
    });
  });

  describe('sprinkle.instances reporting', () => {
    it('reports the rendered set after a sprinkle attaches', async () => {
      sync.contentByName.set('loose-ends', '<p>hi</p>');

      await controller.updateAvailable([makeSprinkle('loose-ends', { open: true })]);

      expect(sync.instanceReports.at(-1)).toEqual(['loose-ends']);
    });

    it('reports the shrunken set after a close', async () => {
      sync.contentByName.set('loose-ends', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('loose-ends', { open: true })]);

      await controller.updateAvailable([makeSprinkle('loose-ends', { open: false })]);

      expect(sync.instanceReports.at(-1)).toEqual([]);
    });

    it('does not report a sprinkle whose fetch failed', async () => {
      await controller.updateAvailable([makeSprinkle('bad', { open: true })]);

      expect(sync.instanceReports.at(-1)).toEqual([]);
    });

    it('reports an empty set on dispose', async () => {
      sync.contentByName.set('loose-ends', '<p>hi</p>');
      await controller.updateAvailable([makeSprinkle('loose-ends', { open: true })]);

      controller.dispose();

      expect(sync.instanceReports.at(-1)).toEqual([]);
    });

    it('survives a sync that throws mid-reconnect', async () => {
      sync.contentByName.set('loose-ends', '<p>hi</p>');
      vi.mocked(sync.reportSprinkleInstances).mockImplementation(() => {
        throw new Error('channel closed');
      });

      await expect(
        controller.updateAvailable([makeSprinkle('loose-ends', { open: true })])
      ).resolves.toBeUndefined();
      expect(addSprinkle).toHaveBeenCalledTimes(1);
    });
  });
});
