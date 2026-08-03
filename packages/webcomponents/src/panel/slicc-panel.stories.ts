import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { PanelMeta } from './slicc-panel.js';
import { SliccPanel } from './slicc-panel.js';

/**
 * Stories for `SliccPanel` — the base class every panel extends (chat, both rails, the
 * top strip, each tool panel, each sprinkle).
 *
 * `<slicc-layout>`'s stories cover ARRANGEMENT; these cover one panel's own states, so
 * a change to the shared stylesheet or the visibility polarity is reviewable on its
 * own rather than only as a side effect of some layout.
 */

class StoryPanel extends SliccPanel {
  static readonly panelMeta: PanelMeta = { id: 'demo', title: 'Demo panel' };
}
if (!customElements.get('panel-story-demo')) {
  customElements.define('panel-story-demo', StoryPanel);
}

function body(text: string): HTMLElement {
  const element = document.createElement('div');
  element.style.cssText = [
    'flex:1 1 auto;display:flex;align-items:center;justify-content:center;',
    'min-width:0;min-height:0;box-sizing:border-box;border-radius:8px;',
    'background:color-mix(in srgb, var(--accent, #6366f1) 16%, transparent);',
    'color:var(--ink, #eaf2f6);font:600 13px/1.2 var(--ui, system-ui), sans-serif;',
  ].join('');
  element.textContent = text;
  return element;
}

/** One panel in a fixed box, plus a caption naming the state being shown. */
function specimen(caption: string, configure: (panel: SliccPanel) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;';

  const label = document.createElement('div');
  label.style.cssText =
    'font:500 12px/1.2 var(--ui, system-ui), sans-serif;color:var(--txt-2, #8aa);';
  label.textContent = caption;

  const box = document.createElement('div');
  box.style.cssText = [
    'width:320px;height:140px;display:flex;box-sizing:border-box;',
    'border:1px dashed var(--line);border-radius:12px;padding:6px;',
    'background:var(--canvas);',
  ].join('');

  const panel = document.createElement('panel-story-demo') as SliccPanel;
  panel.append(body('panel body'));
  configure(panel);
  box.append(panel);
  wrap.append(label, box);
  return wrap;
}

function row(...children: HTMLElement[]): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;gap:20px;flex-wrap:wrap;align-items:flex-start;';
  wrap.append(...children);
  return wrap;
}

const meta: Meta = {
  title: 'Panels/SliccPanel',
};
export default meta;
type Story = StoryObj;

/**
 * Visibility, both ways.
 *
 * Panels default to VISIBLE — the opposite polarity from `<slicc-surface>`, which is
 * `display:none` until `[active]`. A panel is placed by the layout rather than being
 * one of a show-one stack, so "visible unless told otherwise" is the useful default.
 * `visible` is the inverse of the native `hidden` attribute, so screen-reader
 * behaviour comes for free instead of needing an `aria-hidden` mirror.
 */
export const Visibility: Story = {
  render: () =>
    row(
      specimen('default — visible', () => {}),
      specimen('visible = false (native [hidden])', (panel) => {
        panel.visible = false;
      })
    ),
};

/**
 * Locked, which blocks USER rearrangement.
 *
 * The lock is a runtime restriction on the person at the keyboard, not on the agent —
 * the agent is restricted separately, by sudo gating on `/etc/slicc/layouts/`. In a
 * layout, a locked panel renders no move grip at all; here the attribute is shown on
 * its own, since the grip belongs to the layout's slot rather than the panel.
 */
export const Locked: Story = {
  render: () =>
    row(
      specimen('unlocked', () => {}),
      specimen('locked', (panel) => {
        panel.locked = true;
      })
    ),
};

/**
 * Presentation: `docked` (a real cell that takes space) versus `floating` (painted
 * over the layout without reflowing it), with the anchor a floating panel honours.
 */
export const Presentation: Story = {
  render: () =>
    row(
      specimen('docked (default)', (panel) => {
        panel.setAttribute('presentation', 'docked');
      }),
      specimen('floating, anchor=right', (panel) => {
        panel.setAttribute('presentation', 'floating');
        panel.setAttribute('anchor', 'right');
      })
    ),
};

/**
 * One class, many ids.
 *
 * `panelId` falls back to the static `panelMeta.id`, so a single subclass can back
 * several panels that differ only by id — which is what lets the webapp wrap every
 * existing shell element in the same `<slicc-panel>` rather than writing a subclass
 * per panel.
 */
export const IdentityFallback: Story = {
  render: () =>
    row(
      specimen('explicit panel-id="files"', (panel) => {
        panel.setAttribute('panel-id', 'files');
      }),
      specimen('no panel-id — falls back to panelMeta.id', () => {})
    ),
};
