import type { CDPPayload } from '@slicc/shared-ts';

import type { CDPTransport } from '../cdp/transport.js';
import type {
  InterceptingOAuthLauncher,
  InterceptOAuthConfig,
  OAuthRequestRewrite,
} from './types.js';

const DEFAULT_TIMEOUT_MS = 120_000;

interface InterceptOAuthConfigInput {
  authorizeUrl?: unknown;
  redirectUriPattern?: unknown;
  onCapture?: unknown;
  timeoutMs?: unknown;
  rewrite?: unknown;
}

interface OAuthRequestRewriteInput {
  match?: unknown;
  replaceUrl?: unknown;
  appendParams?: unknown;
}

export function parseInterceptOAuthConfig(
  data: unknown
): { ok: true; config: InterceptOAuthConfig } | { ok: false; error: string } {
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    return { ok: false, error: 'expected a JSON object' };
  }
  const d = data as InterceptOAuthConfigInput;

  if (typeof d.authorizeUrl !== 'string' || d.authorizeUrl.length === 0) {
    return { ok: false, error: 'authorizeUrl must be a non-empty string' };
  }
  if (typeof d.redirectUriPattern !== 'string' || d.redirectUriPattern.length === 0) {
    return { ok: false, error: 'redirectUriPattern must be a non-empty string' };
  }
  if (d.onCapture !== undefined && d.onCapture !== 'close' && d.onCapture !== 'leave') {
    return { ok: false, error: 'onCapture must be "close" or "leave"' };
  }
  if (d.timeoutMs !== undefined && (typeof d.timeoutMs !== 'number' || d.timeoutMs <= 0)) {
    return { ok: false, error: 'timeoutMs must be a positive number' };
  }

  const rewriteResult = validateRewrites(d.rewrite);
  if (!rewriteResult.ok) return rewriteResult;

  const onCapture = d.onCapture === 'close' || d.onCapture === 'leave' ? d.onCapture : undefined;
  const timeoutMs = typeof d.timeoutMs === 'number' ? d.timeoutMs : undefined;

  return {
    ok: true,
    config: {
      authorizeUrl: d.authorizeUrl,
      redirectUriPattern: d.redirectUriPattern,
      rewrite: rewriteResult.rewrites,
      onCapture,
      timeoutMs,
    },
  };
}

function validateRewrites(
  raw: unknown
): { ok: true; rewrites: OAuthRequestRewrite[] | undefined } | { ok: false; error: string } {
  if (raw === undefined) return { ok: true, rewrites: undefined };
  if (!Array.isArray(raw)) return { ok: false, error: 'rewrite must be an array' };
  const out: OAuthRequestRewrite[] = [];
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i];
    if (typeof item !== 'object' || item === null) {
      return { ok: false, error: `rewrite[${i}] must be an object` };
    }
    const r = item as OAuthRequestRewriteInput;
    if (typeof r.match !== 'string' || r.match.length === 0) {
      return { ok: false, error: `rewrite[${i}].match must be a non-empty string` };
    }
    if (r.replaceUrl !== undefined && typeof r.replaceUrl !== 'string') {
      return { ok: false, error: `rewrite[${i}].replaceUrl must be a string when present` };
    }
    let appendParams: Record<string, string> | undefined;
    if (r.appendParams !== undefined) {
      const appendResult = parseAppendParams(r.appendParams, i);
      if (!appendResult.ok) return appendResult;
      appendParams = appendResult.appendParams;
    }
    const replaceUrl = typeof r.replaceUrl === 'string' ? r.replaceUrl : undefined;
    out.push({
      match: r.match,
      appendParams,
      replaceUrl,
    });
  }
  return { ok: true, rewrites: out };
}

function parseAppendParams(
  raw: unknown,
  index: number
): { ok: true; appendParams: Record<string, string> } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: `rewrite[${index}].appendParams must be an object` };
  }
  const appendParams: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== 'string') {
      return { ok: false, error: `rewrite[${index}].appendParams.${k} must be a string` };
    }
    appendParams[k] = v;
  }
  return { ok: true, appendParams };
}

interface FetchRequestPausedEvent {
  requestId: string;
  request: { url: string; method: string; headers: Record<string, string> };
  resourceType?: string;
  frameId?: string;
}

function readFetchRequestPausedEvent(params: CDPPayload): FetchRequestPausedEvent | null {
  const requestId = params['requestId'];
  const request = params['request'];
  if (typeof requestId !== 'string') return null;
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return null;
  const requestRecord = request as { url?: unknown; method?: unknown; headers?: unknown };
  if (typeof requestRecord.url !== 'string' || typeof requestRecord.method !== 'string') {
    return null;
  }
  const headers =
    typeof requestRecord.headers === 'object' &&
    requestRecord.headers !== null &&
    !Array.isArray(requestRecord.headers)
      ? (requestRecord.headers as Record<string, string>)
      : {};
  return {
    requestId,
    request: {
      url: requestRecord.url,
      method: requestRecord.method,
      headers,
    },
    resourceType: typeof params['resourceType'] === 'string' ? params['resourceType'] : undefined,
    frameId: typeof params['frameId'] === 'string' ? params['frameId'] : undefined,
  };
}

interface CreateTargetResult {
  targetId: string;
}

interface AttachToTargetResult {
  sessionId: string;
}

function matchesPattern(url: string, pattern: string): boolean {
  if (pattern.endsWith('*')) {
    return url.startsWith(pattern.slice(0, -1));
  }
  return url === pattern || url.startsWith(`${pattern}?`) || url.startsWith(`${pattern}#`);
}

function toFetchUrlPattern(pattern: string): string {
  if (pattern.endsWith('*')) return pattern;
  return `${pattern}*`;
}

export function applyRewrites(url: string, rewrites: OAuthRequestRewrite[] | undefined): string {
  if (!rewrites || rewrites.length === 0) return url;
  let current = url;
  for (const rule of rewrites) {
    if (!current.includes(rule.match)) continue;
    if (rule.replaceUrl) {
      current = rule.replaceUrl;
      continue;
    }
    if (rule.appendParams) {
      try {
        const parsed = new URL(current);
        for (const [k, v] of Object.entries(rule.appendParams)) {
          parsed.searchParams.set(k, v);
        }
        current = parsed.toString();
      } catch {}
    }
  }
  return current;
}

export function createInterceptingOAuthLauncher(
  transport: CDPTransport
): InterceptingOAuthLauncher {
  return async (config: InterceptOAuthConfig) => {
    const timeoutMs = config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const rewrites = config.rewrite ?? [];
    const onCapture = config.onCapture ?? 'close';

    let targetId: string | undefined;
    let sessionId: string | undefined;
    let resolved = false;
    let captured: string | null = null;

    const cleanup = async () => {
      if (sessionId) {
        try {
          await transport.send('Fetch.disable', {}, sessionId);
        } catch {}

        try {
          await transport.send('Target.detachFromTarget', { sessionId });
        } catch {}
      }
      if (targetId && onCapture === 'close') {
        try {
          await transport.send('Target.closeTarget', { targetId });
        } catch {}
      }
    };

    return await new Promise<string | null>((resolve) => {
      const finish = async (url: string | null) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(timer);
        transport.off('Fetch.requestPaused', onPaused);
        await cleanup();
        resolve(url);
      };

      const onPaused = (params: CDPPayload) => {
        const evt = readFetchRequestPausedEvent(params);
        if (!evt?.request.url || !sessionId) return;

        const eventSessionId =
          typeof params['sessionId'] === 'string' ? params['sessionId'] : undefined;
        if (eventSessionId !== sessionId) return;

        if (matchesPattern(evt.request.url, config.redirectUriPattern)) {
          captured = evt.request.url;

          transport
            .send(
              'Fetch.failRequest',
              { requestId: evt.requestId, errorReason: 'Aborted' },
              sessionId
            )
            .catch(() => {});
          void finish(captured).catch(() => {});
          return;
        }

        const rewritten = applyRewrites(evt.request.url, rewrites);
        if (rewritten !== evt.request.url) {
          transport
            .send('Fetch.continueRequest', { requestId: evt.requestId, url: rewritten }, sessionId)
            .catch((err: unknown) => {
              console.warn(
                '[intercepted-oauth] continueRequest (rewrite) failed:',
                err instanceof Error ? err.message : String(err)
              );
            });
          return;
        }

        transport
          .send('Fetch.continueRequest', { requestId: evt.requestId }, sessionId)
          .catch(() => {});
      };

      const timer = setTimeout(() => {
        void finish(null).catch(() => {});
      }, timeoutMs);

      const runSetup = async (): Promise<void> => {
        const created = (await transport.send('Target.createTarget', {
          url: 'about:blank',
        })) as unknown as CreateTargetResult;
        targetId = created.targetId;

        const attached = (await transport.send('Target.attachToTarget', {
          targetId,
          flatten: true,
        })) as unknown as AttachToTargetResult;
        sessionId = attached.sessionId;

        transport.on('Fetch.requestPaused', onPaused);
        await transport.send(
          'Fetch.enable',
          {
            patterns: [
              {
                urlPattern: toFetchUrlPattern(config.redirectUriPattern),
                requestStage: 'Request',
              },

              ...rewrites.map((r) => ({ urlPattern: `*${r.match}*`, requestStage: 'Request' })),
            ],
          },
          sessionId
        );

        await transport.send('Page.navigate', { url: config.authorizeUrl }, sessionId);
      };

      void runSetup().catch((err: unknown) => {
        console.error(
          '[intercepted-oauth] setup failed:',
          err instanceof Error ? err.message : String(err)
        );
        void finish(null).catch(() => {});
      });
    });
  };
}
