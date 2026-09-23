// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import type { TimeParser } from '../../src/core/time-mentions.js';
import {
  AGENT_QUESTION_CLASS,
  decorateMentions,
  GITHUB_MENTION_CLASS,
  githubRefOf,
  PREVIEW_ATTR,
  QUESTION_ID_ATTR,
  QUESTION_KIND_ATTR,
  QUESTION_TEXT_ATTR,
  TIME_MENTION_CLASS,
  timeMentionOf,
} from '../../src/ui/mention-previews.js';

const CONTEXT = { reference: '2026-09-23T10:00:00.000Z', timeZone: 'UTC' };

function body(html: string): HTMLElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  document.body.append(el);
  return el;
}

function parserFor(phrase: string): TimeParser {
  return {
    parseMany: async (texts) =>
      texts.map((text) => {
        const at = text.indexOf(phrase);
        return {
          spans:
            at >= 0 ? [{ start: at, end: at + phrase.length, text: phrase, confidence: 0.99 }] : [],
          occurrences: text === phrase ? [{ start: '2026-09-24T09:00:00Z', allDay: false }] : [],
          rrules: [],
        };
      }),
  };
}

describe('decorateMentions — links', () => {
  it('marks web links, not other schemes or code-block links', async () => {
    const root = body(
      '<p><a href="https://example.com">x</a> <a href="mailto:a@b">m</a></p><pre><a href="https://in.pre">p</a></pre>'
    );
    await decorateMentions(root, { repoHints: [] });
    const marked = root.querySelectorAll(`[${PREVIEW_ATTR}="link"]`);
    expect(Array.from(marked, (a) => a.getAttribute('href'))).toEqual(['https://example.com']);
  });
});

describe('decorateMentions — GitHub', () => {
  it('links references using the most recent repository hint', async () => {
    const root = body('<p>Fixed in PR 12 and #13.</p>');
    await decorateMentions(root, { repoHints: ['old/repo', 'ai-ecoverse/slicc'] });
    const links = Array.from(root.querySelectorAll<HTMLAnchorElement>(`a.${GITHUB_MENTION_CLASS}`));
    expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
      ['PR 12', 'https://github.com/ai-ecoverse/slicc/pull/12'],
      ['#13', 'https://github.com/ai-ecoverse/slicc/issues/13'],
    ]);
    expect(links[0]?.getAttribute('target')).toBe('_blank');
    expect(githubRefOf(links[0] as Element)).toEqual({
      owner: 'ai-ecoverse',
      repo: 'slicc',
      number: 12,
      kind: 'pull',
    });
    expect(root.textContent).toBe('Fixed in PR 12 and #13.');
  });

  it('leaves bare references as text when no repository is known', async () => {
    const root = body('<p>See #13.</p>');
    await decorateMentions(root, { repoHints: [] });
    expect(root.querySelector('a')).toBeNull();
  });

  it('falls back to the resolver only when needed, and links qualified refs regardless', async () => {
    const fallback = vi.fn(async () => 'from/remote');
    const root = body('<p>a/b#1 and #2</p>');
    await decorateMentions(root, { repoHints: [], resolveRepoFallback: fallback });
    const hrefs = Array.from(root.querySelectorAll('a'), (a) => a.getAttribute('href'));
    expect(hrefs).toEqual([
      'https://github.com/a/b/issues/1',
      'https://github.com/from/remote/issues/2',
    ]);
    expect(fallback).toHaveBeenCalledTimes(1);

    const noNeed = vi.fn(async () => 'x/y');
    await decorateMentions(body('<p>a/b#1</p>'), { repoHints: [], resolveRepoFallback: noNeed });
    expect(noNeed).not.toHaveBeenCalled();
  });

  it('skips code, links and code blocks', async () => {
    const root = body('<p><code>#1</code> <a href="https://x.test">#2</a></p><pre>#3</pre>');
    await decorateMentions(root, { repoHints: ['o/r'] });
    expect(root.querySelector(`.${GITHUB_MENTION_CLASS}`)).toBeNull();
  });

  it('githubRefOf rejects incomplete anchors', () => {
    expect(githubRefOf(document.createElement('a'))).toBeNull();
  });
});

describe('decorateMentions — times', () => {
  it('wraps confident expressions and records their resolution', async () => {
    const root = body('<p>I will run it tomorrow at 9am, promise.</p>');
    await decorateMentions(root, {
      repoHints: [],
      getTimeParser: async () => parserFor('tomorrow at 9am'),
      timeContext: CONTEXT,
    });
    const span = root.querySelector(`.${TIME_MENTION_CLASS}`);
    expect(span?.textContent).toBe('tomorrow at 9am');
    expect(span?.getAttribute(PREVIEW_ATTR)).toBe('time');
    expect(timeMentionOf(span as Element)?.occurrences).toHaveLength(1);
    expect(root.textContent).toBe('I will run it tomorrow at 9am, promise.');
  });

  it('does nothing without a parser, and never loads one for timeless text', async () => {
    const getTimeParser = vi.fn(async () => parserFor('x'));
    await decorateMentions(body('<p>plain words only</p>'), {
      repoHints: [],
      getTimeParser,
      timeContext: CONTEXT,
    });
    expect(getTimeParser).not.toHaveBeenCalled();
    const root = body('<p>tomorrow at 9am</p>');
    await decorateMentions(root, { repoHints: [] });
    expect(root.querySelector(`.${TIME_MENTION_CLASS}`)).toBeNull();
  });
});

describe('decorateMentions — questions', () => {
  it('wraps each question, across inline elements, with one id and one tab stop', async () => {
    const root = body('<p>I fixed it. Should I delete <code>old.ts</code> too? Done.</p>');
    await decorateMentions(root, { repoHints: [], questions: true });
    const segments = Array.from(root.querySelectorAll<HTMLElement>(`.${AGENT_QUESTION_CLASS}`));
    expect(segments.map((s) => s.textContent).join('')).toBe('Should I delete old.ts too?');
    const ids = new Set(segments.map((s) => s.getAttribute(QUESTION_ID_ATTR)));
    expect(ids.size).toBe(1);
    expect(segments.filter((s) => s.tabIndex === 0)).toHaveLength(1);
    expect(segments[0]?.getAttribute(QUESTION_TEXT_ATTR)).toBe('Should I delete old.ts too?');
    expect(segments[0]?.getAttribute(QUESTION_KIND_ATTR)).toBe('yes-no');
  });

  it('only runs when asked', async () => {
    const root = body('<p>Should I go on?</p>');
    await decorateMentions(root, { repoHints: [] });
    expect(root.querySelector(`.${AGENT_QUESTION_CLASS}`)).toBeNull();
  });

  it('nests inline marks inside a question', async () => {
    const root = body('<p>Should I merge #4 tomorrow at 9am?</p>');
    await decorateMentions(root, {
      repoHints: ['o/r'],
      questions: true,
      getTimeParser: async () => parserFor('tomorrow at 9am'),
      timeContext: CONTEXT,
    });
    const gh = root.querySelector(`.${GITHUB_MENTION_CLASS}`);
    const time = root.querySelector(`.${TIME_MENTION_CLASS}`);
    expect(gh?.closest(`.${AGENT_QUESTION_CLASS}`)).not.toBeNull();
    expect(time?.closest(`.${AGENT_QUESTION_CLASS}`)).not.toBeNull();
  });
});

describe('decorateMentions — idempotence and errors', () => {
  it('a second pass over decorated content changes nothing', async () => {
    const root = body('<p>Should I fix #1? See <a href="https://x.test">x</a>.</p>');
    const ctx = { repoHints: ['o/r'], questions: true };
    await decorateMentions(root, ctx);
    const first = root.innerHTML;

    root.removeAttribute('data-mention-previews');
    await decorateMentions(root, ctx);
    expect(root.innerHTML).toBe(first);
  });

  it('coalesces overlapping passes on the same root', async () => {
    const parse = vi.fn(parserFor('tomorrow at 9am').parseMany);
    const ctx = {
      repoHints: [],
      getTimeParser: async () => ({ parseMany: parse }),
      timeContext: CONTEXT,
    };
    const root = body('<p>tomorrow at 9am</p>');
    await Promise.all([
      decorateMentions(root, ctx),
      decorateMentions(root, ctx),
      decorateMentions(root, ctx),
    ]);
    expect(root.querySelectorAll(`.${TIME_MENTION_CLASS}`)).toHaveLength(1);
  });

  it('reports a failing step and still runs the others', async () => {
    const onError = vi.fn();
    const root = body('<p>Should I ship #3 tomorrow?</p>');
    await decorateMentions(
      root,
      {
        repoHints: ['o/r'],
        questions: true,
        getTimeParser: async () => {
          throw new Error('no model');
        },
        timeContext: CONTEXT,
      },
      onError
    );
    expect(onError).toHaveBeenCalledWith('times', expect.any(Error));
    expect(root.querySelector(`.${GITHUB_MENTION_CLASS}`)).not.toBeNull();
  });
});
