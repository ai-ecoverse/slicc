import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  decideComputerFrameMode,
  SliccBashRendererComputer,
} from '../../src/computer/slicc-bash-renderer-computer.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

const FRAME =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAEUlEQVR42mP8z8BQz0AEYBxVSFQ9iV0AAAAASUVORK5CYII=';

function mount(setup?: (el: SliccBashRendererComputer) => void): SliccBashRendererComputer {
  const el = document.createElement('slicc-bash-renderer-computer');
  setup?.(el);
  document.body.appendChild(el);
  return el;
}

describe('decideComputerFrameMode', () => {
  it('is live only for the newest call on a live computer', () => {
    expect(
      decideComputerFrameMode({
        computerLive: true,
        newestToolCallId: 'call-2',
        toolCallId: 'call-2',
        hasFrame: true,
      })
    ).toBe('live');
  });

  it('freezes when a newer call supersedes this one', () => {
    expect(
      decideComputerFrameMode({
        computerLive: true,
        newestToolCallId: 'call-2',
        toolCallId: 'call-1',
        hasFrame: true,
      })
    ).toBe('frozen');
  });

  it('freezes when the computer disconnects even if this is the newest call', () => {
    expect(
      decideComputerFrameMode({
        computerLive: false,
        newestToolCallId: 'call-1',
        toolCallId: 'call-1',
        hasFrame: true,
      })
    ).toBe('frozen');
  });

  it('shows no frame when frozen with nothing to load', () => {
    expect(
      decideComputerFrameMode({
        computerLive: false,
        newestToolCallId: 'call-1',
        toolCallId: 'call-1',
        hasFrame: false,
      })
    ).toBe('none');
  });
});

describe('slicc-bash-renderer-computer', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-bash-renderer-computer')).toBe(SliccBashRendererComputer);
  });

  it('keeps wcmsg-bash on the host so action-row progress chrome still matches', () => {
    const el = mount();
    expect(el.classList.contains('wcmsg-bash')).toBe(true);
  });

  it('reflects command, toolCallId, and done', () => {
    const el = mount((r) => {
      r.command = 'computer screenshot';
      r.toolCallId = 'tc-1';
      r.done = true;
      r.output = 'screen: /tmp/a.jpg';
    });
    expect(el.getAttribute('command')).toBe('computer screenshot');
    expect(el.getAttribute('tool-call-id')).toBe('tc-1');
    expect(el.hasAttribute('done')).toBe(true);
    expect(el.shadowRoot?.querySelector('.cmd')?.textContent).toBe('$ computer screenshot');
    expect(el.shadowRoot?.querySelector('.out')?.textContent).toBe('screen: /tmp/a.jpg');
  });

  it('renders a live frame with a live pill and emits computer-frame-click', () => {
    const el = mount((r) => {
      r.command = 'computer watch';
      r.frameMode = 'live';
      r.frameSrc = FRAME;
    });
    expect(el.live).toBe(true);
    expect(el.hasAttribute('live')).toBe(true);
    const frame = el.shadowRoot?.querySelector('.frame') as HTMLElement;
    expect(frame.hidden).toBe(false);
    expect(frame.querySelector('.pill')?.textContent).toBe('live');
    const seen: string[] = [];
    el.addEventListener('computer-frame-click', (e) =>
      seen.push((e as CustomEvent<{ src: string }>).detail.src)
    );
    frame.click();
    expect(seen).toEqual([FRAME]);
  });

  it('renders a frozen frame and hides the frame when mode is none', () => {
    const el = mount((r) => {
      r.frameMode = 'frozen';
      r.frameSrc = FRAME;
    });
    expect(el.shadowRoot?.querySelector('.pill.frozen')?.textContent).toBe('frozen');
    el.frameMode = 'none';
    el.frameSrc = null;
    expect((el.shadowRoot?.querySelector('.frame') as HTMLElement).hidden).toBe(true);
  });

  it('emits bind on connect and unbind on disconnect', () => {
    const binds: string[] = [];
    const unbinds: string[] = [];
    const el = document.createElement('slicc-bash-renderer-computer');
    el.toolCallId = 'tc-9';
    el.command = 'computer ls';
    el.addEventListener('computer-row-bind', (e) =>
      binds.push((e as CustomEvent<{ toolCallId: string }>).detail.toolCallId)
    );
    el.addEventListener('computer-row-unbind', (e) =>
      unbinds.push((e as CustomEvent<{ toolCallId: string }>).detail.toolCallId)
    );
    document.body.appendChild(el);
    expect(binds).toEqual(['tc-9']);
    el.remove();
    expect(unbinds).toEqual(['tc-9']);
  });
});
