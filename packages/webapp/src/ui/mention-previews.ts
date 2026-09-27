/**
 * Marking web links, GitHub issue/PR references, dates, times, and the
 * questions the agent asked. Question metadata stays in the message for hover
 * previews, while the live answer controls are shown in the composer.
 *
 * The DOM half of four detectors (`core/github-mentions.ts`,
 * `core/time-mentions.ts`, `core/agent-questions.ts`, and markdown's own
 * links). Like `file-mention-linker.ts` and `base64-preview-linker.ts`, it
 * only decorates what it has CONFIRMED — a `#123` with no inferable repository
 * stays text, a low-confidence date stays text — and it leaves everything else
 * exactly as the markdown renderer produced it.
 *
 * Decoration marks preview anchors with `data-preview="<kind>"`; showing a
 * card on hover and routing composer answers belongs to `ui/wc/wire-mention-previews.ts`.
 *
 * ## Where it declines to look
 *
 * Fenced code (`pre`) is skipped for everything: it is literal text someone
 * asked to see. Inline `code` is skipped for GitHub references and times (a
 * `#123` in code is as likely a colour or an anchor), but not for questions —
 * "Should I delete `foo.ts`?" is still a question. Existing links are never
 * re-entered.
 *
 * ## Idempotence
 *
 * Messages re-render, and the other linkers mutate the same body, so this runs
 * repeatedly. Every step skips what it has already marked, and a pass over
 * content it has fully processed changes nothing.
 */

import type { AgentQuestionParser } from '../core/agent-question-model.js';
import type { PredictedQuestion } from '../core/agent-question-worker.js';
import {
  type AgentQuestionKind,
  classifyQuestion,
  findAgentQuestions,
} from '../core/agent-questions.js';
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

/** Attribute naming which preview an element has. */
export const PREVIEW_ATTR = 'data-preview';

/** The previews a decorated element can have. */
export type PreviewKind = 'link' | 'github' | 'time' | 'question';

export const GITHUB_MENTION_CLASS = 'github-mention';
export const TIME_MENTION_CLASS = 'time-mention';
export const AGENT_QUESTION_CLASS = 'agent-question';

/** Question spans carry their sentence and kind for the hover card. */
export const QUESTION_TEXT_ATTR = 'data-question';
export const QUESTION_KIND_ATTR = 'data-question-kind';
/** Every segment of one question shares this id. */
export const QUESTION_ID_ATTR = 'data-question-id';
export const QUESTION_CONTROLS_ATTR = 'data-question-controls';
export const QUESTION_OPTIONS_ATTR = 'data-question-options';
export const QUESTION_DEFAULT_ATTR = 'data-question-default';
export const QUESTION_MULTI_ATTR = 'data-question-multi';

/** GitHub anchors carry the resolved reference. */
const GITHUB_ATTRS = {
  owner: 'data-gh-owner',
  repo: 'data-gh-repo',
  number: 'data-gh-number',
  kind: 'data-gh-kind',
} as const;

/** Set on every segment of a question once it has been answered. */
export const QUESTION_ANSWERED_ATTR = 'data-answered';

/** Event the thread receives when the user answers a question from its card. */
export const AGENT_QUESTION_ANSWER_EVENT = 'agent-question-answer';

/** Detail of {@link AGENT_QUESTION_ANSWER_EVENT}. */
export interface AgentQuestionAnswerDetail {
  question: string;
  kind: AgentQuestionKind;
  answer: string;
  /** The `data-msg-id` of the agent message that asked. */
  messageId?: string;
}

/** Records the content fingerprint this module last finished processing. */
const PROCESSED_ATTR = 'data-mention-previews';

const SKIP_ALWAYS = new Set([
  'A',
  'PRE',
  'SCRIPT',
  'STYLE',
  'TEXTAREA',
  'BUTTON',
  'SLICC-QUESTION-PROMPT',
]);
const SKIP_INLINE = new Set([...SKIP_ALWAYS, 'CODE', 'KBD', 'SAMP']);

/** Elements a sentence does not cross. */
const BLOCK_SELECTOR = 'p,li,h1,h2,h3,h4,h5,h6,td,th,blockquote,dd,dt,figcaption';

const timeMentions = new WeakMap<Element, TimeMention>();

/** The resolved time behind a decorated `.time-mention` element. */
export function timeMentionOf(el: Element): TimeMention | undefined {
  return timeMentions.get(el);
}

/** The GitHub reference behind a decorated anchor. */
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

/** Inputs to one decoration pass. */
export interface DecorateContext {
  /** `owner/repo` slugs the turn named before this message, oldest first. */
  repoHints: readonly string[];
  /** Last-resort repository lookup (the touched checkout's git remote). */
  resolveRepoFallback?: () => Promise<string | null>;
  /** Loads the time parser; absent disables time detection. */
  getTimeParser?: () => Promise<TimeParser>;
  timeContext?: TimeContext;
  /** Detect questions (agent prose only). */
  questions?: boolean;
  /** Model parser; the sentence detector is used when absent or unavailable. */
  getQuestionParser?: () => AgentQuestionParser;
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

/**
 * Replace `[start, end)` ranges of a text node with elements built by `make`.
 * Ranges must be sorted and non-overlapping.
 */
function wrapRanges(
  node: Text,
  ranges: ReadonlyArray<{ start: number; end: number }>,
  make: (text: string, index: number) => HTMLElement
): HTMLElement[] {
  const made: HTMLElement[] = [];
  // Right to left, so earlier offsets stay valid as the node is split.
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

/** Mark markdown's web links for a link preview. */
function markLinks(root: HTMLElement): void {
  for (const a of root.querySelectorAll<HTMLAnchorElement>('a[href]')) {
    if (a.hasAttribute(PREVIEW_ATTR)) continue;
    if (a.closest('pre')) continue;
    if (!/^https?:\/\//i.test(a.getAttribute('href') ?? '')) continue;
    a.setAttribute(PREVIEW_ATTR, 'link');
  }
}

let questionCounter = 0;

interface MarkedQuestion {
  start: number;
  end: number;
  text: string;
  kind: AgentQuestionKind | 'choice';
  options: string[];
  defaultIndex: number | null;
  multiSelect: boolean;
}

interface QuestionTextSpan {
  node: Text;
  block: Element;
  start: number;
  end: number;
}

function modelQuestion(q: PredictedQuestion): MarkedQuestion {
  const options = q.options.filter(Boolean);
  return {
    start: q.span[0],
    end: q.span[1],
    text: q.prompt,
    kind:
      options.length >= 2
        ? 'choice'
        : q.kind === 'yes_no'
          ? 'yes-no'
          : (classifyQuestion(q.prompt) ?? 'text'),
    options,
    defaultIndex: q.default,
    multiSelect: q.multiSelect,
  };
}

function questionText(root: HTMLElement): { text: string; spans: QuestionTextSpan[] } {
  let text = '';
  let previousBlock: Element | null = null;
  const spans: QuestionTextSpan[] = [];
  for (const node of textNodes(root, SKIP_ALWAYS, AGENT_QUESTION_CLASS)) {
    const block =
      node.parentElement?.closest('li') ?? node.parentElement?.closest(BLOCK_SELECTOR) ?? root;
    if (previousBlock && block !== previousBlock) text += '\n';
    if (block.tagName === 'LI' && block !== previousBlock) text += '- ';
    previousBlock = block;
    const start = text.length;
    text += node.data;
    spans.push({ node, block, start, end: text.length });
  }
  return { text, spans };
}

function addQuestion(root: HTMLElement, spans: QuestionTextSpan[], q: MarkedQuestion): void {
  const pieces = spans.filter(({ start, end }) => q.start < end && q.end > start);
  if (pieces.length === 0) return;
  const id = questionIdFor(q.start, root);
  for (const { node, start, end } of pieces) {
    if (!node.isConnected) continue;
    const from = Math.max(q.start, start);
    const to = Math.min(q.end, end);
    wrapRanges(node, [{ start: from - start, end: to - start }], () => {
      const span = node.ownerDocument.createElement('span');
      span.className = AGENT_QUESTION_CLASS;
      span.setAttribute(PREVIEW_ATTR, 'question');
      span.setAttribute(QUESTION_ID_ATTR, id);
      span.setAttribute(QUESTION_TEXT_ATTR, q.text);
      span.setAttribute(QUESTION_KIND_ATTR, q.kind);
      if (pieces[0]?.node === node) span.tabIndex = 0;
      return span;
    });
  }
  const prompt = root.ownerDocument.createElement('slicc-question-prompt');
  prompt.setAttribute(QUESTION_CONTROLS_ATTR, id);
  prompt.setAttribute('inline', '');
  prompt.setAttribute('question', q.text);
  prompt.setAttribute('kind', q.kind);
  prompt.setAttribute(QUESTION_OPTIONS_ATTR, JSON.stringify(q.options));
  if (q.defaultIndex !== null) prompt.setAttribute(QUESTION_DEFAULT_ATTR, String(q.defaultIndex));
  if (q.multiSelect) prompt.setAttribute(QUESTION_MULTI_ATTR, '');
  const lastBlock = pieces[pieces.length - 1]?.block;
  if (lastBlock === root || lastBlock?.tagName === 'LI') lastBlock.append(prompt);
  else lastBlock?.after(prompt);
}

/** Mark detected spans and keep their answer metadata beside them for hover cards. */
async function markQuestions(root: HTMLElement, ctx: DecorateContext): Promise<void> {
  if (root.querySelector(`.${AGENT_QUESTION_CLASS}`)) return;
  const { text, spans } = questionText(root);
  if (!/[?？]/.test(text) && (!ctx.getQuestionParser || !/:\s*\n/.test(text))) return;
  let questions: MarkedQuestion[];
  if (ctx.getQuestionParser) {
    try {
      questions = (await ctx.getQuestionParser().parse(text)).map(modelQuestion);
    } catch {
      questions = findAgentQuestions(text).map((q) => ({
        ...q,
        options: [],
        defaultIndex: null,
        multiSelect: false,
      }));
    }
  } else {
    questions = findAgentQuestions(text).map((q) => ({
      ...q,
      options: [],
      defaultIndex: null,
      multiSelect: false,
    }));
  }
  if (!root.isConnected) return;
  for (const q of questions.reverse()) addQuestion(root, spans, q);
}

const questionIds = new WeakMap<Element, Map<number, string>>();

/** A stable id per question (its offset within its block). */
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

/** Link every GitHub reference whose repository can be determined. */
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
    // The message may have re-rendered while the fallback was read.
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

/** Highlight every confident date/time expression. */
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

/**
 * Decorate `root` with every preview this module knows. Resolves once all
 * decoration (including the async time pass) has landed; callers may ignore
 * the promise. Never rejects — a failed detector leaves its text alone.
 */
export function decorateMentions(
  root: HTMLElement,
  ctx: DecorateContext,
  onError: (step: string, err: unknown) => void = () => {}
): Promise<void> {
  // One pass per root at a time. A request that arrives mid-pass (the body
  // mutated while the time parser ran) is folded into ONE follow-up pass, so
  // a burst of mutations never runs the parser more than twice.
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

  // Questions first: they wrap whole sentences, and the inline passes below
  // then nest inside those wrappers — so hovering a date inside a question
  // shows the date, and hovering the rest of the sentence shows the question.
  await step('links', () => markLinks(root));
  if (ctx.questions) await step('questions', () => markQuestions(root, ctx));
  await step('github', () => markGithub(root, ctx));
  await step('times', () => markTimes(root, ctx));

  root.setAttribute(PROCESSED_ATTR, contentFingerprint(root));
}
