/**
 * Agent-authored panel discovery.
 *
 * These panels are deliberately NOT gated, scanned, or signed — the agent already
 * writes files and runs shell commands without prompting, so a panel grants it no
 * new capability (see the trust model in
 * `docs/panel-system-design.md`). What IS worth testing is that one
 * malformed manifest never hides the valid panels, since discovery runs at boot.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import { AGENT_PANELS_DIR, discoverAgentPanels } from '../../../src/ui/wc/agent-panels.js';

let dbCounter = 0;
let fs: VirtualFS;

async function writePanel(name: string, manifest: unknown, entry?: string): Promise<void> {
  const dir = `${AGENT_PANELS_DIR}/${name}`;
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    `${dir}/panel.json`,
    typeof manifest === 'string' ? manifest : JSON.stringify(manifest)
  );
  if (entry) await fs.writeFile(`${dir}/${entry}`, '// panel');
}

beforeEach(async () => {
  fs = await VirtualFS.create({ dbName: `agent-panels-${++dbCounter}`, wipe: true });
});

describe('discoverAgentPanels', () => {
  it('is empty when the directory does not exist', async () => {
    expect(await discoverAgentPanels(fs)).toEqual([]);
  });

  it('discovers a panel from its manifest', async () => {
    await writePanel('kpi', { id: 'kpi', title: 'KPIs', icon: 'activity', minWidth: 240 });

    const found = await discoverAgentPanels(fs);
    expect(found).toHaveLength(1);
    expect(found[0].meta).toMatchObject({
      id: 'kpi',
      title: 'KPIs',
      icon: 'activity',
      minWidth: 240,
    });
    expect(found[0].dir).toBe(`${AGENT_PANELS_DIR}/kpi`);
  });

  it('resolves an explicit entry file relative to the panel directory', async () => {
    await writePanel('kpi', { id: 'kpi', title: 'KPIs', entry: 'panel.js' }, 'panel.js');
    expect((await discoverAgentPanels(fs))[0].entry).toBe(`${AGENT_PANELS_DIR}/kpi/panel.js`);
  });

  it('leaves entry null when the manifest declares none (the zero-JS path)', async () => {
    await writePanel('kpi', { id: 'kpi', title: 'KPIs' });
    expect((await discoverAgentPanels(fs))[0].entry).toBeNull();
  });

  it('defaults realm to sandboxed, and honors an explicit main', async () => {
    await writePanel('a', { id: 'a', title: 'A' });
    await writePanel('b', { id: 'b', title: 'B', realm: 'main' });

    const byId = new Map((await discoverAgentPanels(fs)).map((p) => [p.meta.id, p.meta.realm]));
    expect(byId.get('a')).toBe('sandboxed');
    expect(byId.get('b')).toBe('main');
  });

  it('carries a floating presentation through', async () => {
    await writePanel('m', { id: 'm', title: 'M', presentation: 'floating', anchor: 'right' });
    const meta = (await discoverAgentPanels(fs))[0].meta;
    expect(meta.presentation).toBe('floating');
    expect(meta.anchor).toBe('right');
  });

  describe('malformed manifests are skipped, not fatal', () => {
    it('skips one bad manifest while keeping the good ones', async () => {
      // Discovery runs at boot; one typo must not cost every panel.
      await writePanel('good', { id: 'good', title: 'Good' });
      await writePanel('broken', 'not json at all');
      await writePanel('alsogood', { id: 'alsogood', title: 'Also' });

      const ids = (await discoverAgentPanels(fs)).map((p) => p.meta.id).sort();
      expect(ids).toEqual(['alsogood', 'good']);
    });

    it('requires a non-empty id and title', async () => {
      await writePanel('noid', { title: 'No id' });
      await writePanel('notitle', { id: 'notitle' });
      await writePanel('blank', { id: '  ', title: '  ' });
      expect(await discoverAgentPanels(fs)).toEqual([]);
    });

    it('ignores a directory with no manifest', async () => {
      await fs.mkdir(`${AGENT_PANELS_DIR}/stray`, { recursive: true });
      await fs.writeFile(`${AGENT_PANELS_DIR}/stray/notes.txt`, 'hello');
      expect(await discoverAgentPanels(fs)).toEqual([]);
    });

    it('drops fields of the wrong type rather than trusting them', async () => {
      await writePanel('odd', {
        id: 'odd',
        title: 'Odd',
        icon: 42,
        minWidth: 'wide',
        preferredSize: { nope: true },
      });
      const meta = (await discoverAgentPanels(fs))[0].meta;
      expect(meta.icon).toBeUndefined();
      expect(meta.minWidth).toBeUndefined();
      expect(meta.preferredSize).toBeUndefined();
    });
  });
});
