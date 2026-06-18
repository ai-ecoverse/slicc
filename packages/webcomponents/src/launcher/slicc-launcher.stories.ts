import type { Meta, StoryObj } from '@storybook/web-components-vite';
import './slicc-launcher.js';

const meta: Meta = {
  title: 'Launcher/Launcher',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
};
export default meta;
type Story = StoryObj;

/** A synthetic "leader app" rendered into a Blob URL so the iframe loads without
 *  a live SLICC running — the story still demonstrates the full open/close
 *  shell, draggable button, and double-click → focus event semantics. */
function makeFakeAppUrl(label: string, hue: number): string {
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{margin:0;height:100%;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1a1a1a;background:hsl(${hue},60%,96%);}
    .hero{padding:24px;}
    h1{margin:0 0 8px;font-size:18px;color:hsl(${hue},45%,32%);}
    p{margin:0 0 12px;color:#555;}
    .row{display:flex;gap:8px;flex-wrap:wrap;}
    .pill{padding:4px 9px;border-radius:999px;background:hsl(${hue},60%,90%);font-size:12px;color:hsl(${hue},45%,28%);}
  </style></head><body><div class="hero">
    <h1>${label}</h1>
    <p>Synthetic SLICC app loaded into the launcher iframe.</p>
    <div class="row"><span class="pill">scoop: cone</span><span class="pill">model: opus-4-6</span></div>
  </div></body></html>`;
  return URL.createObjectURL(new Blob([html], { type: 'text/html' }));
}

function host(setup: (el: HTMLElement) => void): HTMLElement {
  const wrap = document.createElement('div');
  wrap.style.cssText =
    'min-height:100vh;background:linear-gradient(120deg,#fafafa,#eef0f4);position:relative;font-family:-apple-system,BlinkMacSystemFont,sans-serif;color:#1a1a1a;';
  const intro = document.createElement('div');
  intro.style.cssText = 'padding:32px;max-width:560px;';
  const h1 = document.createElement('h2');
  h1.textContent = 'slicc-launcher';
  h1.style.cssText = 'margin:0 0 8px;font-size:18px;';
  const p = document.createElement('p');
  p.style.cssText = 'margin:0 0 16px;color:#555;font-size:13px;line-height:1.5;';
  p.textContent =
    'Click the floating button to toggle the sidebar. Double-click it to fire slicc-launcher-focus (the leader uses this to surface its tab). Drag the button to snap it to a different corner or edge — the choice persists across reloads.';
  const log = document.createElement('pre');
  log.style.cssText =
    'background:#1a1a1a;color:#9be7c4;padding:10px 12px;border-radius:8px;font:12px/1.4 ui-monospace,monospace;min-height:80px;max-height:200px;overflow:auto;';
  log.textContent = '// events appear here\n';
  intro.append(h1, p, log);
  wrap.append(intro);
  const launcher = document.createElement('slicc-launcher');
  for (const name of ['slicc-launcher-toggle', 'slicc-launcher-focus', 'slicc-launcher-move']) {
    launcher.addEventListener(name, (e) => {
      const detail = (e as CustomEvent<unknown>).detail;
      log.textContent += `${name} ${detail ? JSON.stringify(detail) : ''}\n`;
      log.scrollTop = log.scrollHeight;
    });
  }
  setup(launcher);
  wrap.append(launcher);
  return wrap;
}

/** Default launcher mounted in the top-right corner, sidebar closed. */
export const Closed: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 210));
    }),
};

/** Same shell with the sidebar pre-opened so the iframe is visible. */
export const Open: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 210));
      el.setAttribute('open', '');
    }),
};

/** Empty app-url shows the placeholder copy instead of an iframe. */
export const EmptyAppUrl: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('open', '');
    }),
};

/** Persisted bottom-left position — what users see after they drag the button. */
export const BottomLeft: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 320));
      el.setAttribute('corner', 'bottom-left');
    }),
};

/** Edge midpoints snap to TAB mode — the launcher widens, shows the "SLICC"
 *  label, and rounds only the two corners NOT touching the viewport edge. */
export const TabTop: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 200));
      el.setAttribute('corner', 'top');
    }),
};

export const TabBottom: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 200));
      el.setAttribute('corner', 'bottom');
    }),
};

export const TabLeft: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 200));
      el.setAttribute('corner', 'left');
    }),
};

export const TabRight: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 200));
      el.setAttribute('corner', 'right');
    }),
};

/** Open tab — confirms the sidebar slides in correctly when the launcher is
 *  rendered as a tab against an edge. */
export const TabLeftOpen: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 280));
      el.setAttribute('corner', 'left');
      el.setAttribute('open', '');
    }),
};

/** Dragging state — the host carries the [dragging] attribute so the sidebar
 *  + backdrop are hidden (no iframe flicker while the user moves the button). */
export const Dragging: Story = {
  render: () =>
    host((el) => {
      el.setAttribute('app-url', makeFakeAppUrl('SLICC leader', 210));
      el.setAttribute('open', '');
      el.setAttribute('dragging', '');
    }),
};
