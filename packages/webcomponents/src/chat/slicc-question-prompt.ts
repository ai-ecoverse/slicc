import { define } from '../internal/define.js';
import { h, sheet } from '../internal/dom.js';
import { iconEl } from '../internal/icons.js';

export type QuestionKind = 'yes-no' | 'text' | 'number' | 'datetime' | 'date' | 'email';

export type QuestionState = 'open' | 'answered' | 'inert';

export interface QuestionAnswerDetail {
  question: string;
  kind: QuestionKind;
  answer: string;
}

const KINDS = new Set<QuestionKind>(['yes-no', 'text', 'number', 'datetime', 'date', 'email']);
const STATES = new Set<QuestionState>(['open', 'answered', 'inert']);

const INPUT_TYPE: Record<Exclude<QuestionKind, 'yes-no'>, string> = {
  text: 'text',
  number: 'number',
  datetime: 'datetime-local',
  date: 'date',
  email: 'email',
};

function withLocalOffset(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(value)) return value;
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return value;
  const minutes = -at.getTimezoneOffset();
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);
  const hh = String(Math.floor(abs / 60)).padStart(2, '0');
  const mm = String(abs % 60).padStart(2, '0');
  return `${value}${sign}${hh}:${mm}`;
}

const STYLE = `
:host{display:block;width:300px;max-width:100%;color:var(--ink);}
:host([hidden]){display:none;}
.wrap{display:flex;flex-direction:column;gap:10px;padding:12px;}
.q{display:flex;gap:8px;align-items:flex-start;font-size:13px;line-height:1.35;font-weight:550;}
.q svg{flex:0 0 auto;margin-top:2px;color:var(--ctx,currentColor);}
.row{display:flex;gap:6px;}
button{
  -webkit-appearance:none;appearance:none;
  display:inline-flex;align-items:center;justify-content:center;gap:5px;
  flex:1 1 0;min-height:30px;padding:0 12px;border-radius:9px;
  font:600 12.5px var(--ui);cursor:pointer;
  color:var(--ink);background:color-mix(in srgb,var(--ink) 7%,transparent);
  border:1px solid color-mix(in srgb,var(--ink) 14%,transparent);
}
button:hover:not(:disabled){background:color-mix(in srgb,var(--ink) 12%,transparent);}
button:focus-visible,input:focus-visible{outline:2px solid var(--ctx,currentColor);outline-offset:1px;}
button.primary{color:var(--canvas,#fff);background:var(--ctx,var(--ink));border-color:transparent;}
button.primary:hover:not(:disabled){filter:brightness(1.08);background:var(--ctx,var(--ink));}
button.send{flex:0 0 auto;padding:0 10px;}
button:disabled,input:disabled{opacity:.5;cursor:default;}
input{
  flex:1 1 auto;min-width:0;min-height:30px;box-sizing:border-box;padding:0 10px;
  font:13px var(--ui);color:var(--ink);background:var(--canvas,#fff);
  border:1px solid color-mix(in srgb,var(--ink) 18%,transparent);border-radius:9px;
  color-scheme:light dark;
}
.note{font-size:11.5px;color:color-mix(in srgb,var(--ink) 60%,transparent);}
.answered{display:flex;align-items:center;gap:6px;font-size:12.5px;}
.answered svg{color:var(--ctx,currentColor);}
.answered b{font-weight:650;}
`;
const SHEET = sheet(STYLE);

export class SliccQuestionPrompt extends HTMLElement {
  static readonly observedAttributes = ['question', 'kind', 'state', 'answer', 'note'];

  readonly #root: ShadowRoot;

  constructor() {
    super();
    this.#root = this.attachShadow({ mode: 'open' });
    this.#root.adoptedStyleSheets = [SHEET];
  }

  connectedCallback(): void {
    this.#render();
  }

  attributeChangedCallback(): void {
    if (this.isConnected) this.#render();
  }

  get question(): string {
    return this.getAttribute('question') ?? '';
  }

  set question(value: string) {
    this.setAttribute('question', value);
  }

  get kind(): QuestionKind {
    const raw = this.getAttribute('kind') as QuestionKind | null;
    return raw && KINDS.has(raw) ? raw : 'yes-no';
  }

  set kind(value: QuestionKind) {
    this.setAttribute('kind', value);
  }

  get state(): QuestionState {
    const raw = this.getAttribute('state') as QuestionState | null;
    return raw && STATES.has(raw) ? raw : 'open';
  }

  set state(value: QuestionState) {
    this.setAttribute('state', value);
  }

  get answer(): string {
    return this.getAttribute('answer') ?? '';
  }

  set answer(value: string) {
    this.setAttribute('answer', value);
  }

  override focus(options?: FocusOptions): void {
    const target = this.#root.querySelector<HTMLElement>('input,button:not(:disabled)');
    if (target) target.focus(options);
    else super.focus(options);
  }

  #submit(answer: string): void {
    const trimmed = answer.trim();
    if (!trimmed || this.state !== 'open') return;
    const value = this.kind === 'datetime' ? withLocalOffset(trimmed) : trimmed;
    const detail: QuestionAnswerDetail = {
      question: this.question,
      kind: this.kind,
      answer: value,
    };
    this.dispatchEvent(
      new CustomEvent<QuestionAnswerDetail>('question-answer', {
        detail,
        bubbles: true,
        composed: true,
      })
    );
  }

  #render(): void {
    const state = this.state;
    const heading = h(
      'div',
      { class: 'q', part: 'question' },
      iconEl('message-circle-question', { size: 14 }),
      h('span', null, this.question)
    );

    let body: HTMLElement;
    if (state === 'answered') {
      body = h(
        'div',
        { class: 'answered', part: 'answered' },
        iconEl('circle-check', { size: 14 }),
        h('span', null, 'You answered '),
        h('b', null, this.answer)
      );
    } else {
      body = this.kind === 'yes-no' ? this.#yesNo(state) : this.#input(state);
    }

    const note = this.getAttribute('note');
    this.#root.replaceChildren(
      h(
        'div',
        { class: 'wrap' },
        heading,
        body,
        state === 'inert' && note ? h('div', { class: 'note', part: 'note' }, note) : null
      )
    );
  }

  #yesNo(state: QuestionState): HTMLElement {
    const disabled = state !== 'open';
    const button = (label: string, icon: string, primary: boolean): HTMLButtonElement => {
      const el = h(
        'button',
        { class: primary ? 'primary' : '', part: `answer-${label.toLowerCase()}` },
        iconEl(icon, { size: 13 }),
        label
      ) as HTMLButtonElement;
      el.type = 'button';
      el.disabled = disabled;
      el.addEventListener('click', () => this.#submit(label.toLowerCase()));
      return el;
    };
    return h('div', { class: 'row' }, button('Yes', 'check', true), button('No', 'x', false));
  }

  #input(state: QuestionState): HTMLElement {
    const kind = this.kind as Exclude<QuestionKind, 'yes-no'>;
    const disabled = state !== 'open';
    const input = h('input', {
      type: INPUT_TYPE[kind] ?? 'text',
      part: 'input',
      'aria-label': this.question || 'Answer',
      placeholder: kind === 'text' ? 'Type an answer…' : null,
    }) as HTMLInputElement;
    input.disabled = disabled;
    const send = h(
      'button',
      { class: 'primary send', part: 'send', 'aria-label': 'Send answer' },
      iconEl('arrow-up', { size: 14 })
    ) as HTMLButtonElement;
    send.type = 'submit';
    send.disabled = disabled;
    const form = h('form', { class: 'row' }, input, send) as HTMLFormElement;
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.#submit(input.value);
    });
    return form;
  }
}

define('slicc-question-prompt', SliccQuestionPrompt);

declare global {
  interface HTMLElementTagNameMap {
    'slicc-question-prompt': SliccQuestionPrompt;
  }
}
