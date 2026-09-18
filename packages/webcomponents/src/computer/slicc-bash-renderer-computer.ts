import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';

/**
 * How the frame area should render for one bash-row invocation.
 *
 * - `live`: this tool-call is the newest `computer` invocation for a live
 *   computer AND a pushed `computer-frame` is on screen.
 * - `frozen`: a still from `screen: <path>` / an `<img:>` marker, or a
 *   pushed frame kept after the row is no longer live.
 * - `none`: no frame to show.
 */
export type ComputerFrameMode = 'live' | 'frozen' | 'none';

export interface ComputerFrameModeInput {
  computerLive: boolean;
  newestToolCallId: string | null;
  toolCallId: string;
  hasFrame: boolean;
  /** True only when the store holds a kernel-pushed frame for this computer. */
  hasPushedFrame: boolean;
}

/**
 * Newest-call rule: LIVE only when this row is the newest invocation for a
 * live computer and a pushed frame is displayed. A frozen still (or no
 * frame yet) must not show the live badge. A superseded or disconnected
 * row freezes when it has any still.
 */
export function decideComputerFrameMode(input: ComputerFrameModeInput): ComputerFrameMode {
  if (input.computerLive && input.newestToolCallId === input.toolCallId && input.hasPushedFrame) {
    return 'live';
  }
  if (input.hasFrame) return 'frozen';
  return 'none';
}

/** Host-injected ANSI renderer. Defaults to a text node so the component
 *  never duplicates webapp `ansiToDom`. */
export type ComputerOutputRenderer = (target: HTMLElement, text: string) => void;

let outputRenderer: ComputerOutputRenderer = (target, text) => {
  target.textContent = text;
};

/** The page host assigns `ansiToDom` here so the renderer does not import webapp. */
export function setComputerOutputRenderer(fn: ComputerOutputRenderer): void {
  outputRenderer = fn;
}

const STYLE = `
:host { display: block; white-space: pre-wrap; font-family: var(--mono, ui-monospace, monospace); }
.cmd { color: #9ad17e; }
.out { color: #f2f2f2; }
.frame {
  position: relative; display: block; margin: 8px 0 0;
  max-width: 100%; cursor: zoom-in; border-radius: 6px; overflow: hidden;
  border: 1px solid #2a2a2a; background: #0c0c0e;
}
.frame img {
  display: block; width: 100%; max-height: 320px; object-fit: contain;
  background: #0c0c0e;
}
.pill {
  position: absolute; top: 8px; left: 8px;
  display: inline-flex; align-items: center; gap: 5px;
  height: 18px; padding: 0 7px; border-radius: 999px;
  font: 600 10px/1 var(--ui, system-ui, sans-serif);
  letter-spacing: 0.04em; text-transform: uppercase;
  color: #fff; background: rgba(0,0,0,.55);
}
.pill .dot {
  width: 6px; height: 6px; border-radius: 50%; background: #22c55e; flex: 0 0 auto;
}
.pill.frozen .dot { background: #a3a3a3; }
`;
const SHEET = sheet(STYLE);

/**
 * `<slicc-bash-renderer-computer>` — bash-row body for the `computer` program.
 * Shows `$ command`, ANSI/text output, and one live or frozen frame. The host
 * (`wc-computers.ts`) decides live vs frozen and feeds `frameSrc`.
 *
 * @attr command - the bash command line
 * @attr tool-call-id - the originating tool call
 * @attr computer-id - resolved target (`target: <id>` / `-c`)
 * @attr done - reflected when the tool result has arrived
 * @attr live - reflected when the frame is the live stream
 * @fires computer-frame-click - `{ src }` when the frame is clicked
 * @fires computer-row-bind - `{ toolCallId, command, output, done, computerId }` on connect
 * @fires computer-row-unbind - `{ toolCallId }` on disconnect
 */
export class SliccBashRendererComputer extends HTMLElement {
  static readonly observedAttributes = ['command', 'tool-call-id', 'computer-id', 'done', 'live'];

  readonly #root: ShadowRoot;
  #command = '';
  #output = '';
  #toolCallId = '';
  #computerId = '';
  #done = false;
  #live = false;
  #frameSrc: string | null = null;
  #frameMode: ComputerFrameMode = 'none';
  #cmdEl: HTMLElement | null = null;
  #outEl: HTMLElement | null = null;
  #frameEl: HTMLElement | null = null;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    // Keep the existing action-row terminal chrome (`:has(> .wcmsg-bash)`).
    this.classList.add('wcmsg-bash');
    this.#render();
    this.#emitBind('computer-row-bind');
  }

  disconnectedCallback(): void {
    this.#emitBind('computer-row-unbind');
  }

  attributeChangedCallback(name: string, _old: string | null, value: string | null): void {
    if (name === 'command') this.#command = value ?? '';
    else if (name === 'tool-call-id') this.#toolCallId = value ?? '';
    else if (name === 'computer-id') this.#computerId = value ?? '';
    else if (name === 'done') this.#done = value !== null;
    else if (name === 'live') this.#live = value !== null;
    if (this.isConnected) this.#render();
  }

  get command(): string {
    return this.#command;
  }
  set command(value: string) {
    this.#command = value;
    this.setAttribute('command', value);
  }

  get output(): string {
    return this.#output;
  }
  set output(value: string) {
    this.#output = value ?? '';
    if (this.isConnected) this.#paintOutput();
  }

  get toolCallId(): string {
    return this.#toolCallId;
  }
  set toolCallId(value: string) {
    this.#toolCallId = value;
    if (value) this.setAttribute('tool-call-id', value);
    else this.removeAttribute('tool-call-id');
  }

  get computerId(): string {
    return this.#computerId;
  }
  set computerId(value: string) {
    this.#computerId = value ?? '';
    if (this.#computerId) this.setAttribute('computer-id', this.#computerId);
    else this.removeAttribute('computer-id');
  }

  get done(): boolean {
    return this.#done;
  }
  set done(value: boolean) {
    this.#done = !!value;
    this.toggleAttribute('done', this.#done);
  }

  get live(): boolean {
    return this.#live;
  }
  set live(value: boolean) {
    this.#live = !!value;
    this.toggleAttribute('live', this.#live);
  }

  get frameSrc(): string | null {
    return this.#frameSrc;
  }
  set frameSrc(value: string | null) {
    this.#frameSrc = value;
    if (this.isConnected) this.#paintFrame();
  }

  get frameMode(): ComputerFrameMode {
    return this.#frameMode;
  }
  set frameMode(value: ComputerFrameMode) {
    this.#frameMode = value;
    this.live = value === 'live';
    if (this.isConnected) this.#paintFrame();
  }

  #emitBind(type: 'computer-row-bind' | 'computer-row-unbind'): void {
    this.dispatchEvent(
      new CustomEvent(type, {
        detail: {
          toolCallId: this.#toolCallId,
          command: this.#command,
          output: this.#output,
          done: this.#done,
          computerId: this.#computerId,
        },
        bubbles: true,
        composed: true,
      })
    );
  }

  #render(): void {
    this.#cmdEl = h('div', { class: 'cmd', part: 'command' }, `$ ${this.#command}`);
    this.#outEl = h('div', { class: 'out', part: 'output' });
    this.#frameEl = h('div', { class: 'frame', part: 'frame', hidden: true });
    this.#frameEl.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!this.#frameSrc) return;
      this.dispatchEvent(
        new CustomEvent('computer-frame-click', {
          detail: { src: this.#frameSrc },
          bubbles: true,
          composed: true,
        })
      );
    });
    this.#root.replaceChildren(this.#cmdEl, this.#outEl, this.#frameEl);
    this.#paintOutput();
    this.#paintFrame();
  }

  #paintOutput(): void {
    if (!this.#outEl) return;
    this.#outEl.replaceChildren();
    if (!this.#output) return;
    outputRenderer(this.#outEl, this.#output);
  }

  #paintFrame(): void {
    const frame = this.#frameEl;
    if (!frame) return;
    const src = this.#frameSrc;
    const mode = this.#frameMode;
    if (!src || mode === 'none') {
      frame.hidden = true;
      frame.replaceChildren();
      return;
    }
    frame.hidden = false;
    const img = h('img', {
      src,
      alt: mode === 'live' ? 'Live computer frame' : 'Frozen computer frame',
    });
    const pill = h(
      'span',
      { class: mode === 'live' ? 'pill' : 'pill frozen', part: 'frame-pill' },
      h('span', { class: 'dot' }),
      mode === 'live' ? 'live' : 'frozen'
    );
    frame.replaceChildren(img, pill);
  }
}

define('slicc-bash-renderer-computer', SliccBashRendererComputer);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-bash-renderer-computer': SliccBashRendererComputer;
  }
  interface HTMLElementEventMap {
    'computer-frame-click': CustomEvent<{ src: string }>;
    'computer-row-bind': CustomEvent<{
      toolCallId: string;
      command: string;
      output: string;
      done: boolean;
      computerId: string;
    }>;
    'computer-row-unbind': CustomEvent<{
      toolCallId: string;
      command: string;
      output: string;
      done: boolean;
      computerId: string;
    }>;
  }
}
