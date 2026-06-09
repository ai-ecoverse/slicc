import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Earlier-wave siblings composed into the header (registered on import). The
// `slicc-tab-bar` is built in this wave, so it is composed by tag only (no import)
// and stood in here with the prototype's `.tabstrip` / `.tab` chrome.
import '../primitives/slicc-collapse-btn.js';
import '../primitives/slicc-pane-tag.js';
import './slicc-workbench-header.js';
import type { SliccWorkbenchHeader } from './slicc-workbench-header.js';

interface HeaderArgs {
  kind?: 'tool' | 'sprinkle' | 'none';
  tabs?: 'two' | 'overflow';
}

const meta: Meta<HeaderArgs> = {
  title: 'Workbench/WorkbenchHeader',
  component: 'slicc-workbench-header',
  tags: ['autodocs'],
  argTypes: {
    kind: {
      control: 'inline-radio',
      options: ['tool', 'sprinkle', 'none'],
      description: 'Forwarded to the composed <slicc-pane-tag> kind badge',
    },
    tabs: {
      control: 'inline-radio',
      options: ['two', 'overflow'],
      description: 'Two tabs, or many tabs to demonstrate the scrolling tab bar',
    },
  },
};

export default meta;
type Story = StoryObj<HeaderArgs>;

/**
 * Prototype tab-bar chrome (`.tabstrip` / `.tab` / `.tab.sp`) that lives in
 * `proto/StellarRubySwift.html` but NOT (yet) in this library — `slicc-tab-bar`
 * lands this wave and is composed by tag. Inlined here as demo presentation so
 * the header is reviewable with a realistic, populated tab bar. Scoped to the
 * story wrapper class to avoid leaking into the docs page.
 */
const DEMO_CSS = `
.wbhead-demo slicc-tab-bar { display:flex; align-items:center; gap:4px; min-width:0; overflow-x:auto; }
.wbhead-demo .tab { display:inline-flex; align-items:center; gap:7px; font-family:var(--ui); font-size:12px; color:var(--txt-2); background:transparent; border:1px solid transparent; border-radius:8px; padding:6px 10px; cursor:pointer; white-space:nowrap; flex:0 0 auto; }
.wbhead-demo .tab:hover { background:var(--ghost); color:var(--ink); }
.wbhead-demo .tab.on { color:var(--ink); background:var(--ghost); }
.wbhead-demo .tab.sp { color:var(--ink); background:var(--canvas); border-color:var(--line); }
.wbhead-demo .tab.sp.on { background:color-mix(in srgb,var(--violet) 9%,#fff); border-color:color-mix(in srgb,var(--violet) 34%,var(--line)); color:var(--ink); }
.dark .wbhead-demo .tab.sp.on { background:color-mix(in srgb,var(--violet) 18%,var(--canvas)); border-color:color-mix(in srgb,var(--violet) 40%,var(--line)); }
.wbhead-demo .tab.sp .sg { display:inline-grid; place-items:center; width:14px; height:14px; border-radius:4px; font-size:8px; color:#fff; background:var(--rainbow); }
.wbhead-demo .tab .x { margin-left:3px; width:15px; height:15px; border-radius:4px; display:grid; place-items:center; font-size:10px; color:var(--txt-3); }
.wbhead-demo .tab .x:hover { background:var(--line); color:var(--ink); }
`;

let demoCssInjected = false;
/** Inject the demo tab-bar chrome stylesheet once into the Storybook document. */
function ensureDemoCss(): void {
  if (demoCssInjected) return;
  demoCssInjected = true;
  const style = document.createElement('style');
  style.textContent = DEMO_CSS;
  document.head.appendChild(style);
}

/** A single sprinkle tab (`.tab.sp`) with the ✦ chip and close affordance. */
function tab(label: string, on = false): string {
  return `<button class="tab sp${on ? ' on' : ''}" type="button"><span class="sg">✦</span> ${label} <span class="x">✕</span></button>`;
}

/** Build the composed tab bar (by tag) with two or many tabs. */
function tabBar(many: boolean): string {
  const labels = many
    ? ['Hero studio', 'palette', 'tokens.css', 'nav.tsx', 'preview', 'diff', 'tests']
    : ['Hero studio', 'palette'];
  const inner = labels.map((l, i) => tab(l, i === 0)).join('');
  return `<slicc-tab-bar>${inner}</slicc-tab-bar>`;
}

/**
 * Build a populated workbench header mounted in a narrow column shell, so the
 * strip + bottom border read against a workbench body below it (prototype layout).
 */
function header({ kind = 'tool', tabs = 'two' }: HeaderArgs): HTMLElement {
  ensureDemoCss();

  const shell = document.createElement('div');
  shell.className = 'wbhead-demo';
  shell.style.cssText =
    'width:560px;max-width:100%;background:var(--canvas);border:1px solid var(--line);border-radius:12px;overflow:hidden;font-family:var(--ui);';

  const el = document.createElement('slicc-workbench-header') as SliccWorkbenchHeader;
  if (kind !== 'none') el.setAttribute('kind', kind);
  el.innerHTML = `${tabBar(tabs === 'overflow')}<slicc-pane-tag></slicc-pane-tag><slicc-collapse-btn></slicc-collapse-btn>`;

  // A faux workbench body below the header so the bottom border reads.
  const body = document.createElement('div');
  body.style.cssText =
    'height:160px;padding:18px 16px;color:var(--txt-2);font-size:13px;line-height:1.6;background:var(--canvas);';
  body.innerHTML =
    '<div style="color:var(--ink);margin-bottom:6px;">workspace/hero.css · edited by designer</div>' +
    'The tab bar scrolls inside the clipped strip; the spacer pushes the kind badge + collapse button to the right.';

  shell.append(el, body);
  return shell;
}

/** Default — a `tool` pane: two tabs, the violet "tool" badge, collapse button. */
export const Tool: Story = {
  args: { kind: 'tool', tabs: 'two' },
  render: header,
};

/** A `sprinkle` pane: the badge reads "sprinkle". */
export const Sprinkle: Story = {
  args: { kind: 'sprinkle', tabs: 'two' },
  render: header,
};

/** No kind: the `<slicc-pane-tag>` badge is hidden, leaving tab bar + collapse. */
export const NoKind: Story = {
  args: { kind: 'none', tabs: 'two' },
  render: header,
};

/**
 * Overflowing tab bar — many tabs scroll horizontally inside the clipped strip
 * while the spacer keeps the badge + collapse button pinned right.
 */
export const Overflow: Story = {
  args: { kind: 'tool', tabs: 'overflow' },
  render: header,
};
