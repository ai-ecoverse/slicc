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
    api: { lick: (e: unknown) => void; close: () => void; stopCone: () => void };
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

function makeFakeSync(): SprinkleFollowerSync & {
  fetched: string[];
  licks: Array<{ name: string; body: unknown; targetScoop?: string }>;
  contentByName: Map<string, string>;
} {
  const contentByName = new Map<string, string>();
  const fetched: string[] = [];
  const licks: Array<{ name: string; body: unknown; targetScoop?: string }> = [];
  const sync: SprinkleFollowerSync = {
    fetchSprinkleContent: vi.fn(async (name: string) => {
      fetched.push(name);
      const content = contentByName.get(name);
      if (content === undefined) throw new Error(`no content stub for ${name}`);
      return content;
    }),
    sendSprinkleLick: vi.fn((name, body, targetScoop) => {
      licks.push({ name, body, targetScoop });
    }),
  };
  return Object.assign(sync, { fetched, licks, contentByName });
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
  });
});
