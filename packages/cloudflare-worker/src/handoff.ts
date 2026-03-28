import { jsonResponse } from './shared.js';

export interface GenericHandoffPayload {
  title?: string;
  instruction: string;
  urls?: string[];
  context?: string;
  acceptanceCriteria?: string[];
  notes?: string;
  openUrlsFirst?: boolean;
}

export interface StoredHandoffRecord {
  handoffId: string;
  createdAt: string;
  expiresAt: string;
  payload: GenericHandoffPayload;
}

export interface CreateHandoffResponse {
  handoffId: string;
  url: string;
  jsonUrl: string;
  expiresAt: string;
}

export interface R2GetResultLike {
  text(): Promise<string>;
}

export interface R2BucketLike {
  put(
    key: string,
    value: string | ArrayBuffer | ArrayBufferView,
    options?: {
      httpMetadata?: { contentType?: string };
      customMetadata?: Record<string, string>;
    }
  ): Promise<void>;
  get(key: string): Promise<R2GetResultLike | null>;
}

export interface HandoffEnv {
  HANDOFFS: R2BucketLike;
  HANDOFFS_NOW?: () => number;
}

const HANDOFF_TTL_MS = 86400000;
const MAX_HANDOFF_BYTES = 65536;
const MAX_TITLE_LENGTH = 160;
const MAX_URLS = 100;

const EXTENSION_ID = 'akggccfpkleihhemkkikggopnifgelbk';
const EXTENSION_INSTALL_URL =
  'https://chromewebstore.google.com/detail/slicc/akggccfpkleihhemkkikggopnifgelbk';

export async function handleCreateHandoff(request: Request, env: HandoffEnv): Promise<Response> {
  const now = env.HANDOFFS_NOW?.() ?? Date.now();
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return jsonResponse(
      {
        error: 'Handoff body must be valid JSON.',
        code: 'HANDOFF_INVALID_JSON',
      },
      400
    );
  }

  const validation = validateHandoffPayload(body);
  if (!validation.ok) {
    return jsonResponse(
      {
        error: validation.error,
        code: 'HANDOFF_INVALID_PAYLOAD',
      },
      400
    );
  }

  const payload = validation.value;
  const serializedPayload = JSON.stringify(payload);
  if (new TextEncoder().encode(serializedPayload).byteLength > MAX_HANDOFF_BYTES) {
    return jsonResponse(
      {
        error: `Handoff payload exceeds ${MAX_HANDOFF_BYTES} bytes.`,
        code: 'HANDOFF_PAYLOAD_TOO_LARGE',
      },
      413
    );
  }

  const handoffId = createHandoffId();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + HANDOFF_TTL_MS).toISOString();
  const record: StoredHandoffRecord = {
    handoffId,
    createdAt,
    expiresAt,
    payload,
  };

  await env.HANDOFFS.put(handoffObjectKey(handoffId), JSON.stringify(record), {
    httpMetadata: { contentType: 'application/json; charset=utf-8' },
    customMetadata: { expiresAt },
  });

  const url = new URL(request.url);
  const response: CreateHandoffResponse = {
    handoffId,
    url: new URL(`/handoffs/${handoffId}`, url.origin).toString(),
    jsonUrl: new URL(`/handoffs/${handoffId}.json`, url.origin).toString(),
    expiresAt,
  };

  return jsonResponse(response, 201);
}

export async function handleGetHandoffPage(request: Request, handoffId: string): Promise<Response> {
  const url = new URL(request.url);
  const html = buildRelayHtml({
    handoffId,
    jsonUrl: new URL(`/handoffs/${handoffId}.json`, url.origin).toString(),
    installUrl: EXTENSION_INSTALL_URL,
    extensionId: EXTENSION_ID,
  });

  return new Response(html, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

export async function handleGetHandoffJson(handoffId: string, env: HandoffEnv): Promise<Response> {
  const now = env.HANDOFFS_NOW?.() ?? Date.now();
  const object = await env.HANDOFFS.get(handoffObjectKey(handoffId));
  if (!object) {
    return jsonResponse(
      {
        error: 'Handoff not found.',
        code: 'HANDOFF_NOT_FOUND',
      },
      404
    );
  }

  let record: StoredHandoffRecord;
  try {
    record = JSON.parse(await object.text()) as StoredHandoffRecord;
  } catch {
    return jsonResponse(
      {
        error: 'Stored handoff is unreadable.',
        code: 'HANDOFF_STORAGE_CORRUPT',
      },
      500
    );
  }

  if (isExpired(record, now)) {
    return jsonResponse(
      {
        error: 'Handoff expired.',
        code: 'HANDOFF_EXPIRED',
        expiresAt: record.expiresAt,
      },
      410
    );
  }

  return jsonResponse(record, 200);
}

export function createHandoffId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}

export function handoffObjectKey(handoffId: string): string {
  return `handoffs/${handoffId}.json`;
}

export function isExpired(
  record: Pick<StoredHandoffRecord, 'expiresAt'>,
  now = Date.now()
): boolean {
  const expiresAt = Date.parse(record.expiresAt);
  return Number.isFinite(expiresAt) && now > expiresAt;
}

function validateHandoffPayload(
  payload: unknown
): { ok: true; value: GenericHandoffPayload } | { ok: false; error: string } {
  if (!isPlainObject(payload)) {
    return { ok: false, error: 'Handoff payload must be an object.' };
  }

  const allowedKeys = new Set([
    'title',
    'instruction',
    'urls',
    'context',
    'acceptanceCriteria',
    'notes',
    'openUrlsFirst',
  ]);
  for (const key of Object.keys(payload)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, error: `Unsupported handoff field: ${key}.` };
    }
  }

  const title = payload.title;
  if (title !== undefined) {
    if (typeof title !== 'string' || title.trim().length === 0) {
      return { ok: false, error: 'title must be a non-empty string when provided.' };
    }
    if (title.length > MAX_TITLE_LENGTH) {
      return { ok: false, error: `title must be ${MAX_TITLE_LENGTH} characters or fewer.` };
    }
  }

  const instruction = payload.instruction;
  if (typeof instruction !== 'string' || instruction.trim().length === 0) {
    return { ok: false, error: 'instruction is required.' };
  }

  const urls = payload.urls;
  if (urls !== undefined) {
    if (!Array.isArray(urls)) {
      return { ok: false, error: 'urls must be an array of strings when provided.' };
    }
    if (urls.length > MAX_URLS) {
      return { ok: false, error: `urls must contain ${MAX_URLS} items or fewer.` };
    }
    for (const value of urls) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return { ok: false, error: 'urls must only contain non-empty strings.' };
      }
      try {
        const parsed = new URL(value);
        if (!['http:', 'https:'].includes(parsed.protocol)) {
          return { ok: false, error: 'urls must use http or https.' };
        }
      } catch {
        return { ok: false, error: `Invalid url: ${value}` };
      }
    }
  }

  const context = payload.context;
  if (context !== undefined) {
    if (typeof context !== 'string') {
      return { ok: false, error: 'context must be a string when provided.' };
    }
  }

  const acceptanceCriteria = payload.acceptanceCriteria;
  if (acceptanceCriteria !== undefined) {
    if (!Array.isArray(acceptanceCriteria)) {
      return {
        ok: false,
        error: 'acceptanceCriteria must be an array of strings when provided.',
      };
    }
    for (const value of acceptanceCriteria) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        return {
          ok: false,
          error: 'acceptanceCriteria must only contain non-empty strings.',
        };
      }
    }
  }

  const notes = payload.notes;
  if (notes !== undefined) {
    if (typeof notes !== 'string') {
      return { ok: false, error: 'notes must be a string when provided.' };
    }
  }

  const openUrlsFirst = payload.openUrlsFirst;
  if (openUrlsFirst !== undefined && typeof openUrlsFirst !== 'boolean') {
    return { ok: false, error: 'openUrlsFirst must be a boolean when provided.' };
  }

  return {
    ok: true,
    value: {
      title: title?.trim(),
      instruction: instruction.trim(),
      urls: urls?.map((value) => value.trim()),
      context,
      acceptanceCriteria: acceptanceCriteria?.map((value) => value.trim()),
      notes,
      openUrlsFirst,
    },
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function buildRelayHtml(options: {
  handoffId: string;
  jsonUrl: string;
  installUrl: string;
  extensionId: string;
}): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>SLICC Handoff</title>
    <style>
      :root {
        color-scheme: light dark;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      body {
        margin: 0;
        min-height: 100vh;
        background: #0b1020;
        color: #f2f4f8;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .card {
        width: min(720px, 100%);
        background: rgba(10, 16, 32, 0.92);
        border: 1px solid rgba(148, 163, 184, 0.2);
        border-radius: 20px;
        padding: 24px;
        box-shadow: 0 24px 60px rgba(2, 6, 23, 0.45);
      }
      h1 {
        margin: 0 0 8px;
        font-size: 24px;
      }
      p {
        margin: 0 0 12px;
        color: #cbd5e1;
        line-height: 1.5;
      }
      .status {
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 12px 0 18px;
        padding: 8px 12px;
        border-radius: 999px;
        background: rgba(59, 130, 246, 0.16);
        color: #bfdbfe;
        font-size: 14px;
        font-weight: 600;
      }
      .status--error {
        background: rgba(248, 113, 113, 0.16);
        color: #fecaca;
      }
      .status--success {
        background: rgba(52, 211, 153, 0.16);
        color: #bbf7d0;
      }
      .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 12px;
        margin-top: 18px;
      }
      .button {
        appearance: none;
        border: 1px solid rgba(148, 163, 184, 0.24);
        border-radius: 999px;
        padding: 10px 16px;
        font: inherit;
        cursor: pointer;
        text-decoration: none;
        background: #f8fafc;
        color: #0f172a;
        font-weight: 600;
      }
      .button--secondary {
        background: transparent;
        color: #f8fafc;
      }
      .fallback {
        margin-top: 20px;
        display: none;
      }
      .fallback--visible {
        display: block;
      }
      pre {
        margin: 12px 0 0;
        padding: 16px;
        overflow: auto;
        border-radius: 14px;
        background: rgba(15, 23, 42, 0.85);
        border: 1px solid rgba(148, 163, 184, 0.18);
        color: #e2e8f0;
        white-space: pre-wrap;
        word-break: break-word;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, SFMono-Regular, Menlo, monospace;
      }
    </style>
  </head>
  <body>
    <main class="card">
      <h1>SLICC handoff</h1>
      <p id="description">Looking up handoff <code>${options.handoffId}</code> and trying to deliver it to the installed SLICC extension.</p>
      <div id="status" class="status">Loading handoff…</div>
      <p id="detail"></p>
      <div id="actions" class="actions"></div>
      <section id="fallback" class="fallback">
        <p>You can still copy this handoff brief into SLICC manually:</p>
        <pre id="fallbackText"></pre>
      </section>
    </main>
    <script>
      const handoffId = ${JSON.stringify(options.handoffId)};
      const jsonUrl = ${JSON.stringify(options.jsonUrl)};
      const installUrl = ${JSON.stringify(options.installUrl)};
      const extensionId = ${JSON.stringify(options.extensionId)};
      const statusEl = document.getElementById('status');
      const detailEl = document.getElementById('detail');
      const actionsEl = document.getElementById('actions');
      const fallbackEl = document.getElementById('fallback');
      const fallbackTextEl = document.getElementById('fallbackText');

      const setStatus = (text, mode) => {
        statusEl.textContent = text;
        statusEl.className = 'status' + (mode ? ' status--' + mode : '');
      };

      const clearActions = () => {
        while (actionsEl.firstChild) actionsEl.removeChild(actionsEl.firstChild);
      };

      const addButton = (label, href, secondary) => {
        const link = document.createElement('a');
        link.className = 'button' + (secondary ? ' button--secondary' : '');
        link.textContent = label;
        link.href = href;
        if (href.startsWith('http')) {
          link.target = '_blank';
          link.rel = 'noreferrer';
        }
        actionsEl.appendChild(link);
      };

      const showFallback = (text) => {
        fallbackEl.classList.add('fallback--visible');
        fallbackTextEl.textContent = text;
        const copy = document.createElement('button');
        copy.type = 'button';
        copy.className = 'button button--secondary';
        copy.textContent = 'Copy handoff';
        copy.addEventListener('click', async () => {
          try {
            await navigator.clipboard.writeText(text);
            copy.textContent = 'Copied';
          } catch (error) {
            copy.textContent = 'Copy failed';
          }
        });
        actionsEl.appendChild(copy);
      };

      const formatFallback = (record) => {
        const lines = [];
        if (record.payload.title) {
          lines.push('# ' + record.payload.title, '');
        }
        lines.push('Instruction:', record.payload.instruction, '');
        if (record.payload.urls && record.payload.urls.length > 0) {
          lines.push('URLs:');
          for (const url of record.payload.urls) lines.push('- ' + url);
          lines.push('');
        }
        if (record.payload.context) {
          lines.push('Context:', record.payload.context, '');
        }
        if (record.payload.acceptanceCriteria && record.payload.acceptanceCriteria.length > 0) {
          lines.push('Acceptance criteria:');
          for (const item of record.payload.acceptanceCriteria) lines.push('- ' + item);
          lines.push('');
        }
        if (record.payload.notes) {
          lines.push('Notes:', record.payload.notes, '');
        }
        if (record.payload.openUrlsFirst) {
          lines.push('Open URLs first: yes', '');
        }
        lines.push('Handoff ID: ' + record.handoffId);
        return lines.join('\\n');
      };

      const sendToExtension = (record) =>
        new Promise((resolve, reject) => {
          if (!globalThis.chrome || !chrome.runtime || typeof chrome.runtime.sendMessage !== 'function') {
            reject(new Error('SLICC extension runtime is unavailable.'));
            return;
          }
          chrome.runtime.sendMessage(
            extensionId,
            {
              type: 'handoff_message.v1',
              handoffId: record.handoffId,
              payload: record.payload,
            },
            (response) => {
              const runtimeError = chrome.runtime.lastError;
              if (runtimeError) {
                reject(new Error(runtimeError.message || 'Unable to reach the SLICC extension.'));
                return;
              }
              resolve(response);
            }
          );
        });

      const fetchRecord = async () => {
        const response = await fetch(jsonUrl, {
          headers: { accept: 'application/json' },
          cache: 'no-store',
        });
        let body = null;
        try {
          body = await response.json();
        } catch (error) {
          body = null;
        }
        if (!response.ok) {
          throw Object.assign(new Error(body && body.error ? body.error : 'Unable to load handoff.'), {
            status: response.status,
          });
        }
        return body;
      };

      (async () => {
        clearActions();
        try {
          const record = await fetchRecord();
          try {
            const result = await sendToExtension(record);
            setStatus('Queued for approval', 'success');
            detailEl.textContent =
              result && result.status === 'duplicate'
                ? 'This handoff is already waiting inside SLICC.'
                : 'Open the SLICC side panel and click Accept when you are ready.';
          } catch (error) {
            setStatus('SLICC extension not available', 'error');
            detailEl.textContent =
              error instanceof Error ? error.message : 'Install the SLICC extension to continue this handoff.';
            addButton('Install SLICC extension', installUrl, false);
            showFallback(formatFallback(record));
          }
        } catch (error) {
          setStatus('Handoff unavailable', 'error');
          detailEl.textContent =
            error instanceof Error ? error.message : 'This handoff was not found or has expired.';
          addButton('Install SLICC extension', installUrl, true);
        }
      })();
    </script>
  </body>
</html>`;
}
