import type { Meta, StoryObj } from '@storybook/web-components-vite';
// Earlier-wave siblings composed into the footer (registered on import).
import '../add-menu/slicc-add-menu.js';
import '../primitives/slicc-send-button.js';
import './slicc-composer.js';
import type { SliccComposer } from './slicc-composer.js';

interface ComposerArgs {
  open?: boolean;
}

const meta: Meta<ComposerArgs> = {
  title: 'Composer/Composer',
  component: 'slicc-composer',
  tags: ['autodocs'],
  argTypes: {
    open: {
      control: 'boolean',
      description: 'Narrow-chat variant (hides the meta keyboard hint); mirrors .shell.open',
    },
  },
};

export default meta;
type Story = StoryObj<ComposerArgs>;

/** The brain/thinking glyph from the prototype's `.tsel` thinking control. */
const BRAIN_SVG =
  '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" style="color:var(--violet);vertical-align:-2px;"><path d="M12 18V5"/><path d="M15 13a4.17 4.17 0 0 1-3-4 4.17 4.17 0 0 1-3 4"/><path d="M17.598 6.5A3 3 0 1 0 12 5a3 3 0 1 0-5.598 1.5"/><path d="M17.997 5.125a4 4 0 0 1 2.526 5.77"/><path d="M18 18a4 4 0 0 0 2-7.464"/><path d="M19.967 17.483A4 4 0 1 1 12 18a4 4 0 1 1-7.967-.517"/><path d="M6 18a4 4 0 0 1-2-7.464"/><path d="M6.003 5.125a4 4 0 0 0-2.526 5.77"/></svg>';

/**
 * Prototype footer chrome (`.inputcard` / `.toolbar` / `.meta` / `.ctl`) that
 * lives in `proto/StellarRubySwift.html` but NOT in this library — inlined here
 * as demo presentation so the container is reviewable with its real contents.
 * Scoped to the story wrapper class to avoid leaking into the docs page.
 */
const DEMO_CSS = `
.composer-demo .inputcard { border:1px solid var(--line); border-radius:16px; background:var(--canvas); padding:14px 12px 10px 16px; display:flex; flex-direction:column; gap:9px; box-shadow:rgba(10,10,10,.05) 0 2px 12px -2px; transition:.14s; }
.composer-demo .inputcard:focus-within { border-color:var(--violet); box-shadow:0 0 0 3px color-mix(in srgb,var(--violet) 15%,transparent),rgba(10,10,10,.05) 0 2px 12px -2px; }
.composer-demo .ta { border:none; outline:none; resize:none; background:transparent; font:inherit; font-family:var(--ui); font-size:16px; line-height:1.5; color:var(--ink); min-height:28px; max-height:140px; width:100%; box-sizing:border-box; }
.composer-demo .toolbar { display:flex; align-items:center; gap:7px; }
.composer-demo .toolbar .spacer { flex:1; }
.composer-demo .meta { display:flex; align-items:center; gap:8px; max-width:680px; margin:11px auto 0; }
.composer-demo .meta .mspacer { flex:1; }
.composer-demo .ctl { height:30px; border:1px solid var(--line); border-radius:8px; background:var(--canvas); color:var(--ink); font:inherit; font-family:var(--ui); font-size:12.5px; font-weight:500; padding:0 9px; display:inline-flex; align-items:center; gap:7px; cursor:pointer; white-space:nowrap; flex:0 0 auto; }
.composer-demo .ctl:hover { background:var(--ghost); }
.composer-demo .ctl.tsel.x { border-color:color-mix(in srgb,var(--violet) 35%,var(--line)); }
.composer-demo .ctl .ic { background:var(--rainbow); -webkit-background-clip:text; background-clip:text; color:transparent; font-weight:700; }
.composer-demo .ctl .cx { color:var(--txt-3); font-size:10px; }
.composer-demo .meta .hint { font-size:11px; color:var(--txt-3); display:inline-flex; align-items:center; gap:7px; }
.composer-demo .meta .hint .kbd { font-family:var(--ui); border:1px solid var(--line); border-radius:5px; padding:1px 6px; color:var(--txt-2); }
.composer-demo .meta .hint .sep { width:3px; height:3px; border-radius:50%; background:var(--line); }
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

/** Build the populated `.composer-inner` contents (input card + meta row). */
function footerContents(): string {
  return `
    <div class="inputcard">
      <textarea class="ta" rows="1" placeholder="Ask sliccy, or describe a change…"></textarea>
      <div class="toolbar">
        <slicc-add-menu></slicc-add-menu>
        <div class="spacer"></div>
        <slicc-send-button></slicc-send-button>
      </div>
    </div>
    <div class="meta">
      <button class="ctl msel"><span class="ic">✦</span> Opus 4.8 <span class="cx">▾</span></button>
      <button class="ctl tsel x">${BRAIN_SVG} bombastica <span class="cx">▾</span></button>
      <div class="mspacer"></div>
      <span class="hint slicc-composer__hint" data-composer-hint><span class="kbd">⏎</span> send <span class="sep"></span> <span class="kbd">⇧⏎</span> newline <span class="sep"></span> review before shipping</span>
    </div>`;
}

/**
 * Build a populated composer mounted in a column shell, so the frosted footer
 * band reads against a chat-thread-like surface above it (the prototype layout).
 */
function composer({ open }: ComposerArgs): HTMLElement {
  ensureDemoCss();

  // A chat-column shell: faux thread above, composer footer pinned below.
  const shell = document.createElement('div');
  shell.className = 'composer-demo';
  shell.style.cssText =
    'display:flex;flex-direction:column;height:420px;width:100%;background:var(--bg);overflow:hidden;font-family:var(--ui);';

  const thread = document.createElement('div');
  thread.style.cssText =
    'flex:1 1 auto;overflow:hidden;padding:28px 24px;color:var(--txt-2);font-size:14px;line-height:1.5;';
  thread.innerHTML =
    '<p style="margin:0 0 12px;color:var(--ink);">Make the landing hero feel warmer.</p>' +
    '<p style="margin:0 0 12px;">On it — auditing the cold hero, then redesigning in a live sprinkle. I will verify before/after in the browser and open a PR.</p>' +
    '<p style="margin:0;">The composer footer below frosts over this thread; opening the add-menu pops a results panel <b>up and over</b> these lines (z-index:2) without growing the band.</p>';

  const el = document.createElement('slicc-composer') as SliccComposer;
  if (open) el.setAttribute('open', '');
  el.innerHTML = footerContents();

  shell.append(thread, el);
  return shell;
}

/** Default — full-width chat: input card + meta row with the keyboard hint visible. */
export const Default: Story = {
  args: {},
  render: composer,
};

/**
 * Narrow / shell-open — the 34% chat pane: the meta keyboard hint is hidden,
 * keeping just model + thinking. Mirrors `.shell.open .meta .hint`.
 */
export const Narrow: Story = {
  args: { open: true },
  render: composer,
};
