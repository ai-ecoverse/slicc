// @vitest-environment jsdom
import { describe, expect, it, vi, beforeEach } from 'vitest';
import {
  SprinkleFollowerController,
  type SprinkleFollowerSync,
} from '../../src/ui/sprinkle-follower-controller.js';
import type { SprinkleSummary } from '../../src/scoops/tray-sync-protocol.js';

// SprinkleRenderer is stubbed so the controller can be exercised without DOM.
vi.mock('../../src/ui/sprinkle-renderer.js', () => {
  class FakeRenderer {
    container: HTMLElement;
    api: unknown;
    rendered = '';
    disposed = false;
    pushed: unknown[] = [];

    constructor(container: HTMLElement, api: unknown) {
      this.container = container;
      this.api = api;
      FakeRenderer.instances.push(this);
    }
    async render(content: string): Promise<void> {
      this.rendered = content;
    }
    dispose(): void {
      this.disposed = true;
    }
    pushUpdate(data: unknown): void {
      this.pushed.push(data);
    }

    static instances: FakeRenderer[] = [];
    static reset(): void {
      FakeRenderer.instances = [];
    }
  }
  return { SprinkleRenderer: FakeRenderer };
});

// Bring the mock surface into the test file so we can assert against it.
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
      on: (event: 'update', cb: (data: unknown) => void) => void;
      off: (event: 'update', cb: (data: unknown) => void) => void;
    };
  }>;
  reset(): void;
};

function makeSprinkle(name: string, opts: Partial<SprinkleSummary> = {}): SprinkleSummary {
  return {
    name,
    title: opts.title ?? `Title ${name}`,
    path: opts.path ?? `/sprinkles/${name}.shtml`,
    open: opts.open ?? false,
    autoOpen: opts.autoOpen ?? false,
  };
}

interface FakeSync extends SprinkleFollowerSync {
  fetched: string[];
  licks: Array<{ name: string; body: unknown; targetScoop?: string }>;
  contentByName: Map<string, string>;
  /** When set for a given name, calls to `fetchSprinkleContent(name)` resolve
   *  only when the test invokes the returned resolver. Used to drive timing
   *  races (e.g. close-while-opening, update-during-open). */
  installManualFetch(name: string): {
    resolve: (content: string) => void;
    reject: (err: Error) => void;
  };
}

function makeFakeSync(): FakeSync {
  const contentByName = new Map<string, string>();
  const fetched: string[] = [];
  const licks: Array<{ name: string; body: unknown; targetScoop?: string }> = [];
  const manualGate = new Map<
    string,
    { resolve: (content: string) => void; reject: (err: Error) => void }
  >();

  const sync = {
    fetched,
    licks,
    contentByName,
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
    installManualFetch(name: string) {
      const handle = {
        resolve: (() => {}) as (content: string) => void,
        reject: (() => {}) as (err: Error) => void,
      };
      manualGate.set(name, handle);
      return handle;
    },
  };
  return sync as FakeSync;
}

describe('SprinkleFollowerController', () => {
  let addSprinkle: ReturnType<typeof vi.fn>;
  let removeSprinkle: ReturnType<typeof vi.fn>;
  let sync: ReturnType<typeof makeFakeSync>;
  let controller: SprinkleFollowerController;

  beforeEach(() => {
    FakeRenderer.reset();
    addSprinkle = vi.fn();
    removeSprinkle = vi.fn();
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

      // Same list again — should be a no-op.
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
      // 'bad' has no stub → fetch will throw.

      await controller.updateAvailable([
        makeSprinkle('bad', { open: true }),
        makeSprinkle('good', { open: true }),
      ]);

      // 'good' still opened.
      const calledNames = addSprinkle.mock.calls.map((c) => c[0]);
      expect(calledNames).toContain('good');
      // 'bad' never reached the layout.
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

      // pushUpdate should not have been called for the post-dispose payload.
      expect(renderer.pushed).toEqual([]);
    });
  });

  // ---------------------------------------------------------------------------
  // Concurrency edges — C1 (update buffering), C2 (close-during-open race).
  // The PR review caught both of these as real holes; tests pin them.
  // ---------------------------------------------------------------------------

  describe('C2: close-during-open race', () => {
    it('does not attach a sprinkle the leader closed while content was still loading', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      // Leader closes the sprinkle while the fetch is in flight.
      await controller.updateAvailable([makeSprinkle('x', { open: false })]);
      // Now resolve the fetch — controller must NOT attach the sprinkle.
      gate.resolve('<p>late</p>');
      await first;

      expect(addSprinkle).not.toHaveBeenCalled();
      expect(removeSprinkle).not.toHaveBeenCalled();
      // No renderer should have been constructed.
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
      // A reconcile mid-fetch — still open.
      await controller.updateAvailable([makeSprinkle('x', { open: true })]);
      gate.resolve('<p>ok</p>');
      await first;

      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(FakeRenderer.instances).toHaveLength(1);
    });
  });

  describe('C1: sprinkle.update during in-flight open', () => {
    it('buffers a sprinkle.update arriving before the open finishes and replays it', async () => {
      const gate = sync.installManualFetch('x');

      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      // Update arrives before fetch resolves — must be buffered, not dropped.
      controller.handleSprinkleUpdate('x', { step: 1 });
      // A second update overwrites the first (iOS behavior: latest wins).
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
      // Leader closes the sprinkle. Buffer for 'x' should be cleared.
      await controller.updateAvailable([makeSprinkle('x', { open: false })]);
      gate.resolve('<p>late</p>');
      await first;

      // Sprinkle was never attached — buffer should not surface anywhere.
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
      // Re-open; the stale listener from the previous renderer must be gone.
      await controller.updateAvailable([makeSprinkle('welcome', { open: true })]);
      controller.handleSprinkleUpdate('welcome', { step: 1 });

      expect(received).toEqual([]);
    });
  });
});
