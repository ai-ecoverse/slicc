import type { Meta, StoryObj } from '@storybook/web-components-vite';
// The composed chrome (registered by an earlier wave) — importing its
// side-effect module so the rounded card upgrades and renders in Storybook.
import '../primitives/slicc-pane.js';
import './slicc-workbench-pane.js';
import type { SliccWorkbenchPane } from './slicc-workbench-pane.js';

interface WorkbenchPaneArgs {
  /** Expanded (open) vs. collapsed. */
  open?: boolean;
}

const meta: Meta<WorkbenchPaneArgs> = {
  title: 'Workbench/WorkbenchPane',
  component: 'slicc-workbench-pane',
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: 'boolean',
      description: 'Expanded vs. collapsed (mirrors the prototype .shell.open .workbench)',
    },
  },
};

export default meta;
type Story = StoryObj<WorkbenchPaneArgs>;

/**
 * Prototype workbench chrome (`.wbhead` tabstrip + `.wbbody` memory surface) that
 * lives in `proto/StellarRubySwift.html` but NOT (yet) in this library — inlined
 * here as demo presentation so the floating container is reviewable with its real
 * contents. The sibling `<slicc-workbench-header>` / `<slicc-workbench-body>`
 * (built in this same wave) are composed BY TAG; until they register they remain
 * inert wrappers, so the demo chrome carries the visible markup.
 */
const DEMO_CSS = `
.wbpane-demo .wbhead { display:flex; align-items:center; gap:6px; padding:8px 12px; border-bottom:1px solid var(--line); overflow:hidden; }
.wbpane-demo .tabstrip { display:flex; align-items:center; gap:6px; min-width:0; overflow:hidden; }
.wbpane-demo .tab { display:inline-flex; align-items:center; gap:6px; font:500 12px/1 var(--ui); color:var(--ink); background:var(--canvas); border:1px solid var(--line); border-radius:8px; height:28px; padding:0 9px; cursor:pointer; white-space:nowrap; flex:0 0 auto; }
.wbpane-demo .tab.on { background:color-mix(in srgb,var(--violet) 9%,var(--canvas)); border-color:color-mix(in srgb,var(--violet) 34%,var(--line)); }
.wbpane-demo .tab .sg { background:var(--rainbow); -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:700; }
.wbpane-demo .tab .x { margin-left:3px; width:15px; height:15px; border-radius:4px; display:grid; place-items:center; font-size:10px; color:var(--txt-3); }
.wbpane-demo .spacer { flex:1; }
.wbpane-demo .ptag { font:10px var(--ui); color:var(--violet); background:color-mix(in srgb,var(--violet) 12%,var(--canvas)); border:1px solid color-mix(in srgb,var(--violet) 30%,var(--line)); border-radius:26px; padding:2px 9px; flex:0 0 auto; }
.wbpane-demo .col { flex:0 0 auto; border:1px solid var(--line); background:var(--canvas); border-radius:8px; height:28px; padding:0 9px; cursor:pointer; color:var(--txt-2); font:12px var(--ui); }
.wbpane-demo .col:hover { background:var(--ghost); color:var(--ink); }
.wbpane-demo .wbbody { padding:14px; font-family:var(--ui); }
.wbpane-demo .memrow { border:1px solid var(--line); border-radius:11px; padding:11px 13px; margin-bottom:9px; }
.wbpane-demo .memrow.fresh { background:color-mix(in srgb,var(--rose) 8%,var(--canvas)); border-color:color-mix(in srgb,var(--rose) 30%,var(--line)); }
.wbpane-demo .mt { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink); }
.wbpane-demo .mt b { font-weight:600; }
.wbpane-demo .mtag { margin-left:auto; font-size:10px; border-radius:26px; padding:2px 9px; flex:0 0 auto; }
.wbpane-demo .mtag.us { color:var(--rose); background:color-mix(in srgb,var(--rose) 12%,var(--canvas)); border:1px solid color-mix(in srgb,var(--rose) 28%,var(--line)); }
.wbpane-demo .mtag.fb { color:var(--cyan); background:color-mix(in srgb,var(--cyan) 12%,var(--canvas)); border:1px solid color-mix(in srgb,var(--cyan) 28%,var(--line)); }
.wbpane-demo .ms { margin-top:5px; font-size:12px; line-height:1.5; color:var(--txt-2); }
`;

let demoCssInjected = false;
/** Inject the demo chrome stylesheet once into the Storybook document. */
function ensureDemoCss(): void {
  if (demoCssInjected) return;
  demoCssInjected = true;
  const style = document.createElement('style');
  style.textContent = DEMO_CSS;
  document.head.appendChild(style);
}

/** A realistic workbench header (tabstrip + tool tag + collapse button). */
function headerHtml(): string {
  return `
    <div class="wbhead">
      <div class="tabstrip">
        <button class="tab on"><span class="sg">✦</span> Hero studio <span class="x">✕</span></button>
        <button class="tab"><span class="sg">✦</span> palette <span class="x">✕</span></button>
      </div>
      <div class="spacer"></div>
      <span class="ptag">tool</span>
      <button class="col" title="Collapse">⤡</button>
    </div>`;
}

/** A realistic workbench body (the memory surface from the prototype). */
function bodyHtml(): string {
  return `
    <div class="wbbody">
      <div class="memrow fresh"><div class="mt"><b>palette preference: warm paper</b><span class="mtag us">user</span></div><div class="ms">Prefers paper #faf6f1 canvas + violet accent + single pill CTA for marketing pages.</div></div>
      <div class="memrow"><div class="mt"><b>icon buttons need tooltips</b><span class="mtag fb">feedback</span></div><div class="ms">All icon-only buttons must have data-tooltip + aria-label.</div></div>
      <div class="memrow"><div class="mt"><b>e2e via puppeteer-core</b><span class="mtag fb">feedback</span></div><div class="ms">Use puppeteer-core against the dev-server CDP for browser E2E.</div></div>
    </div>`;
}

/**
 * Build a populated workbench pane mounted in a faux shell row: a chat column on
 * the left, the floating workbench in the middle, and the 48px dock rail on the
 * right — the prototype layout — so the collapse/expand geometry reads in
 * context. The header is composed via `<slicc-workbench-header slot="header">`
 * and the body via `<slicc-workbench-body>`, both BY TAG.
 */
function workbenchPane({ open = true }: WorkbenchPaneArgs): HTMLElement {
  ensureDemoCss();

  const shell = document.createElement('div');
  shell.className = 'wbpane-demo';
  shell.style.cssText =
    'display:flex;align-items:stretch;height:440px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  // Chat column on the left (faux thread), narrows when the workbench opens.
  const chat = document.createElement('div');
  chat.style.cssText = open
    ? 'width:34%;flex:0 0 auto;padding:24px;color:var(--txt-2);font-size:14px;line-height:1.5;transition:width .38s cubic-bezier(.4,0,.2,1);'
    : 'flex:1 1 auto;padding:24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
  chat.innerHTML =
    '<p style="margin:0 0 12px;color:var(--ink);">Make the landing hero feel warmer.</p>' +
    '<p style="margin:0;">Opening the hero studio in the workbench →</p>';

  // The floating workbench pane.
  const pane = document.createElement('slicc-workbench-pane') as SliccWorkbenchPane;
  if (open) pane.setAttribute('open', '');

  const header = document.createElement('slicc-workbench-header');
  header.setAttribute('slot', 'header');
  header.innerHTML = headerHtml();

  const body = document.createElement('slicc-workbench-body');
  body.innerHTML = bodyHtml();

  pane.append(header, body);

  // The always-visible 48px dock rail on the right.
  const dock = document.createElement('div');
  dock.style.cssText =
    'flex:0 0 48px;display:flex;flex-direction:column;align-items:center;gap:8px;' +
    'background:color-mix(in srgb,var(--ctx) 12%,var(--bg));border-left:1px solid var(--line);padding:10px 0;';
  dock.innerHTML =
    '<div style="width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--violet);">✦</div>' +
    '<div style="width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--amber);">✦</div>' +
    '<div style="width:34px;height:34px;border-radius:9px;display:grid;place-items:center;color:var(--txt-2);">＋</div>';

  shell.append(chat, pane, dock);
  return shell;
}

/** Expanded — the workbench is open beside the narrowed chat column. */
export const Open: Story = {
  args: { open: true },
  render: workbenchPane,
};

/**
 * Collapsed — `open` absent: the pane animates to `width: 0; opacity: 0` and the
 * chat column fills the shell. Toggle `open` in the controls to watch it expand.
 */
export const Collapsed: Story = {
  args: { open: false },
  render: workbenchPane,
};
