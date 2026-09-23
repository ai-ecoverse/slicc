import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type QuestionAnswerDetail,
  SliccQuestionPrompt,
} from '../../src/chat/slicc-question-prompt.js';
import { ensureGlobalTokens } from '../../src/theme/tokens.js';

function mount(attrs: Record<string, string>): SliccQuestionPrompt {
  const el = document.createElement('slicc-question-prompt');
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  document.body.append(el);
  return el;
}

function answers(el: SliccQuestionPrompt): QuestionAnswerDetail[] {
  const seen: QuestionAnswerDetail[] = [];
  el.addEventListener('question-answer', (event) => {
    seen.push((event as CustomEvent<QuestionAnswerDetail>).detail);
  });
  return seen;
}

const q = (el: SliccQuestionPrompt, sel: string) =>
  el.shadowRoot?.querySelector<HTMLElement>(sel) ?? null;

describe('slicc-question-prompt', () => {
  beforeEach(() => {
    ensureGlobalTokens();
    document.body.replaceChildren();
  });

  it('registers the custom element', () => {
    expect(customElements.get('slicc-question-prompt')).toBe(SliccQuestionPrompt);
  });

  it('defaults to an open yes/no prompt', () => {
    const el = mount({ question: 'Ship it?' });
    expect(el.kind).toBe('yes-no');
    expect(el.state).toBe('open');
    expect(q(el, '[part="question"]')?.textContent).toBe('Ship it?');
    expect(q(el, '[part="answer-yes"]')).not.toBeNull();
    expect(q(el, '[part="answer-no"]')).not.toBeNull();
  });

  it('fires a composed question-answer event for yes and no', () => {
    const el = mount({ question: 'Ship it?' });
    const seen = answers(el);
    const onDoc = vi.fn();
    document.addEventListener('question-answer', onDoc, { once: true });
    q(el, '[part="answer-yes"]')?.click();
    q(el, '[part="answer-no"]')?.click();
    expect(seen).toEqual([
      { question: 'Ship it?', kind: 'yes-no', answer: 'yes' },
      { question: 'Ship it?', kind: 'yes-no', answer: 'no' },
    ]);
    expect(onDoc).toHaveBeenCalled();
  });

  it.each([
    ['text', 'text'],
    ['number', 'number'],
    ['datetime', 'datetime-local'],
    ['date', 'date'],
    ['email', 'email'],
  ])('renders a %s question as an <input type=%s>', (kind, type) => {
    const el = mount({ question: 'Q?', kind });
    expect((q(el, '[part="input"]') as HTMLInputElement).type).toBe(type);
    expect(q(el, '[part="answer-yes"]')).toBeNull();
  });

  it('submits a trimmed free-form answer and ignores an empty one', () => {
    const el = mount({ question: 'Which branch?', kind: 'text' });
    const seen = answers(el);
    const input = q(el, '[part="input"]') as HTMLInputElement;
    input.value = '   ';
    q(el, '[part="send"]')?.click();
    expect(seen).toEqual([]);
    input.value = '  main  ';
    q(el, '[part="send"]')?.click();
    expect(seen).toEqual([{ question: 'Which branch?', kind: 'text', answer: 'main' }]);
  });

  it('shows the answer in the answered state', () => {
    const el = mount({ question: 'Ship it?', state: 'answered', answer: 'yes' });
    expect(q(el, '[part="answered"]')?.textContent).toContain('yes');
    expect(q(el, 'button')).toBeNull();
  });

  it('disables controls and shows the note when inert', () => {
    const el = mount({ question: 'Ship it?', state: 'inert', note: 'Read-only' });
    const seen = answers(el);
    const yes = q(el, '[part="answer-yes"]') as HTMLButtonElement;
    expect(yes.disabled).toBe(true);
    yes.click();
    expect(seen).toEqual([]);
    expect(q(el, '[part="note"]')?.textContent).toBe('Read-only');
  });

  it('hides the note outside the inert state', () => {
    const el = mount({ question: 'Ship it?', note: 'Read-only' });
    expect(q(el, '[part="note"]')).toBeNull();
  });

  it('reflects properties and ignores unknown kind/state values', () => {
    const el = mount({ question: 'a' });
    el.question = 'b';
    el.kind = 'number';
    el.state = 'answered';
    el.answer = '3';
    expect(el.getAttribute('question')).toBe('b');
    expect(el.getAttribute('kind')).toBe('number');
    expect(el.getAttribute('state')).toBe('answered');
    expect(el.getAttribute('answer')).toBe('3');
    el.setAttribute('kind', 'bogus');
    el.setAttribute('state', 'bogus');
    expect(el.kind).toBe('yes-no');
    expect(el.state).toBe('open');
  });

  it('focus() moves focus to the first control', () => {
    const el = mount({ question: 'When?', kind: 'datetime' });
    el.focus();
    expect(el.shadowRoot?.activeElement).toBe(q(el, '[part="input"]'));
  });
});
