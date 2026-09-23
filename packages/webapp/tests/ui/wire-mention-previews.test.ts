// @vitest-environment jsdom

import type { SliccAgentMessage, SliccHoverCard, SliccUserMessage } from '@slicc/webcomponents';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import '@slicc/webcomponents';
import { formatPathHints, TOOL_PATH_HINTS_ATTR } from '../../src/core/tool-call-paths.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import {
  AGENT_QUESTION_ANSWER_EVENT,
  type AgentQuestionAnswerDetail,
  QUESTION_ANSWERED_ATTR,
} from '../../src/ui/mention-previews.js';
import {
  attachMentionPreviewFs,
  collectRepoHints,
  wireMentionPreviews,
} from '../../src/ui/wc/wire-mention-previews.js';

const silentLog = { error: () => {} };

function agent(html: string, id = `m${Math.random()}`): SliccAgentMessage {
  const el = document.createElement('slicc-agent-message') as SliccAgentMessage;
  el.setAttribute('data-msg-id', id);
  el.setBodyHtml(html);
  return el;
}

function user(text: string): SliccUserMessage {
  const el = document.createElement('slicc-user-message') as SliccUserMessage;
  el.setAttribute('text', text);
  return el;
}

function toolRow(text: string, paths: string[] = []): HTMLElement {
  const row = document.createElement('slicc-action-row');
  row.textContent = text;
  const hints = formatPathHints(paths);
  if (hints) row.setAttribute(TOOL_PATH_HINTS_ATTR, hints);
  return row;
}

async function settle(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0));
}

let card: SliccHoverCard;

function setup(
  thread: HTMLElement,
  opts: { readOnly?: boolean; fetchHtml?: string } = {}
): { dispose: () => void; fetchFn: ReturnType<typeof vi.fn> } {
  const fetchFn = vi.fn(async () => ({
    status: 200,
    headers: { 'content-type': 'text/html' },
    body: new TextEncoder().encode(
      opts.fetchHtml ?? '<head><meta property="og:title" content="Page"></head>'
    ),
  }));
  const dispose = wireMentionPreviews({
    thread,
    isReadOnly: () => opts.readOnly === true,
    log: silentLog,
    getFetch: () => fetchFn,
    getTimeParser: async () => ({
      parseMany: async (texts) => texts.map(() => ({ spans: [], occurrences: [], rrules: [] })),
    }),
    getCard: () => card,
    hoverDelayMs: 0,
  });
  return { dispose, fetchFn };
}

function hover(el: Element): void {
  el.dispatchEvent(new Event('pointerover', { bubbles: true }));
}

beforeEach(() => {
  document.body.replaceChildren();
  card = document.createElement('slicc-hover-card') as SliccHoverCard;
  document.body.append(card);

  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    cb(0);
    return 0;
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wireMentionPreviews', () => {
  it('survives a missing thread and a throwing dependency', () => {
    const log = { error: vi.fn() };
    expect(
      wireMentionPreviews({ thread: null as unknown as HTMLElement, isReadOnly: () => false, log })
    ).toBeTypeOf('function');
    const broken = {
      addEventListener: () => {
        throw new Error('boom');
      },
    } as unknown as HTMLElement;
    Object.setPrototypeOf(broken, HTMLElement.prototype);
    expect(wireMentionPreviews({ thread: broken, isReadOnly: () => false, log })).toBeTypeOf(
      'function'
    );
  });

  it('decorates finished agent messages but not streaming ones', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const done = agent('<p>Should I continue?</p>');
    const streaming = agent('<p>Should I also stop?</p>');
    streaming.setAttribute('streaming', '');
    thread.append(done, streaming);
    const { dispose } = setup(thread);
    await settle();
    expect(done.querySelector('.agent-question')).not.toBeNull();
    expect(streaming.querySelector('.agent-question')).toBeNull();

    streaming.removeAttribute('streaming');
    await settle();
    expect(streaming.querySelector('.agent-question')).not.toBeNull();
    dispose();
  });

  it('links a bare reference from a repository a tool row named', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    thread.append(toolRow('gh pr view 5 -R ai-ecoverse/slicc'));
    const bubble = agent('<p>PR 5 is merged.</p>');
    thread.append(bubble);
    const { dispose } = setup(thread);
    await settle();
    expect(bubble.querySelector('a.github-mention')?.getAttribute('href')).toBe(
      'https://github.com/ai-ecoverse/slicc/pull/5'
    );
    dispose();
  });

  it('falls back to the git remote of a touched checkout', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    thread.append(toolRow('edited a file', ['/workspace/proj/src/a.ts']));
    const bubble = agent('<p>That fixes #9.</p>');
    thread.append(bubble);
    const fs = {
      readDir: async () => [],
      stat: async () => {
        throw new Error('ENOENT');
      },
      readFile: async (path: string) => {
        if (path === '/workspace/proj/.git/config')
          return '[remote "origin"]\nurl = git@github.com:me/proj.git\n';
        throw new Error('ENOENT');
      },
    } as unknown as LocalVfsClient;
    attachMentionPreviewFs(thread, async () => fs);
    const { dispose } = setup(thread);
    await settle();
    expect(bubble.querySelector('a.github-mention')?.getAttribute('href')).toBe(
      'https://github.com/me/proj/issues/9'
    );
    dispose();
  });

  it('opens a link card on hover and fills it from the fetched page', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>See <a href="https://example.com/post">the post</a>.</p>');
    thread.append(bubble);
    const { dispose, fetchFn } = setup(thread);
    await settle();
    const link = bubble.querySelector('a[data-preview="link"]') as HTMLElement;
    hover(link);
    await settle();
    expect(card.open).toBe(true);
    const preview = card.querySelector('slicc-link-preview');
    expect(preview?.getAttribute('heading')).toBe('Page');
    expect(preview?.getAttribute('state')).toBe('ready');
    expect(fetchFn).toHaveBeenCalledTimes(1);

    link.dispatchEvent(new Event('pointerout', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 250));
    expect(card.open).toBe(false);
    dispose();
  });

  it('opens a GitHub card without fetching', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>See o/r#7.</p>');
    thread.append(bubble);
    const { dispose, fetchFn } = setup(thread);
    await settle();
    hover(bubble.querySelector('a.github-mention') as Element);
    await settle();
    const preview = card.querySelector('slicc-link-preview');
    expect(preview?.getAttribute('image')).toBe(
      'https://opengraph.githubassets.com/slicc/o/r/issues/7'
    );
    expect(fetchFn).not.toHaveBeenCalled();
    dispose();
  });

  it('opens a time card for a decorated date', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>Ship it tomorrow at 9am.</p>');
    thread.append(bubble);
    const dispose = wireMentionPreviews({
      thread,
      isReadOnly: () => false,
      log: silentLog,
      getCard: () => card,
      hoverDelayMs: 0,
      now: () => new Date('2026-09-23T10:00:00Z'),
      getTimeParser: async () => ({
        parseMany: async (texts) =>
          texts.map((t) => {
            const at = t.indexOf('tomorrow at 9am');
            return {
              spans:
                at >= 0
                  ? [{ start: at, end: at + 15, text: 'tomorrow at 9am', confidence: 0.99 }]
                  : [],
              occurrences:
                t === 'tomorrow at 9am' ? [{ start: '2026-09-24T09:00:00Z', allDay: false }] : [],
              rrules: [],
            };
          }),
      }),
    });
    await settle();
    hover(bubble.querySelector('.time-mention') as Element);
    await settle();
    const preview = card.querySelector('slicc-time-preview');
    expect(preview?.data?.text).toBe('tomorrow at 9am');
    expect(preview?.data?.occurrences[0]?.start).toBe('2026-09-24T09:00:00Z');
    dispose();
  });

  it("resolves relative times against the message's send time, not now", async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>Ship it tomorrow at 9am.</p>');
    bubble.setAttribute('data-msg-time', String(Date.parse('2026-08-01T12:00:00Z')));
    const fresh = agent('<p>And again tomorrow at 9am.</p>');
    thread.append(bubble, fresh);
    const references: string[] = [];
    const dispose = wireMentionPreviews({
      thread,
      isReadOnly: () => false,
      log: silentLog,
      getCard: () => card,
      now: () => new Date('2026-09-23T10:00:00Z'),
      getTimeParser: async () => ({
        parseMany: async (texts, context) => {
          references.push(context.reference);
          return texts.map(() => ({ spans: [], occurrences: [], rrules: [] }));
        },
      }),
    });
    await settle();
    expect(references).toContain('2026-08-01T12:00:00.000Z');
    expect(references).toContain('2026-09-23T10:00:00.000Z');
    dispose();
  });

  it('answers the latest question and dispatches the answer on the thread', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>Should I file an issue next?</p>', 'msg-1');
    thread.append(bubble);
    const { dispose } = setup(thread);
    await settle();
    const answers: AgentQuestionAnswerDetail[] = [];
    thread.addEventListener(AGENT_QUESTION_ANSWER_EVENT, (e) =>
      answers.push((e as CustomEvent<AgentQuestionAnswerDetail>).detail)
    );
    const span = bubble.querySelector('.agent-question') as HTMLElement;
    span.click();
    await settle();
    const prompt = card.querySelector('slicc-question-prompt');
    expect(prompt?.getAttribute('state')).toBe('open');
    (prompt?.shadowRoot?.querySelector('button[part="answer-yes"]') as HTMLButtonElement).click();
    expect(answers).toEqual([
      {
        question: 'Should I file an issue next?',
        kind: 'yes-no',
        answer: 'yes',
        messageId: 'msg-1',
      },
    ]);
    expect(prompt?.getAttribute('state')).toBe('answered');
    expect(span.hasAttribute(QUESTION_ANSWERED_ATTR)).toBe(true);

    card.hide();
    span.click();
    await settle();
    expect(card.querySelector('slicc-question-prompt')?.getAttribute('answer')).toBe('yes');
    dispose();
  });

  it('keeps older, replied-to and read-only questions inert', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const older = agent('<p>Should I start?</p>');
    const latest = agent('<p>When should it ship?</p>');
    thread.append(older, latest);
    const { dispose } = setup(thread);
    await settle();

    (older.querySelector('.agent-question') as HTMLElement).click();
    await settle();
    let prompt = card.querySelector('slicc-question-prompt');
    expect(prompt?.getAttribute('state')).toBe('inert');
    expect(prompt?.getAttribute('note')).toMatch(/latest/);

    (latest.querySelector('.agent-question') as HTMLElement).click();
    await settle();
    prompt = card.querySelector('slicc-question-prompt');
    expect(prompt?.getAttribute('state')).toBe('open');
    expect(prompt?.getAttribute('kind')).toBe('datetime');

    thread.append(user('tomorrow'));
    card.hide();
    (latest.querySelector('.agent-question') as HTMLElement).click();
    await settle();
    expect(card.querySelector('slicc-question-prompt')?.getAttribute('note')).toMatch(
      /already replied/
    );
    dispose();

    card.hide();
    const roThread = document.createElement('div');
    document.body.append(roThread);
    const ro = agent('<p>Should I go?</p>');
    roThread.append(ro);
    const readOnly = setup(roThread, { readOnly: true });
    await settle();
    (ro.querySelector('.agent-question') as HTMLElement).click();
    await settle();
    expect(card.querySelector('slicc-question-prompt')?.getAttribute('note')).toMatch(/read-only/);
    readOnly.dispose();
  });

  it('opens a question card from the keyboard', async () => {
    const thread = document.createElement('div');
    document.body.append(thread);
    const bubble = agent('<p>Should I go?</p>');
    thread.append(bubble);
    const { dispose } = setup(thread);
    await settle();
    const span = bubble.querySelector('.agent-question') as HTMLElement;
    span.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    expect(card.querySelector('slicc-question-prompt')).not.toBeNull();
    dispose();
  });
});

describe('collectRepoHints', () => {
  it('reads tool rows, earlier messages and the bubble itself, most recent last', () => {
    const thread = document.createElement('div');
    thread.append(
      toolRow('git clone https://github.com/a/one'),
      user('look at https://github.com/b/two/issues/1'),
      agent('<p>Also <a href="https://github.com/a/one/pull/3">this</a></p>')
    );
    const bubble = agent('<p>and c/three#4</p>');
    thread.append(bubble, toolRow('https://github.com/after/wards'));
    expect(collectRepoHints(thread, bubble)).toEqual(['b/two', 'a/one', 'c/three']);
  });
});
