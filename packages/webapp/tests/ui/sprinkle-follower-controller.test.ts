// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SprinkleSummary } from '../../src/scoops/tray-sync-protocol.js';
import {
  SprinkleFollowerController,
  type SprinkleFollowerSync,
} from '../../src/ui/sprinkle-follower-controller.js';

// SprinkleRenderer is stubbed so the controller can be exercised without DOM.
vi.mock('../../src/ui/sprinkle-renderer.js', () => {
  /**
   * Manual-render gate for a sprinkle. When set via
   * `FakeRenderer.installManualRender(name)`, the next `render()` call for
   * that name returns a pending Promise that the test resolves via the
   * returned handle. Used to drive the C1-replay-order race.
   */
  const manualRenderGate = new Map<string, { resolve: () => void; reject: (err: Error) => void }>();

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
    async render(content: string, sprinkleName?: string): Promise<void> {
      this.rendered = content;
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
    pushUpdate(data: unknown): void {
      this.pushed.push(data);
    }

    static instances: FakeRenderer[] = [];
    static reset(): void {
      FakeRenderer.instances = [];
      manualRenderGate.clear();
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
  installManualRender(name: string): { resolve: () => void; reject: (err: Error) => void };
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
  cancels: Array<{ name: string; reason?: string }>;
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
  const cancels: Array<{ name: string; reason?: string }> = [];
  const manualGate = new Map<
    string,
    { resolve: (content: string) => void; reject: (err: Error) => void }
  >();

  // Built as a structurally-complete `SprinkleFollowerSync` so the
  // controller's compile-time guarantee (cancelSprinkleFetch is
  // required — R3 type design) holds for the test fake too. A future
  // controller change that adds a `this.sync.cancelSprinkleFetch(...)`
  // call must not silently fall through to a `cancels`-less fake.
  const sync: FakeSync = {
    fetched,
    licks,
    cancels,
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
    it('preserves arrival order across the fetch+render boundary (no live-replay inversion)', async () => {
      // R2-CRIT-1: previously the controller would set `this.open` BEFORE
      // awaiting `renderer.render()`. Updates arriving during render took
      // the live `pushUpdate` path, while a *pre-fetch* buffered update
      // was replayed AFTER render — inverting their arrival order.
      //
      // Scenario:
      //   U1 arrives before fetch resolves → buffered
      //   U2 arrives after fetch resolves but during render
      //   Correct delivery order: U1 then U2 (arrival order)
      //   Buggy delivery: U2 (live during render) then U1 (replayed after)
      const fetchGate = sync.installManualFetch('x');
      const renderGate = FakeRenderer.installManualRender('x');

      const reconcile = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      // openLocally is now awaiting the fetch. Update U1 lands while
      // opening — must be buffered.
      controller.handleSprinkleUpdate('x', { step: 'U1-before-render' });

      // Resolve the fetch → openLocally proceeds toward render. With the
      // fix this transitions opening→open only AFTER render finishes; the
      // sprinkle is therefore still considered "opening" while render
      // runs, so U2 also buffers (latest wins).
      fetchGate.resolve('<p>ok</p>');
      // Flush enough microtasks for openLocally to: (a) unwrap the async
      // fetch result, (b) synchronously construct the renderer + container,
      // (c) begin awaiting `renderer.render()`. Three Promise.resolve()
      // hops covers it on every runtime we care about.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(FakeRenderer.instances).toHaveLength(1);
      const renderer = FakeRenderer.instances[0];
      expect(renderer.pushed).toEqual([]); // No update delivered yet — buffered.

      // U2 arrives during render. With the buggy code this would take the
      // live path (open is set early); with the fix it stays buffered and
      // overwrites U1.
      controller.handleSprinkleUpdate('x', { step: 'U2-during-render' });

      // Resolve render → openLocally drains buffer in arrival-correct
      // order (latest wins, mirroring iOS `AppState.sprinkleUpdates[name]`).
      renderGate.resolve();
      await reconcile;

      // Final state: exactly one delivery, and it's the latest update. No
      // inverted-order replay can overwrite it.
      expect(renderer.pushed).toEqual([{ step: 'U2-during-render' }]);
    });

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

  // ---------------------------------------------------------------------------
  // R3-CRIT-1: post-render cleanup branch in openLocally — the leader closes
  // (or the controller is disposed) WHILE renderer.render() is pending.
  // Listeners registered during render must be cleared along with the
  // renderer; otherwise a re-open in the same controller fans out to leaked
  // listeners.
  // ---------------------------------------------------------------------------

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

      // The follower bridge carries an `open(path)` (added in this task); the
      // SprinkleBridge type the fake renderer's `api` is declared as doesn't
      // surface it, so narrow at the call site.
      const api = FakeRenderer.instances[0]!.api as unknown as { open: (path: string) => void };
      api.open('foo/bar.html');

      expect(openPath).toHaveBeenCalledWith('foo/bar.html');
    });
  });

  describe('R3-CRIT-1: post-render cleanup', () => {
    it('clears updateListeners when leader closes mid-render (and a re-open does not inherit them)', async () => {
      sync.contentByName.set('x', '<p>ok</p>');
      const renderGate = FakeRenderer.installManualRender('x');

      // Open the sprinkle.
      const first = controller.updateAvailable([makeSprinkle('x', { open: true })]);
      // Let openLocally enter render.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(FakeRenderer.instances).toHaveLength(1);

      // Simulate a sprinkle script that registers a listener synchronously
      // during render (CLI inline mode does this).
      const firstReceived: unknown[] = [];
      FakeRenderer.instances[0].api.on('update', (data) => firstReceived.push(data));

      // Leader closes the sprinkle while render is still pending.
      await controller.updateAvailable([]);
      // Resolve render — controller enters the post-render cleanup branch.
      renderGate.resolve();
      await first;
      expect(addSprinkle).toHaveBeenCalledTimes(1);
      expect(removeSprinkle).toHaveBeenCalledWith('x');

      // Re-open the sprinkle. The new renderer's listeners are separate;
      // the first renderer's listener must NOT receive updates.
      sync.contentByName.set('x', '<p>v2</p>');
      await controller.updateAvailable([makeSprinkle('x', { open: true })]);
      expect(FakeRenderer.instances).toHaveLength(2);
      controller.handleSprinkleUpdate('x', { step: 'after-reopen' });

      // The first renderer's listener never registered against the controller
      // permanently — it should be unregistered along with the cleanup.
      expect(firstReceived).toEqual([]);
      // The second renderer's renderer.pushUpdate path delivered normally.
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

      // After dispose nothing should fire — disposed guard in
      // handleSprinkleUpdate also catches this.
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

      // Leader closes mid-render.
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
});
