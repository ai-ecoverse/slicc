import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-surface.js';

interface SurfaceArgs {
  surfaceId?: string;
  active?: boolean;
  layout?: 'flex' | 'block' | 'column';
}

/**
 * The workbench body (`.wbbody`) the surfaces live inside: a positioned, bordered
 * box that gives the absolutely-filled `<slicc-surface>` a frame to fill. Stories
 * mount one surface at a time inside it so the `inset:0` geometry resolves.
 */
function wbbody(...surfaces: HTMLElement[]): HTMLElement {
  const body = document.createElement('div');
  body.style.cssText =
    'position:relative;width:760px;height:420px;border:1px solid var(--line);border-radius:12px;overflow:hidden;background:var(--canvas);font-family:var(--ui);';
  body.append(...surfaces);
  return body;
}

function surface(args: SurfaceArgs, inner: string): HTMLElement {
  const el = document.createElement('slicc-surface');
  if (args.surfaceId) el.setAttribute('surface-id', args.surfaceId);
  if (args.active) el.setAttribute('active', '');
  if (args.layout) el.setAttribute('layout', args.layout);
  el.innerHTML = inner;
  return el;
}

/** Files surface body — the prototype tree + preview (`.tree` / `.fileview`). */
const FILES_HTML = `
  <div class="tree" style="width:190px;flex:0 0 auto;border-right:1px solid var(--line);overflow:auto;padding:10px 8px;font:12px var(--ui);">
    <div class="grp" style="color:var(--txt-3);padding:5px 8px 3px;">workspace/</div>
    <div class="f" style="display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:7px;color:var(--ink);">hero.tsx</div>
    <div class="f on" style="display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:7px;color:var(--violet);background:color-mix(in srgb,var(--violet) 10%,#fff);">hero.css</div>
    <div class="f" style="display:flex;align-items:center;gap:7px;padding:4px 8px;border-radius:7px;color:var(--ink);">tokens.css</div>
  </div>
  <div class="fileview" style="flex:1;overflow:auto;padding:14px 16px;font:12.5px/1.7 var(--ui);color:var(--ink);white-space:pre-wrap;"><div class="fh" style="color:var(--txt-3);font-size:11px;margin-bottom:10px;">workspace/hero.css · edited by designer</div>.hero {\n  background: #faf6f1;\n  padding: 96px 8vw;\n}</div>`;

/** Terminal surface body — the prototype's one dark `.term` canvas. */
const TERM_HTML = `
  <div class="term" style="flex:1;background:#0c0c0e;color:#e7e7ea;font:12.5px/1.75 var(--mono);padding:16px 18px;overflow:auto;white-space:pre-wrap;"><span style="color:var(--rose);">researcher /scoops/researcher ❯</span> grep -rn "hero" src/ | wc -l\n<span style="color:#8a8a93;">17 matches · 4 files</span>\n<span style="color:var(--rose);">researcher /scoops/researcher ❯</span> </div>`;

/** Memory surface body — the prototype scroll list (`.mem` / `.memrow`). */
const MEM_HTML = `
  <div class="mem" style="flex:1;overflow:auto;padding:14px 16px;">
    <div class="memrow fresh" style="border:1px solid color-mix(in srgb,var(--rose) 45%,var(--line));border-radius:11px;padding:11px 13px;margin-bottom:9px;background:color-mix(in srgb,var(--rose) 7%,#fff);">
      <div class="mt" style="display:flex;align-items:center;gap:8px;"><b style="font-size:13px;">palette preference: warm paper</b><span class="mtag us" style="margin-left:auto;font-size:10px;border-radius:26px;padding:1px 8px;color:var(--rose);background:color-mix(in srgb,var(--rose) 12%,#fff);border:1px solid color-mix(in srgb,var(--rose) 28%,var(--line));">user</span></div>
      <div class="ms" style="font-size:12.5px;color:var(--txt-2);margin-top:5px;line-height:1.5;">Prefers paper #faf6f1 canvas + violet accent + single pill CTA.</div>
    </div>
    <div class="memrow" style="border:1px solid var(--line);border-radius:11px;padding:11px 13px;margin-bottom:9px;">
      <div class="mt" style="display:flex;align-items:center;gap:8px;"><b style="font-size:13px;">icon buttons need tooltips</b><span class="mtag fb" style="margin-left:auto;font-size:10px;border-radius:26px;padding:1px 8px;color:var(--cyan);background:color-mix(in srgb,var(--cyan) 12%,#fff);border:1px solid color-mix(in srgb,var(--cyan) 28%,var(--line));">feedback</span></div>
      <div class="ms" style="font-size:12.5px;color:var(--txt-2);margin-top:5px;line-height:1.5;">All icon-only buttons must have data-tooltip + aria-label.</div>
    </div>
  </div>`;

/** Browser/CDP surface body — the prototype `.bbar` + before/after `.bcompare`. */
const BROWSER_HTML = `
  <div class="bbar" style="display:flex;align-items:center;gap:7px;padding:9px 13px;border-bottom:1px solid var(--line);background:var(--canvas);">
    <span style="width:10px;height:10px;border-radius:50%;background:#ff5f57;"></span>
    <span style="width:10px;height:10px;border-radius:50%;background:#febc2e;"></span>
    <span style="width:10px;height:10px;border-radius:50%;background:#28c840;"></span>
    <span class="burl" style="margin-left:10px;font:11px var(--ui);color:var(--txt-2);background:var(--ghost);border-radius:8px;padding:4px 11px;">https://acme.com · live page via CDP</span>
  </div>
  <div class="bcompare" style="flex:1;display:grid;grid-template-columns:1fr 1fr;gap:14px;padding:18px;min-height:0;">
    <div style="display:flex;flex-direction:column;gap:8px;"><div style="font:10px var(--ui);color:var(--txt-3);text-transform:uppercase;letter-spacing:.06em;">before</div><div style="flex:1;border-radius:12px;padding:22px;background:#0e0e0f;display:flex;flex-direction:column;justify-content:center;"><div style="color:#fff;font-size:26px;font-weight:700;">Ship faster.</div></div></div>
    <div style="display:flex;flex-direction:column;gap:8px;"><div style="font:10px var(--ui);color:var(--violet);text-transform:uppercase;letter-spacing:.06em;">after</div><div style="flex:1;border:1px solid var(--line);border-radius:12px;padding:22px;background:#faf6f1;display:flex;flex-direction:column;justify-content:center;"><div style="font-size:28px;font-weight:800;letter-spacing:-.03em;color:#16110c;line-height:1.05;">Make something <em style="font-style:normal;color:var(--violet);">people warm to.</em></div></div></div>
  </div>`;

const meta: Meta<SurfaceArgs> = {
  title: 'Workbench/Surface',
  component: 'slicc-surface',
  tags: ['autodocs'],
  argTypes: {
    surfaceId: { control: 'text', description: 'Identifier (mirrors data-s)' },
    active: { control: 'boolean', description: 'Reveal the surface (.surface.on)' },
    layout: {
      control: 'inline-radio',
      options: ['flex', 'block', 'column'],
      description: 'Reveal display mode',
    },
  },
};

export default meta;
type Story = StoryObj<SurfaceArgs>;

/** Files surface, active — tree + preview revealed as a flex row (default layout). */
export const FilesActive: Story = {
  render: () => wbbody(surface({ surfaceId: 'files', active: true, layout: 'flex' }, FILES_HTML)),
};

/** Terminal surface, active — the one dark shell canvas (stays dark by design). */
export const TerminalActive: Story = {
  render: () => wbbody(surface({ surfaceId: 'term', active: true, layout: 'flex' }, TERM_HTML)),
};

/** Memory surface, active — the scroll list revealed as a block (mem/pal layout). */
export const MemoryActiveBlock: Story = {
  render: () => wbbody(surface({ surfaceId: 'memory', active: true, layout: 'block' }, MEM_HTML)),
};

/** Browser/CDP surface, active — column layout with the #fafafa paper backdrop. */
export const BrowserActiveColumn: Story = {
  render: () =>
    wbbody(surface({ surfaceId: 'browser', active: true, layout: 'column' }, BROWSER_HTML)),
};

/** Hidden (inactive) surface — fills the body but renders nothing visible. */
export const Hidden: Story = {
  render: () => wbbody(surface({ surfaceId: 'files', active: false, layout: 'flex' }, FILES_HTML)),
};

/**
 * Stacked surfaces sharing one body — only the active one shows, the rest stay
 * hidden behind it (the prototype's exclusive `select()` behavior).
 */
export const StackedExclusive: Story = {
  render: () =>
    wbbody(
      surface({ surfaceId: 'files', active: false, layout: 'flex' }, FILES_HTML),
      surface({ surfaceId: 'term', active: false, layout: 'flex' }, TERM_HTML),
      surface({ surfaceId: 'memory', active: true, layout: 'block' }, MEM_HTML)
    ),
};
