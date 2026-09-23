/**
 * Wiring hover previews into the live transcript: link cards, GitHub issue/PR
 * cards, date/time cards, and answerable agent questions.
 *
 * Decoration (`ui/mention-previews.ts`) marks what has a preview; this module
 * owns the lifecycle around it — which messages to decorate and when, what
 * context each one gets (the repositories the turn named, the time parser),
 * and the ONE shared `<slicc-hover-card>` that shows a preview on hover.
 *
 * Wired from `buildWcShellFrame`, like `wire-base64-previews.ts`, because
 * nothing here needs a client: Cherry, the tray follower and the extension side
 * panel get previews too. The one VFS-backed input — reading a checkout's git
 * remote to infer a repository — is attached later, by the floats that have a
 * VFS, through {@link attachMentionPreviewFs}.
 *
 * ## Only finished agent messages
 *
 * Streaming bubbles are skipped (half a sentence is not a question, half a date
 * resolves wrong), and so are user bubbles — the user does not need their own
 * questions answered, and their links already sit in text they wrote.
 *
 * ## Which questions can be answered
 *
 * Only a question in the LATEST agent message, before the user has replied,
 * in a transcript the user can write to. Everything else still shows its card,
 * inert, with the reason. Answering dispatches {@link AGENT_QUESTION_ANSWER_EVENT}
 * on the thread; the chat controller turns that into a lick for the cone.
 */

import {
  type QuestionAnswerDetail,
  type QuestionState,
  SliccHoverCard,
  type TimePreviewData,
} from '@slicc/webcomponents';
import { GitRemoteRepoResolver } from '../../core/git-remote-repo.js';
import { githubRefUrl, githubRepoHints } from '../../core/github-mentions.js';
import { currentTimeContext, loadTimeParser, type TimeParser } from '../../core/time-mentions.js';
import { parsePathHints, TOOL_PATH_HINTS_ATTR } from '../../core/tool-call-paths.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  githubPreview,
  type LinkPreview,
  LinkPreviewFetcher,
  type PreviewFetch,
} from '../link-preview-fetcher.js';
import {
  AGENT_QUESTION_ANSWER_EVENT,
  type AgentQuestionAnswerDetail,
  decorateMentions,
  githubRefOf,
  PREVIEW_ATTR,
  type PreviewKind,
  QUESTION_ANSWERED_ATTR,
  QUESTION_KIND_ATTR,
  QUESTION_TEXT_ATTR,
  timeMentionOf,
} from '../mention-previews.js';

export interface MentionPreviewWiringDeps {
  /** The `<slicc-chat-thread>` messages render into. */
  thread: HTMLElement;
  /** The transcript is read-only (a scoop, a thawed session). */
  isReadOnly: () => boolean;
  log: { error(message: string, ...data: unknown[]): void };
  /** The fetch link previews go through; defaults to the proxied fetch. */
  getFetch?: () => PreviewFetch | Promise<PreviewFetch>;
  /** The time parser; defaults to the lazily-loaded `gpu-time` one. */
  getTimeParser?: () => Promise<TimeParser>;
  /** The hover card; defaults to the document's shared one. */
  getCard?: () => SliccHoverCard;
  /** The current instant; tests pin it. */
  now?: () => Date;
  /** Hover intent delay before a card opens. */
  hoverDelayMs?: number;
}

const AGENT_TAG = 'slicc-agent-message';
const USER_TAG = 'slicc-user-message';
const TOOL_ROW_TAG = 'slicc-action-row';
const PREVIEW_SELECTOR = `[${PREVIEW_ATTR}]`;

/** How many earlier transcript elements are searched for repository hints. */
const HINT_LOOKBACK = 40;

/** Text per element scanned for hints; tool output can be huge. */
const HINT_TEXT_CAP = 20_000;

const DEFAULT_HOVER_DELAY_MS = 280;

/** How long an answered card lingers so the confirmation is seen. */
const ANSWERED_LINGER_MS = 900;

/** Per-thread VFS opener, attached by floats that have one. */
const fsOpeners = new WeakMap<HTMLElement, () => Promise<LocalVfsClient>>();

/**
 * Give the wiring on `thread` a VFS, so a bare `#123` can fall back to the git
 * remote of the checkout the turn was working in.
 */
export function attachMentionPreviewFs(
  thread: HTMLElement,
  openFs: () => Promise<LocalVfsClient>
): void {
  fsOpeners.set(thread, openFs);
}

function whenIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(task);
  else setTimeout(task, 0);
}

/** Elements that precede `bubble` in the thread, most recent last. */
function precedingElements(thread: ParentNode, bubble: Element, selector: string): Element[] {
  const out: Element[] = [];
  for (const el of thread.querySelectorAll(selector)) {
    if (el === bubble) break;
    if (bubble.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    out.push(el);
  }
  return out.slice(-HINT_LOOKBACK);
}

function hintTextOf(el: Element): string {
  if (el.tagName.toLowerCase() === USER_TAG) return el.getAttribute('text') ?? '';
  const hrefs = Array.from(el.querySelectorAll('a[href]'), (a) => a.getAttribute('href') ?? '');
  return `${(el.textContent ?? '').slice(0, HINT_TEXT_CAP)} ${hrefs.join(' ')}`;
}

/**
 * The `owner/repo` slugs named before (and in) `bubble`, oldest first — tool
 * calls and their output, earlier messages, and the bubble's own links.
 */
export function collectRepoHints(thread: ParentNode, bubble: Element): string[] {
  const sources = precedingElements(thread, bubble, `${TOOL_ROW_TAG},${AGENT_TAG},${USER_TAG}`);
  const ordered: string[] = [];
  for (const el of [...sources, bubble]) {
    for (const slug of githubRepoHints(hintTextOf(el))) {
      const at = ordered.findIndex((s) => s.toLowerCase() === slug.toLowerCase());
      if (at >= 0) ordered.splice(at, 1);
      ordered.push(slug);
    }
  }
  return ordered;
}

function collectPathHints(thread: ParentNode, bubble: Element): string[] {
  return precedingElements(thread, bubble, `${TOOL_ROW_TAG}[${TOOL_PATH_HINTS_ATTR}]`).flatMap(
    (row) => parsePathHints(row.getAttribute(TOOL_PATH_HINTS_ATTR) ?? '')
  );
}

function defaultFetch(): Promise<PreviewFetch> {
  return import('../../shell/proxied-fetch.js').then(({ createProxiedFetch }) => {
    const secure = createProxiedFetch();
    return (url, options) => secure(url, options);
  });
}

/**
 * Start decorating agent messages in `thread` and showing hover previews.
 * Returns a teardown function. Never throws.
 */
export function wireMentionPreviews(deps: MentionPreviewWiringDeps): () => void {
  try {
    return wireMentionPreviewsUnsafe(deps);
  } catch (err) {
    deps.log.error('Mention preview wiring failed; continuing without it', err);
    return () => {};
  }
}

/** The agent messages a batch of mutations touched. */
function touchedBubbles(records: MutationRecord[]): Set<Element> {
  const touched = new Set<Element>();
  const isAgent = (el: Element | null | undefined): boolean =>
    el?.tagName.toLowerCase() === AGENT_TAG;
  for (const record of records) {
    const target = record.target as HTMLElement | null;
    if (record.type === 'attributes') {
      if (target && isAgent(target)) touched.add(target);
      continue;
    }
    for (const node of record.addedNodes) {
      if (!(node instanceof HTMLElement)) continue;
      if (isAgent(node)) touched.add(node);
      else for (const bubble of node.querySelectorAll(AGENT_TAG)) touched.add(bubble);
    }
    const owner = target?.closest?.(AGENT_TAG);
    if (owner) touched.add(owner);
  }
  return touched;
}

/** Call `process` for every agent message in `thread`, now and as they change. */
function observeAgentMessages(thread: HTMLElement, process: (bubble: Element) => void): () => void {
  for (const bubble of thread.querySelectorAll(AGENT_TAG)) process(bubble);
  const observer = new MutationObserver((records) => {
    for (const bubble of touchedBubbles(records)) process(bubble);
  });
  observer.observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['streaming'],
  });
  return () => observer.disconnect();
}

interface QuestionStatus {
  state: QuestionState;
  note?: string;
  answer?: string;
}

/**
 * Which questions in `thread` can be answered, and the answers already given
 * — keyed by message id + question text so they survive re-renders.
 */
class QuestionAnswers {
  readonly #answered = new Map<string, string>();

  constructor(
    private readonly thread: HTMLElement,
    private readonly isReadOnly: () => boolean
  ) {}

  #key(bubble: Element | null, question: string): string {
    return `${bubble?.getAttribute('data-msg-id') ?? ''}\u0000${question}`;
  }

  /** Reflect given answers onto the question spans of `bubble`. */
  mark(bubble: Element): void {
    for (const span of bubble.querySelectorAll<HTMLElement>(`[${QUESTION_TEXT_ATTR}]`)) {
      const key = this.#key(bubble, span.getAttribute(QUESTION_TEXT_ATTR) ?? '');
      span.toggleAttribute(QUESTION_ANSWERED_ATTR, this.#answered.has(key));
    }
  }

  statusOf(span: Element): QuestionStatus {
    const bubble = span.closest(AGENT_TAG);
    const given = this.#answered.get(
      this.#key(bubble, span.getAttribute(QUESTION_TEXT_ATTR) ?? '')
    );
    if (given !== undefined) return { state: 'answered', answer: given };
    if (this.isReadOnly()) return { state: 'inert', note: 'This conversation is read-only.' };
    if (!bubble || bubble.hasAttribute('streaming')) return { state: 'inert' };
    const agents = this.thread.querySelectorAll(AGENT_TAG);
    if (agents[agents.length - 1] !== bubble) {
      return { state: 'inert', note: 'Only the latest question can be answered here.' };
    }
    for (const user of this.thread.querySelectorAll(USER_TAG)) {
      if (bubble.compareDocumentPosition(user) & Node.DOCUMENT_POSITION_FOLLOWING) {
        return { state: 'inert', note: 'You already replied to this message.' };
      }
    }
    return { state: 'open' };
  }

  /**
   * Record `answer` for `span` and announce it on the thread. Returns false —
   * and records nothing — when the question is no longer answerable.
   */
  answer(span: Element, detail: QuestionAnswerDetail): boolean {
    // Re-check at answer time: a new message may have landed since the card opened.
    if (this.statusOf(span).state !== 'open') return false;
    const bubble = span.closest(AGENT_TAG);
    const question = span.getAttribute(QUESTION_TEXT_ATTR) ?? '';
    this.#answered.set(this.#key(bubble, question), detail.answer);
    if (bubble) this.mark(bubble);
    const messageId = bubble?.getAttribute('data-msg-id');
    const out: AgentQuestionAnswerDetail = {
      question,
      kind: detail.kind,
      answer: detail.answer,
      ...(messageId ? { messageId } : {}),
    };
    this.thread.dispatchEvent(
      new CustomEvent<AgentQuestionAnswerDetail>(AGENT_QUESTION_ANSWER_EVENT, {
        detail: out,
        bubbles: true,
        composed: true,
      })
    );
    return true;
  }
}

function setOrRemove(el: Element, name: string, value: string | undefined): void {
  if (value) el.setAttribute(name, value);
  else el.removeAttribute(name);
}

function applyLinkPreview(
  el: Element,
  preview: Omit<LinkPreview, 'state'> & { state: LinkPreview['state'] | 'loading' }
): void {
  el.setAttribute('url', preview.url);
  el.setAttribute('state', preview.state);
  setOrRemove(el, 'heading', preview.title);
  setOrRemove(el, 'description', preview.description);
  setOrRemove(el, 'image', preview.image);
  setOrRemove(el, 'site', preview.siteName);
  setOrRemove(el, 'badge', preview.badge);
}

/** Builds the hover card content for each kind of decorated anchor. */
interface CardContentContext {
  fetcher: LinkPreviewFetcher;
  questions: QuestionAnswers;
  now: () => Date;
}

function linkContent(
  anchor: HTMLAnchorElement,
  card: SliccHoverCard,
  ctx: CardContentContext
): HTMLElement {
  const el = document.createElement('slicc-link-preview');
  const url = anchor.href;
  applyLinkPreview(el, { url, state: 'loading' });
  void ctx.fetcher.preview(url).then((preview) => {
    if (card.anchor !== anchor) return;
    applyLinkPreview(el, preview);
    card.reposition();
  });
  return el;
}

function githubContent(anchor: HTMLAnchorElement): HTMLElement | null {
  const ref = githubRefOf(anchor);
  if (!ref) return null;
  const preview = githubPreview(githubRefUrl(ref), ref);
  const el = document.createElement('slicc-link-preview');
  applyLinkPreview(el, { ...preview, siteName: preview.siteName ?? 'GitHub' });
  return el;
}

function timeContent(span: Element, ctx: CardContentContext): HTMLElement | null {
  const mention = timeMentionOf(span);
  if (!mention) return null;
  const context = currentTimeContext(ctx.now());
  const el = document.createElement('slicc-time-preview');
  const data: TimePreviewData = {
    text: mention.text,
    reference: context.reference,
    timeZone: context.timeZone,
    occurrences: mention.occurrences,
    rrules: mention.rrules,
  };
  el.data = data;
  return el;
}

function questionContent(
  span: Element,
  card: SliccHoverCard,
  ctx: CardContentContext
): HTMLElement {
  const el = document.createElement('slicc-question-prompt');
  const { state, note, answer } = ctx.questions.statusOf(span);
  el.setAttribute('question', span.getAttribute(QUESTION_TEXT_ATTR) ?? '');
  el.setAttribute('kind', span.getAttribute(QUESTION_KIND_ATTR) ?? 'text');
  el.setAttribute('state', state);
  if (note) el.setAttribute('note', note);
  if (answer !== undefined) el.setAttribute('answer', answer);
  el.addEventListener('question-answer', (event) => {
    const detail = (event as CustomEvent<QuestionAnswerDetail>).detail;
    if (!ctx.questions.answer(span, detail)) return;
    el.setAttribute('answer', detail.answer);
    el.setAttribute('state', 'answered');
    card.scheduleHide(ANSWERED_LINGER_MS);
  });
  return el;
}

function contentFor(
  anchor: HTMLElement,
  card: SliccHoverCard,
  ctx: CardContentContext
): HTMLElement | null {
  const kind = anchor.getAttribute(PREVIEW_ATTR) as PreviewKind | null;
  switch (kind) {
    case 'link':
      return anchor instanceof HTMLAnchorElement ? linkContent(anchor, card, ctx) : null;
    case 'github':
      return anchor instanceof HTMLAnchorElement ? githubContent(anchor) : null;
    case 'time':
      return timeContent(anchor, ctx);
    case 'question':
      return questionContent(anchor, card, ctx);
    default:
      return null;
  }
}

interface HoverTriggerDeps {
  thread: HTMLElement;
  getCard: () => SliccHoverCard;
  content: (anchor: HTMLElement, card: SliccHoverCard) => HTMLElement | null;
  hoverDelay: number;
  log: MentionPreviewWiringDeps['log'];
}

/**
 * Open the shared card on hover (after an intent delay), on focus, and — for
 * questions — on click / Enter, moving focus into the card. Returns a teardown.
 */
function wireHoverTriggers({
  thread,
  getCard,
  content,
  hoverDelay,
  log,
}: HoverTriggerDeps): () => void {
  let pending: { anchor: HTMLElement; timer: ReturnType<typeof setTimeout> } | null = null;
  const cancelPending = (): void => {
    if (pending) clearTimeout(pending.timer);
    pending = null;
  };

  const show = (anchor: HTMLElement, focusContent = false): void => {
    try {
      const card = getCard();
      if (card.anchor === anchor && card.open) {
        card.cancelHide();
        return;
      }
      const el = content(anchor, card);
      if (!el) return;
      card.showFor(anchor, el);
      if (focusContent) requestAnimationFrame(() => el.focus());
    } catch (err) {
      log.error('Mention preview card failed', err);
    }
  };

  const previewTarget = (node: EventTarget | null): HTMLElement | null => {
    if (!(node instanceof Element)) return null;
    const el = node.closest<HTMLElement>(PREVIEW_SELECTOR);
    return el && thread.contains(el) ? el : null;
  };

  const inCard = (node: EventTarget | null): boolean =>
    node instanceof Element && node.closest('slicc-hover-card') !== null;

  const hideIfAnchoredTo = (anchor: HTMLElement): void => {
    const card = getCard();
    if (card.anchor === anchor) card.scheduleHide();
  };

  const questionTarget = (event: Event): HTMLElement | null => {
    const anchor = previewTarget(event.target);
    return anchor?.getAttribute(PREVIEW_ATTR) === 'question' ? anchor : null;
  };

  const handlers: Record<string, (event: Event) => void> = {
    pointerover: (event) => {
      const anchor = previewTarget(event.target);
      if (!anchor || pending?.anchor === anchor) return;
      cancelPending();
      pending = {
        anchor,
        timer: setTimeout(() => {
          pending = null;
          show(anchor);
        }, hoverDelay),
      };
    },
    pointerout: (event) => {
      const anchor = previewTarget(event.target);
      if (!anchor) return;
      const next = (event as PointerEvent).relatedTarget;
      if (next instanceof Node && anchor.contains(next)) return;
      if (pending?.anchor === anchor) cancelPending();
      if (!inCard(next)) hideIfAnchoredTo(anchor);
    },
    focusin: (event) => {
      const anchor = previewTarget(event.target);
      if (anchor) show(anchor);
    },
    focusout: (event) => {
      const anchor = previewTarget(event.target);
      if (anchor && !inCard((event as FocusEvent).relatedTarget)) hideIfAnchoredTo(anchor);
    },
    keydown: (event) => {
      const key = (event as KeyboardEvent).key;
      if (key !== 'Enter' && key !== ' ') return;
      const anchor = questionTarget(event);
      if (!anchor) return;
      event.preventDefault();
      show(anchor, true);
    },
    click: (event) => {
      const anchor = questionTarget(event);
      if (!anchor) return;
      cancelPending();
      show(anchor, true);
    },
  };

  const onCardResize = (): void => getCard().reposition();

  for (const [type, handler] of Object.entries(handlers)) thread.addEventListener(type, handler);
  // The card is document-wide and may be replaced; listen at the document.
  document.addEventListener('link-preview-resize', onCardResize);

  return () => {
    cancelPending();
    for (const [type, handler] of Object.entries(handlers)) {
      thread.removeEventListener(type, handler);
    }
    document.removeEventListener('link-preview-resize', onCardResize);
  };
}

function wireMentionPreviewsUnsafe(deps: MentionPreviewWiringDeps): () => void {
  const { thread, log } = deps;
  if (!(thread instanceof Node)) return () => {};

  const now = deps.now ?? (() => new Date());
  const getTimeParser = deps.getTimeParser ?? loadTimeParser;
  const questions = new QuestionAnswers(thread, deps.isReadOnly);
  const ctx: CardContentContext = {
    fetcher: new LinkPreviewFetcher({ getFetch: deps.getFetch ?? defaultFetch }),
    questions,
    now,
  };
  let remoteResolver: {
    opener: () => Promise<LocalVfsClient>;
    resolver: Promise<GitRemoteRepoResolver>;
  } | null = null;

  const repoFallbackFor = (bubble: Element) => async (): Promise<string | null> => {
    const opener = fsOpeners.get(thread);
    if (!opener) return null;
    if (remoteResolver?.opener !== opener) {
      remoteResolver = { opener, resolver: opener().then((fs) => new GitRemoteRepoResolver(fs)) };
    }
    const paths = collectPathHints(thread, bubble);
    if (paths.length === 0) return null;
    return (await remoteResolver.resolver).repoFor(paths);
  };

  const process = (bubble: Element): void => {
    if (!(bubble instanceof HTMLElement)) return;
    if (bubble.hasAttribute('streaming')) return;
    const body = bubble.querySelector<HTMLElement>('.body') ?? bubble;
    whenIdle(() => {
      if (!body.isConnected) return;
      void decorateMentions(
        body,
        {
          repoHints: collectRepoHints(thread, bubble),
          resolveRepoFallback: repoFallbackFor(bubble),
          getTimeParser,
          timeContext: currentTimeContext(now()),
          questions: true,
        },
        (stepName, err) => log.error(`Mention preview step "${stepName}" failed`, err)
      ).then(() => questions.mark(bubble));
    });
  };

  const stopObserving = observeAgentMessages(thread, process);
  const stopHover = wireHoverTriggers({
    thread,
    getCard: deps.getCard ?? ((): SliccHoverCard => SliccHoverCard.shared(document)),
    content: (anchor, card) => contentFor(anchor, card, ctx),
    hoverDelay: deps.hoverDelayMs ?? DEFAULT_HOVER_DELAY_MS,
    log,
  });

  return () => {
    stopHover();
    stopObserving();
  };
}
