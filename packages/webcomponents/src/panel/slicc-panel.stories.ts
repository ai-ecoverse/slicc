import type { Meta, StoryObj } from '@storybook/web-components-vite';
import type { PanelMeta } from './slicc-panel.js';
import { SliccPanel } from './slicc-panel.js';

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

export const Visibility: Story = {
  render: () =>
    row(
      specimen('default — visible', () => {}),
      specimen('visible = false (native [hidden])', (panel) => {
        panel.visible = false;
      })
    ),
};

export const Locked: Story = {
  render: () =>
    row(
      specimen('unlocked', () => {}),
      specimen('locked', (panel) => {
        panel.locked = true;
      })
    ),
};

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

export const IdentityFallback: Story = {
  render: () =>
    row(
      specimen('explicit panel-id="files"', (panel) => {
        panel.setAttribute('panel-id', 'files');
      }),
      specimen('no panel-id — falls back to panelMeta.id', () => {})
    ),
};
