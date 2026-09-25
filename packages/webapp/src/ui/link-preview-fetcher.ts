/**
 * Building the hover preview for a link: its `og:image`, title and blurb.
 *
 * ## Only on hover
 *
 * Rendering a link fetches nothing. The first HOVER does, once, and the answer
 * is cached for the life of the page — so the third-party request happens only
 * when the user has shown interest, and never merely because an agent wrote a
 * URL.
 *
 * ## Through the proxied fetch
 *
 * A page realm cannot read another origin's HTML, so the request goes through
 * the same `createProxiedFetch` route `curl` uses (the `/api/fetch-proxy` bridge
 * on the CLI, host permissions in the extension). Injected rather than imported
 * so tests, and floats with no route at all, can supply their own.
 *
 * ## No request where none is needed
 *
 * A link that already points at an image previews itself. A github.com page —
 * a repository, an issue, a pull request, a discussion, a project board, a
 * commit, a release — previews from GitHub's own rendered card image, whose
 * address is derivable from the URL. No page fetch, so the rich card shows up
 * even in a float with no fetch route at all, where the generic host-only card
 * used to be the best anything could do. Resource-serving routes
 * (`/raw/…`, `/releases/download/…`) are not pages: they decline a card so an
 * image URL still previews itself, while a `/blob/…/image.png` page keeps the
 * repository card.
 */

import {
  type GithubCard,
  type GithubRef,
  githubCardFor,
  githubRefCard,
} from '../core/github-mentions.js';
import { parseOpenGraph } from '../core/og-meta.js';

/** What a hover card shows for a link. */
export interface LinkPreview {
  url: string;
  state: 'ready' | 'error';
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  badge?: string;
}

/** The subset of `SecureFetch` this needs. */
export type PreviewFetch = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array; url?: string }>;

export interface LinkPreviewFetcherOptions {
  /** Resolves the fetch to use, lazily — nothing is built until the first hover. */
  getFetch: () => PreviewFetch | Promise<PreviewFetch>;
  /** Give up on a page after this long. */
  timeoutMs?: number;
  /** How many previews to remember. */
  maxEntries?: number;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

/** Bytes of a page decoded for the head scan; `og:` tags live well inside it. */
const MAX_HTML_BYTES = 512 * 1024;

/**
 * The most a preview may download. The proxied fetch buffers a whole body
 * before handing it over, so this must be enforced by the fetch itself (see
 * `maxResponseBytes`), not by slicing afterwards. A page larger than this gets
 * no card, which beats a hover pulling down a multi-megabyte response.
 */
export const LINK_PREVIEW_MAX_BYTES = 2 * 1024 * 1024;

const DEFAULT_TIMEOUT_MS = 8000;
const DEFAULT_MAX_ENTRIES = 200;

function isWebUrl(url: string): URL | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed : null;
  } catch {
    return null;
  }
}

function header(headers: Record<string, string>, name: string): string {
  return headers[name] ?? headers[name.toLowerCase()] ?? '';
}

/** A derived GitHub card as a preview. */
function cardPreview(url: string, card: GithubCard): LinkPreview {
  return {
    url,
    state: 'ready',
    title: card.title,
    image: card.image,
    siteName: 'GitHub',
    badge: card.badge,
  };
}

/** The preview for a GitHub issue or PR reference, with no network involved. */
export function githubPreview(url: string, ref: GithubRef): LinkPreview {
  return cardPreview(url, githubRefCard(ref));
}

/**
 * Fetches and caches link previews. One instance per transcript surface.
 */
export class LinkPreviewFetcher {
  readonly #getFetch: LinkPreviewFetcherOptions['getFetch'];
  readonly #timeoutMs: number;
  readonly #maxEntries: number;
  readonly #cache = new Map<string, Promise<LinkPreview>>();

  constructor(options: LinkPreviewFetcherOptions) {
    this.#getFetch = options.getFetch;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  }

  /** The cached preview for `url`, if one has already settled or is in flight. */
  peek(url: string): Promise<LinkPreview> | undefined {
    return this.#cache.get(url);
  }

  /** Preview `url`. Never rejects: a failure is an `error`-state preview. */
  preview(url: string): Promise<LinkPreview> {
    const cached = this.#cache.get(url);
    if (cached) return cached;
    const pending = this.#build(url).catch((): LinkPreview => ({ url, state: 'error' }));
    this.#cache.set(url, pending);
    if (this.#cache.size > this.#maxEntries) {
      const oldest = this.#cache.keys().next().value;
      if (oldest !== undefined) this.#cache.delete(oldest);
    }
    return pending;
  }

  async #build(url: string): Promise<LinkPreview> {
    const parsed = isWebUrl(url);
    if (!parsed) return { url, state: 'error' };

    const github = githubCardFor(url);
    if (github) return cardPreview(url, github);

    if (IMAGE_EXT_RE.test(parsed.pathname)) {
      return { url, state: 'ready', image: parsed.href, title: parsed.pathname.split('/').pop() };
    }

    const fetchFn = await this.#getFetch();
    const res = await this.#withTimeout((signal) =>
      fetchFn(parsed.href, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5' },
        signal,
      })
    );
    if (res.status < 200 || res.status >= 300) return { url, state: 'error' };

    const type = header(res.headers, 'content-type').toLowerCase();
    if (type.startsWith('image/')) {
      return { url, state: 'ready', image: parsed.href, title: parsed.pathname.split('/').pop() };
    }
    if (!type.includes('html')) return { url, state: 'error' };

    const html = new TextDecoder().decode(res.body.subarray(0, MAX_HTML_BYTES));
    const card = parseOpenGraph(html, res.url || parsed.href);
    if (!card.title && !card.image && !card.description) return { url, state: 'error' };
    return { url, state: 'ready', ...card };
  }

  /** Run `start` with a signal that aborts the request itself once the timeout fires. */
  #withTimeout<T>(start: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        controller.abort();
        reject(new Error('link preview timed out'));
      }, this.#timeoutMs);
    });
    return Promise.race([start(controller.signal), timeout]).finally(() => clearTimeout(timer));
  }
}
