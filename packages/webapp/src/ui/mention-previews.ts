import { type AgentQuestionKind, findAgentQuestions } from '../core/agent-questions.js';
import {
  findGithubMentions,
  type GithubRef,
  githubRefLabel,
  githubRefUrl,
  resolveGithubMention,
} from '../core/github-mentions.js';
import {
  findTimeMentions,
  mayContainTime,
  type TimeContext,
  type TimeMention,
  type TimeParser,
} from '../core/time-mentions.js';

export const PREVIEW_ATTR = 'data-preview';

export type PreviewKind = 'link' | 'github' | 'time' | 'question';

export const GITHUB_MENTION_CLASS = 'github-mention';
export const TIME_MENTION_CLASS = 'time-mention';
export const AGENT_QUESTION_CLASS = 'agent-question';

export const QUESTION_TEXT_ATTR = 'data-question';
export const QUESTION_KIND_ATTR = 'data-question-kind';

export const QUESTION_ID_ATTR = 'data-question-id';

const GITHUB_ATTRS = {
  owner: 'data-gh-owner',
  repo: 'data-gh-repo',
  number: 'data-gh-number',
  kind: 'data-gh-kind',
} as const;

export const QUESTION_ANSWERED_ATTR = 'data-answered';

export const AGENT_QUESTION_ANSWER_EVENT = 'agent-question-answer';

export interface AgentQuestionAnswerDetail {
  question: string;
  kind: AgentQuestionKind;
  answer: string;

  messageId?: string;
}

const PROCESSED_ATTR = 'data-mention-previews';

const SKIP_ALWAYS = new Set(['A', 'PRE', 'SCRIPT', 'STYLE', 'TEXTAREA', 'BUTTON']);
const SKIP_INLINE = new Set([...SKIP_ALWAYS, 'CODE', 'KBD', 'SAMP']);

const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption';

const timeMentions = new WeakMap<Element, TimeMention>();

export function timeMentionOf(el: Element): TimeMention | undefined {
  return timeMentions.get(el);
}

export function githubRefOf(el: Element): GithubRef | null {
  const owner = el.getAttribute(GITHUB_ATTRS.owner);
  const repo = el.getAttribute(GITHUB_ATTRS.repo);
  const number = Number(el.getAttribute(GITHUB_ATTRS.number));
  const kind = el.getAttribute(GITHUB_ATTRS.kind);
  if (!owner || !repo || !Number.isInteger(number) || number <= 0) return null;
  return {
    owner,
    repo,
    number,
    kind: kind === 'pull' || kind === 'issue' ? kind : 'unknown',
  };
}

export interface DecorateContext {
  repoHints: readonly string[];

  resolveRepoFallback?: () => Promise<string | null>;

  getTimeParser?: () => Promise<TimeParser>;
  timeContext?: TimeContext;

  questions?: boolean;
}

function contentFingerprint(root: HTMLElement): string {
  return `${root.childNodes.length}:${root.textContent?.length ?? 0}`;
}

function isSkipped(node: Node, root: Node, skip: ReadonlySet<string>, ownClass?: string): boolean {
  for (let el = node.parentElement; el && el !== root; el = el.parentElement) {
    if (skip.has(el.tagName)) return true;
    if (ownClass && el.classList.contains(ownClass)) return true;
  }
  return false;
}

function textNodes(root: HTMLElement, skip: ReadonlySet<string>, ownClass?: string): Text[] {
  const out: Text[] = [];
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (!text.data.trim()) continue;
    if (isSkipped(text, root, skip, ownClass)) continue;
    out.push(text);
  }
  return out;
}

function wrapRanges(
  node: Text,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  make: (text: string, index: number) => HTMLElement
): HTMLElement[] {
  const made: HTMLElement[] = [];

  for (let i = ranges.length - 1; i >= 0; i -= 1) {
    const range = ranges[i];
    if (!range || range.end <= range.start || range.end > node.data.length) continue;
    const tail = node.splitText(range.start);
    tail.splitText(range.end - range.start);
    const el = make(tail.data, i);
    tail.replaceWith(el);
    el.append(tail);
    made.unshift(el);
  }
  return made;
}

function markLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (a.hasAttribute(PREVIEW_ATTR)) continue;
    if (a.closest('pre')) continue;
    if (!/^https?:\/\//i.test(a.getAttribute('href') ?? '')) continue;
    a.setAttribute(PREVIEW_ATTR, 'link');
  }
}

let questionCounter = 0;

function markQuestions(root: HTMLElement): void {
  const groups = new Map<Element, Text[]>();
  for (const node of textNodes(root, SKIP_ALWAYS, AGENT_QUESTION_CLASS)) {
    const block = node.parentElement?.closest(BLOCK_SELECTOR) ?? root;
    const owner = root.contains(block) ? block : root;
    const list = groups.get(owner);
    if (list) list.push(node);
    else groups.set(owner, [node]);
  }

  for (const [block, nodes] of groups) {
    if (block.querySelector(`.${AGENT_QUESTION_CLASS}`)) continue;
    let text = '';
    const spans = nodes.map((node) => {
      const start = text.length;
      text += node.data;
      return { node, start, end: text.length };
    });
    const questions = findAgentQuestions(text);
    if (questions.length === 0) continue;

    for (const { node, start, end } of spans) {
      const ranges: Array<{
        start: number;
        end: number;
        id: string;
        kind: AgentQuestionKind;
        text: string;
        first: boolean;
      }> = [];
      for (const q of questions) {
        const from = Math.max(q.start, start);
        const to = Math.min(q.end, end);
        if (from >= to) continue;
        const id = questionIdFor(q.start, block);
        ranges.push({
          start: from - start,
          end: to - start,
          id,
          kind: q.kind,
          text: q.text,
          first: from === q.start,
        });
      }
      if (ranges.length === 0) continue;
      wrapRanges(node, ranges, (_text, i) => {
        const r = ranges[i];
        const span = node.ownerDocument.createElement('span');
        span.className = AGENT_QUESTION_CLASS;
        span.setAttribute(PREVIEW_ATTR, 'question');
        if (r) {
          span.setAttribute(QUESTION_ID_ATTR, r.id);
          span.setAttribute(QUESTION_TEXT_ATTR, r.text);
          span.setAttribute(QUESTION_KIND_ATTR, r.kind);

          if (r.first) span.tabIndex = 0;
        }
        return span;
      });
    }
  }
}

const questionIds = new WeakMap<Element, Map<number, string>>();

function questionIdFor(offset: number, block: Element): string {
  let byOffset = questionIds.get(block);
  if (!byOffset) {
    byOffset = new Map();
    questionIds.set(block, byOffset);
  }
  let id = byOffset.get(offset);
  if (!id) {
    questionCounter += 1;
    id = `q${questionCounter}`;
    byOffset.set(offset, id);
  }
  return id;
}

async function markGithub(root: HTMLElement, ctx: DecorateContext): Promise<void> {
  const work = textNodes(root, SKIP_INLINE)
    .map((node) => ({ node, data: node.data, mentions: findGithubMentions(node.data) }))
    .filter((entry) => entry.mentions.length > 0);
  if (work.length === 0) return;

  let hints = ctx.repoHints;
  const needsRepo = work.some((w) => w.mentions.some((m) => !m.owner));
  if (needsRepo && hints.length === 0 && ctx.resolveRepoFallback) {
    const fallback = await ctx.resolveRepoFallback().catch(() => null);
    if (fallback) hints = [fallback];
  }

  for (const { node, data, mentions } of work) {
    if (!node.isConnected || node.data !== data) continue;
    const resolved = mentions
      .map((mention) => ({ mention, ref: resolveGithubMention(mention, hints) }))
      .filter(
        (entry): entry is { mention: typeof entry.mention; ref: GithubRef } => entry.ref !== null
      );
    if (resolved.length === 0) continue;
    wrapRanges(
      node,
      resolved.map(({ mention }) => mention),
      (_text, i) => {
        const ref = (resolved[i] as { ref: GithubRef }).ref;
        const a = node.ownerDocument.createElement('a');
        a.className = GITHUB_MENTION_CLASS;
        a.href = githubRefUrl(ref);
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.setAttribute(PREVIEW_ATTR, 'github');
        a.setAttribute(GITHUB_ATTRS.owner, ref.owner);
        a.setAttribute(GITHUB_ATTRS.repo, ref.repo);
        a.setAttribute(GITHUB_ATTRS.number, String(ref.number));
        a.setAttribute(GITHUB_ATTRS.kind, ref.kind);
        a.setAttribute('aria-label', `${ref.owner}/${ref.repo} ${githubRefLabel(ref)}`);
        return a;
      }
    );
  }
}

async function markTimes(root: HTMLElement, ctx: DecorateContext): Promise<void> {
  if (!ctx.getTimeParser || !ctx.timeContext) return;
  const nodes = textNodes(root, SKIP_INLINE, TIME_MENTION_CLASS).filter((node) =>
    mayContainTime(node.data)
  );
  if (nodes.length === 0) return;
  const snapshot = nodes.map((node) => node.data);
  const parser = await ctx.getTimeParser();
  const found = await findTimeMentions(snapshot, ctx.timeContext, parser);

  nodes.forEach((node, i) => {
    const mentions = found[i] ?? [];
    if (mentions.length === 0) return;
    if (!node.isConnected || node.data !== snapshot[i]) return;
    wrapRanges(node, mentions, (_text, j) => {
      const span = node.ownerDocument.createElement('span');
      span.className = TIME_MENTION_CLASS;
      span.setAttribute(PREVIEW_ATTR, 'time');
      const mention = mentions[j];
      if (mention) timeMentions.set(span, mention);
      return span;
    });
  });
}

export function decorateMentions(
  root: HTMLElement,
  ctx: DecorateContext,
  onError: (step: string, err: unknown) => void = () => {}
): Promise<void> {
  const running = inFlight.get(root);
  if (running) {
    running.rerun = { ctx, onError };
    return running.promise;
  }
  const entry: InFlight = { promise: Promise.resolve(), rerun: null };
  entry.promise = (async () => {
    try {
      await decorateOnce(root, ctx, onError);
      while (entry.rerun) {
        const next = entry.rerun;
        entry.rerun = null;
        await decorateOnce(root, next.ctx, next.onError);
      }
    } finally {
      inFlight.delete(root);
    }
  })();
  inFlight.set(root, entry);
  return entry.promise;
}

interface InFlight {
  promise: Promise<void>;
  rerun: { ctx: DecorateContext; onError: (step: string, err: unknown) => void } | null;
}

const inFlight = new WeakMap<HTMLElement, InFlight>();

async function decorateOnce(
  root: HTMLElement,
  ctx: DecorateContext,
  onError: (step: string, err: unknown) => void
): Promise<void> {
  const fingerprint = contentFingerprint(root);
  if (root.getAttribute(PROCESSED_ATTR) === fingerprint) return;

  const step = async (name: string, run: () => void | Promise<void>): Promise<void> => {
    try {
      await run();
    } catch (err) {
      onError(name, err);
    }
  };

  await step('links', () => markLinks(root));
  if (ctx.questions) await step('questions', () => markQuestions(root));
  await step('github', () => markGithub(root, ctx));
  await step('times', () => markTimes(root, ctx));

  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}
