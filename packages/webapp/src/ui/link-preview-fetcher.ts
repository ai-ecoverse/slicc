import {
  type GithubCard,
  type GithubRef,
  githubCardFor,
  githubRefCard,
} from '../core/github-mentions.js';
import { parseOpenGraph } from '../core/og-meta.js';

export interface LinkPreview {
  url: string;
  state: 'ready' | 'error';
  title?: string;
  description?: string;
  image?: string;
  siteName?: string;
  badge?: string;
}

export type PreviewFetch = (
  url: string,
  options?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => Promise<{ status: number; headers: Record<string, string>; body: Uint8Array; url?: string }>;

export interface LinkPreviewFetcherOptions {
  getFetch: () => PreviewFetch | Promise<PreviewFetch>;

  timeoutMs?: number;

  maxEntries?: number;
}

const IMAGE_EXT_RE = /\.(png|jpe?g|gif|webp|avif|svg|bmp|ico)$/i;

const MAX_HTML_BYTES = 512 * 1024;

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

export function githubPreview(url: string, ref: GithubRef): LinkPreview {
  return cardPreview(url, githubRefCard(ref));
}

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

  peek(url: string): Promise<LinkPreview> | undefined {
    return this.#cache.get(url);
  }

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
