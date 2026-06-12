import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-workbench-body.js';
import type { SliccWorkbenchBody } from './slicc-workbench-body.js';

interface WorkbenchBodyArgs {
  /** Which surface starts active. */
  active?: string;
}

const meta: Meta<WorkbenchBodyArgs> = {
  title: 'Workbench/Workbench Body',
  component: 'slicc-workbench-body',
  tags: ['autodocs'],
  argTypes: {
    active: {
      control: 'select',
      options: ['files', 'term', 'memory', 'browser'],
      description: 'The active surface id (the prototype `.surface.on`)',
    },
  },
};

export default meta;
type Story = StoryObj<WorkbenchBodyArgs>;

/**
 * Demo surface chrome lifted from the prototype (`proto/StellarRubySwift.html`
 * `.surface` / `.files` / `.tree` / `.fileview` / `.term` / `.membody` / `.bbar`)
 * — these surfaces live in the prototype but NOT (yet) in this library, so they
 * are inlined here as demo presentation so the container is reviewable with real
 * contents. The fallback `.surface[data-s]` rules mirror the body's own show-one
 * behavior in case the sibling `<slicc-surface>` element is not registered in the
 * Storybook bundle. Scoped to the story wrapper class to avoid leaking.
 */
const DEMO_CSS = `
.wbbody-demo { display:flex; flex-direction:column; height:460px; width:100%; background:var(--canvas); border:1px solid var(--line); border-radius:14px; overflow:hidden; font-family:var(--ui); box-shadow:rgba(10,10,10,.10) 0 14px 36px -12px, rgba(10,10,10,.05) 0 4px 10px -4px; }
.wbbody-demo .wbhead { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:8px 12px; border-bottom:1px solid var(--line); font-size:12px; color:var(--txt-2); }
.wbbody-demo .wbhead .tab { display:inline-flex; align-items:center; gap:5px; height:26px; padding:0 10px; border-radius:7px; cursor:pointer; color:var(--txt-2); }
.wbbody-demo .wbhead .tab.on { background:color-mix(in srgb,var(--violet) 10%,#fff); color:var(--violet); }
.wbbody-demo .wbhead .spacer { flex:1; }
.wbbody-demo .wbhead .ptag { font-size:10px; color:var(--violet); background:color-mix(in srgb,var(--violet) 12%,#fff); border:1px solid color-mix(in srgb,var(--violet) 30%,var(--line)); border-radius:26px; padding:2px 9px; }

/* Fallback surface chrome (mirrors the body's own show-one rules so the demo
   reads even before <slicc-surface> registers). Keyed off surface-id so it holds
   regardless of when the sibling mirrors surface-id → data-s. */
.wbbody-demo slicc-surface { position:absolute; inset:0; display:none; box-sizing:border-box; }
.wbbody-demo slicc-surface.slicc-wbbody__active { display:flex; }
.wbbody-demo slicc-surface[surface-id="memory"].slicc-wbbody__active { display:block; }

/* files */
.wbbody-demo .tree { width:190px; flex:0 0 auto; border-right:1px solid var(--line); overflow:auto; padding:10px 8px; font-size:12px; }
.wbbody-demo .tree .grp { color:var(--txt-3); padding:5px 8px 3px; }
.wbbody-demo .tree .f { display:flex; align-items:center; gap:7px; padding:4px 8px; border-radius:7px; color:var(--ink); cursor:pointer; }
.wbbody-demo .tree .f:hover { background:var(--ghost); }
.wbbody-demo .tree .f.on { background:color-mix(in srgb,var(--violet) 10%,#fff); color:var(--violet); }
.wbbody-demo .fileview { flex:1; overflow:auto; padding:16px 18px; font-family:var(--mono); font-size:12.5px; line-height:1.7; color:var(--ink); white-space:pre-wrap; }
.wbbody-demo .fileview .fh { color:var(--txt-3); font-family:var(--ui); font-size:11px; margin-bottom:10px; }
.wbbody-demo .fileview .c { color:var(--txt-3); } .wbbody-demo .fileview .k { color:var(--violet); } .wbbody-demo .fileview .s { color:var(--rose); }

/* terminal — the one dark surface */
.wbbody-demo .term { flex:1; background:#0c0c0e; color:#e7e7ea; font-family:var(--mono); font-size:12.5px; line-height:1.75; padding:16px 18px; overflow:auto; white-space:pre-wrap; }
.wbbody-demo .term .p { color:var(--rose); } .wbbody-demo .term .mut { color:#8a8a93; }
.wbbody-demo .term .cur { display:inline-block; width:7px; height:14px; background:#e7e7ea; vertical-align:-2px; }

/* memory */
.wbbody-demo .membody { padding:14px 16px; overflow:auto; }
.wbbody-demo .memrow { border:1px solid var(--line); border-radius:11px; padding:10px 12px; margin-bottom:9px; background:var(--canvas); }
.wbbody-demo .memrow.fresh { border-color:color-mix(in srgb,var(--violet) 35%,var(--line)); background:color-mix(in srgb,var(--violet) 6%,var(--canvas)); }
.wbbody-demo .memrow .mt { display:flex; align-items:center; gap:8px; font-size:13px; color:var(--ink); }
.wbbody-demo .memrow .mt .mtag { margin-left:auto; font-size:10px; padding:1px 7px; border-radius:20px; }
.wbbody-demo .memrow .mtag.us { background:color-mix(in srgb,var(--cyan) 16%,#fff); color:var(--cyan); }
.wbbody-demo .memrow .mtag.fb { background:color-mix(in srgb,var(--amber) 18%,#fff); color:var(--amber); }
.wbbody-demo .memrow .mtag.pj { background:color-mix(in srgb,var(--violet) 14%,#fff); color:var(--violet); }
.wbbody-demo .memrow .ms { font-size:12px; color:var(--txt-2); margin-top:5px; line-height:1.5; }

/* browser */
.wbbody-demo slicc-surface[surface-id="browser"].slicc-wbbody__active { flex-direction:column; background:#fafafa; }
.wbbody-demo .bbar { display:flex; align-items:center; gap:7px; padding:9px 14px; border-bottom:1px solid var(--line); font-size:11px; color:var(--txt-3); }
.wbbody-demo .bbar .bd { width:11px; height:11px; border-radius:50%; }
.wbbody-demo .bbar .bd.r { background:#ff5f57; } .wbbody-demo .bbar .bd.y { background:#febc2e; } .wbbody-demo .bbar .bd.g { background:#28c840; }
.wbbody-demo .bbar .burl { margin-left:8px; }
.wbbody-demo .bbody { flex:1; display:grid; place-items:center; color:var(--txt-3); font-size:13px; }
`;

let demoCssInjected = false;
/** Inject the demo surface chrome once into the Storybook document. */
function ensureDemoCss(): void {
  if (demoCssInjected) return;
  demoCssInjected = true;
  const style = document.createElement('style');
  style.textContent = DEMO_CSS;
  document.head.appendChild(style);
}

/**
 * Build the four populated `<slicc-surface>` demo panels (prototype contents).
 * Identity is the canonical `surface-id` (mirrored to `data-s` by the sibling);
 * `layout` drives the sibling's reveal mode — memory is a `block` scroll list,
 * browser is a `column` (bar over body) — matching the prototype variant rules.
 */
function surfacesHtml(): string {
  return `
    <slicc-surface surface-id="files">
      <div class="tree">
        <div class="grp">workspace/</div>
        <div class="f">hero.tsx</div><div class="f on">hero.css</div><div class="f">tokens.css</div><div class="f">nav.tsx</div>
        <div class="grp" style="margin-top:8px">skills/</div>
        <div class="f">sprinkles/</div><div class="f">.mcp/</div>
      </div>
      <div class="fileview"><div class="fh">workspace/hero.css · edited by designer</div><span class="c">/* warm the landing hero */</span>
.hero {
  <span class="k">background</span>: <span class="s">#faf6f1</span>;
  <span class="k">padding</span>: <span class="s">96px 8vw</span>;
}</div>
    </slicc-surface>

    <slicc-surface surface-id="term">
      <div class="term"><span class="p">researcher /scoops/researcher ❯</span> grep -rn "hero" src/ | wc -l
<span class="mut">17 matches · 4 files</span>
<span class="p">researcher /scoops/researcher ❯</span> cat src/hero.tsx
<span class="mut">… dark canvas · mono headline · 6-button row …</span>
<span class="p">researcher /scoops/researcher ❯</span> <span class="cur"></span></div>
    </slicc-surface>

    <slicc-surface surface-id="memory" layout="block">
      <div class="membody">
        <div class="memrow fresh"><div class="mt"><b>palette preference: warm paper</b><span class="mtag us">user</span></div><div class="ms">Prefers paper #faf6f1 canvas + violet accent + single pill CTA for marketing pages.</div></div>
        <div class="memrow"><div class="mt"><b>icon buttons need tooltips</b><span class="mtag fb">feedback</span></div><div class="ms">All icon-only buttons must have data-tooltip + aria-label.</div></div>
        <div class="memrow"><div class="mt"><b>UI redesign exploration</b><span class="mtag pj">project</span></div><div class="ms">3 axes — structure × palette × style; mockups in slicc-styles/.</div></div>
      </div>
    </slicc-surface>

    <slicc-surface surface-id="browser" layout="column">
      <div class="bbar"><span class="bd r"></span><span class="bd y"></span><span class="bd g"></span><span class="burl">https://acme.com  ·  live page via CDP</span></div>
      <div class="bbody">before / after compare via CDP screenshots</div>
    </slicc-surface>`;
}

/** Tab labels for the demo head, keyed by surface id. */
const TABS: Array<[string, string]> = [
  ['files', 'Files'],
  ['term', 'Terminal'],
  ['memory', 'Memory'],
  ['browser', 'Browser'],
];

/**
 * Build a populated workbench body inside a workbench-pane shell (head tab strip
 * + body), so the surface stack reads in its real prototype frame. The head tabs
 * drive `selectSurface(id)` so the show-one swap is interactive.
 */
function workbenchBody({ active = 'memory' }: WorkbenchBodyArgs): HTMLElement {
  ensureDemoCss();

  const shell = document.createElement('div');
  shell.className = 'wbbody-demo';

  const head = document.createElement('div');
  head.className = 'wbhead';
  head.innerHTML =
    TABS.map(
      ([id, label]) =>
        `<span class="tab ${id === active ? 'on' : ''}" data-t="${id}">${label}</span>`
    ).join('') + '<span class="spacer"></span><span class="ptag">tool</span>';

  const body = document.createElement('slicc-workbench-body') as SliccWorkbenchBody;
  body.innerHTML = surfacesHtml();
  body.active = active;

  // Wire the demo tabs to the body's show-one API.
  head.addEventListener('click', (ev) => {
    const tab = (ev.target as HTMLElement).closest<HTMLElement>('.tab[data-t]');
    if (!tab?.dataset.t) return;
    body.selectSurface(tab.dataset.t);
    for (const t of head.querySelectorAll('.tab')) {
      t.classList.toggle('on', t === tab);
    }
  });

  shell.append(head, body);
  return shell;
}

/** Default — the Memory surface active (the prototype's pinned default). */
export const Default: Story = {
  args: { active: 'memory' },
  render: workbenchBody,
};

/** Files surface — the VFS tree + file preview, active. */
export const Files: Story = {
  args: { active: 'files' },
  render: workbenchBody,
};

/** Terminal surface — the one dark surface (shell), active. */
export const Terminal: Story = {
  args: { active: 'term' },
  render: workbenchBody,
};

/** Browser surface — the CDP live-page / before-after compare, active. */
export const Browser: Story = {
  args: { active: 'browser' },
  render: workbenchBody,
};
