// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installWcDomStubs } from './wc-dom-stubs.js';

installWcDomStubs();

import type {
  ProfileExportPlan,
  ProfileExportSummary,
} from '../../../src/transcript/profile-export.js';
import { registerProfileExportDeps } from '../../../src/transcript/profile-export-provider.js';
import { buildProfileExportHandler } from '../../../src/ui/panel-rpc/ui-handlers.js';
import {
  describeContents,
  describeNotMoved,
  formatBytes,
  formatProfileExportReport,
  KEYS_NOTE,
  renderProfileReview,
  runProfileExportHeadless,
  saveProfileArchives,
  showProfileExportDialog,
} from '../../../src/ui/wc/wc-profile-export.js';
import { seedProfile } from '../../transcript/profile-export-seed.js';

vi.setConfig({ testTimeout: 20000 });

function summary(overrides: Partial<ProfileExportSummary> = {}): ProfileExportSummary {
  return {
    providers: ['anthropic', 'openai'],
    flagged: [
      {
        path: 'files/cones/cone/.env',
        size: 32,
        rule: 'env',
        sourcePath: '/workspace/.env',
      },
    ],
    mcp: [{ name: 'linear', url: 'https://mcp.linear.app/mcp' }],
    secrets: ['github-token', 'secrets-env'],
    mounts: ['/mnt/project'],
    cones: 2,
    scoops: 1,
    frozen: 1,
    files: 12,
    skills: 1,
    sprinkles: 0,
    bytes: 2_500_000,
    archives: ['slicc6-profile-2026-10-18.zip'],
    ...overrides,
  };
}

function plan(s: ProfileExportSummary = summary()): ProfileExportPlan {
  return {
    exportId: 'id',
    createdAt: '2026-10-18T12:00:00.000Z',
    archives: s.archives.map((filename) => ({
      filename,
      manifest: {} as never,
      byteLength: 1,
      open: () => {
        throw new Error('not in this test');
      },
    })),
    summary: s,
  };
}

const dialog = (): HTMLElement => document.querySelector('slicc-dialog') as HTMLElement;
const button = (action: string): HTMLButtonElement =>
  dialog().querySelector(`[data-profile-export-action="${action}"]`) as HTMLButtonElement;
const close = (): void => {
  dialog().dispatchEvent(new CustomEvent('slicc-dialog-close'));
};

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe('report text', () => {
  it('formats sizes and contents', () => {
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KB');
    expect(formatBytes(2_500_000)).toBe('2.4 MB');
    expect(formatBytes(50 * 1024 ** 3)).toBe('50 GB');
    expect(describeContents(summary())).toBe(
      '2 cones, 1 scoop, 1 frozen chat, 12 files, 1 skill, 0 sprinkles: 2.4 MB in 1 zip.'
    );
  });

  it('lists what stays behind, or nothing', () => {
    expect(describeNotMoved(summary())).toBe(
      'Not exported: mounts (/mnt/project); the GitHub token, secrets.env; MCP connections (linear; add them again).'
    );
    expect(describeNotMoved(summary({ mounts: [], secrets: [], mcp: [] }))).toBeNull();
  });

  it('prints both notes: providers to re-enter and the flagged files', () => {
    const report = formatProfileExportReport(summary(), { dryRun: false });
    expect(report).toContain('saved slicc6-profile-2026-10-18.zip to Downloads');
    expect(report).toContain(KEYS_NOTE);
    expect(report).toContain('Providers to re-enter: anthropic, openai');
    expect(report).toContain('Warning: the zip holds 1 credential-like file in the clear:');
    expect(report).toContain('/workspace/.env (32 B): environment file, often holds keys');
    const dry = formatProfileExportReport(summary({ providers: [], flagged: [] }), {
      dryRun: true,
    });
    expect(dry).toContain('dry run, nothing saved');
    expect(dry).toContain('Providers to re-enter: none');
    expect(dry).not.toContain('Warning');
  });
});

describe('renderProfileReview', () => {
  it('shows the providers and warns about every flagged file', () => {
    const el = renderProfileReview(summary());
    expect(el.querySelector('[data-profile-export="keys"]')?.textContent).toContain('anthropic');
    const warn = el.querySelector('[data-profile-export="flagged"]');
    expect(warn?.getAttribute('role')).toBe('alert');
    expect(warn?.textContent).toContain('in the clear');
    expect(warn?.textContent).toContain('/workspace/.env');
  });

  it('says so when there are no providers or flagged files', () => {
    const el = renderProfileReview(
      summary({ providers: [], flagged: [], mounts: [], secrets: [], mcp: [] })
    );
    expect(el.textContent).toContain('No provider accounts are set up here.');
    expect(el.querySelector('[data-profile-export="flagged"]')).toBeNull();
  });
});

describe('showProfileExportDialog', () => {
  it('plans first, saves only on confirm, then reports where the zip went', async () => {
    const save = vi.fn(
      async (_p: ProfileExportPlan, opts?: { onArchive?: (i: number, a: never) => void }) => {
        opts?.onArchive?.(0, { filename: 'slicc6-profile-2026-10-18.zip' } as never);
      }
    );
    const done = showProfileExportDialog({
      plan: async () => plan(),
      save,
      providerNames: async () => (id) => ({ anthropic: 'Anthropic', openai: 'OpenAI' })[id] ?? id,
    });
    expect(dialog().getAttribute('heading')).toBe('Export for SLICC 7');
    await vi.waitFor(() => expect(button('export').disabled).toBe(false));
    expect(dialog().textContent).toContain('/workspace/.env');
    const chips = [...dialog().querySelectorAll<HTMLElement>('.wcpx__chip')];
    expect(chips.map((c) => [c.textContent, c.title])).toEqual([
      ['Anthropic', 'anthropic'],
      ['OpenAI', 'openai'],
    ]);
    expect(save).not.toHaveBeenCalled();
    button('export').click();
    await vi.waitFor(() => expect(dialog().textContent).toContain('Saved to Downloads'));
    expect(save).toHaveBeenCalledOnce();
    expect(button('export').textContent).toBe('Done');
    button('export').click();
    close();
    await expect(done).resolves.toMatchObject({ exportId: 'id' });
    expect(document.querySelector('slicc-dialog')).toBeNull();
  });

  it('labels a split export and shows a save failure', async () => {
    const save = vi.fn(
      async (_p: ProfileExportPlan, opts?: { onArchive?: (i: number, a: never) => void }) => {
        opts?.onArchive?.(1, { filename: 'b.zip' } as never);
        throw new Error('disk full');
      }
    );
    const done = showProfileExportDialog({
      plan: async () => plan(summary({ archives: ['a.zip', 'b.zip'] })),
      save,
      providerNames: async () => (id) => id,
    });
    await vi.waitFor(() => expect(button('export').textContent).toBe('Export 2 zips'));
    button('export').click();
    await vi.waitFor(() => expect(dialog().textContent).toContain('Export failed: disk full'));
    expect(button('export').disabled).toBe(false);
    button('cancel').click();
    close();
    await expect(done).resolves.toBeNull();
  });

  it('shows a planning failure and aborts the plan when closed', async () => {
    let signal: AbortSignal | undefined;
    const done = showProfileExportDialog({
      providerNames: async () => (id) => id,
      plan: async (s) => {
        signal = s;
        const err = new Error('redaction-unavailable') as Error & { detail?: string };
        err.detail = 'secrets service down';
        throw err;
      },
    });
    await vi.waitFor(() =>
      expect(dialog().textContent).toContain(
        'Export failed: redaction-unavailable: secrets service down'
      )
    );
    button('export').click();
    close();
    await done;
    expect(signal?.aborted).toBe(true);
  });

  it('stays quiet when closed while still planning', async () => {
    let reject!: (e: Error) => void;
    const done = showProfileExportDialog({
      plan: () => new Promise((_, r) => (reject = r)),
      providerNames: async () => {
        throw new Error('never');
      },
    });
    close();
    await done;
    reject(new Error('late'));
    await Promise.resolve();
    expect(document.querySelector('slicc-dialog')).toBeNull();
  });
});

describe('runProfileExportHeadless and the panel-RPC handler', () => {
  it('plans the registered profile and reports it (dry run)', async () => {
    const { deps } = await seedProfile();
    const teardown = registerProfileExportDeps(() => deps);
    try {
      const result = await runProfileExportHeadless({ dryRun: true });
      expect(result.archives).toEqual(['slicc6-profile-2026-10-18.zip']);
      expect(result.report).toContain('Providers to re-enter: anthropic, openai');
      const viaRpc = await buildProfileExportHandler()['profile-export']({ dryRun: true });
      expect(viaRpc.archives).toEqual(result.archives);
    } finally {
      teardown();
    }
  });

  it('never saves without the dialog: a real run waits for confirmation', async () => {
    const confirmed = vi.fn(async () => plan());
    const result = await runProfileExportHeadless({ dryRun: false }, confirmed);
    expect(confirmed).toHaveBeenCalledOnce();
    expect(result.report).toContain('saved slicc6-profile-2026-10-18.zip to Downloads');
    await expect(runProfileExportHeadless({ dryRun: false }, async () => null)).rejects.toThrow(
      /cancelled/
    );
  });

  it('saves every archive through the spool and an anchor download', async () => {
    const { deps } = await seedProfile();
    const { planProfileExport } = await import('../../../src/transcript/profile-export.js');
    const p = await planProfileExport(deps);
    const clicks: string[] = [];
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicks.push(this.download);
    });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const seen: number[] = [];
    await saveProfileArchives(p, { onArchive: (i) => seen.push(i) });
    expect(clicks).toEqual(['slicc6-profile-2026-10-18.zip']);
    expect(seen).toEqual([0]);
  });
});
