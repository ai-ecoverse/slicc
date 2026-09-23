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
 * A link that already points at an image previews itself. A GitHub issue or
 * pull request URL previews from GitHub's rendered card image, whose address is
 * derivable from the URL — no page fetch.
 */

import {
  type GithubRef,
  githubCardImage,
  githubRefLabel,
  parseGithubUrl,
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
  options?: { method?: string; headers?: Record<string, string> }
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

/** The preview for a GitHub issue or PR, with no network involved. */
export function githubPreview(url: string, ref: GithubRef): LinkPreview {
  return {
    url,
    state: 'ready',
    title: `${ref.owner}/${ref.repo}#${ref.number}`,
    image: githubCardImage(ref),
    siteName: 'GitHub',
    badge: githubRefLabel(ref),
  };
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

    const ref = parseGithubUrl(url);
    if (ref) return githubPreview(url, ref);

    if (IMAGE_EXT_RE.test(parsed.pathname)) {
      return { url, state: 'ready', image: parsed.href, title: parsed.pathname.split('/').pop() };
    }

    const fetchFn = await this.#getFetch();
    const res = await this.#withTimeout(
      fetchFn(parsed.href, {
        method: 'GET',
        headers: { accept: 'text/html,application/xhtml+xml;q=0.9,image/*;q=0.8,*/*;q=0.5' },
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

  #withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('link preview timed out')), this.#timeoutMs);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }
}
