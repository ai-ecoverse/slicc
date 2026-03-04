/**
 * JavaScript runtime tool — execute JS code in an isolated iframe with VFS bridge.
 *
 * Provides a sandboxed JavaScript execution environment that can read/write
 * the virtual filesystem. Code runs inside a hidden iframe with a persistent
 * context (variables survive across calls).
 */

import type { VirtualFS } from '../fs/index.js';
import type { ToolDefinition, ToolResult } from '../core/types.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('tool:javascript');

/** Message sent from main page to iframe to execute code. */
interface ExecRequest {
  type: 'exec';
  id: string;
  code: string;
}

/** Message sent from iframe to main page for VFS operations. */
interface VfsRequest {
  type: 'vfs';
  id: string;
  op: 'readFile' | 'readFileBinary' | 'writeFile' | 'writeFileBinary' | 'readDir' | 'exists';
  args: string[];
  /** Binary data for writeFileBinary — transferred via structured clone. */
  binaryData?: Uint8Array;
}

/** Message sent from main page to iframe with VFS response. */
interface VfsResponse {
  type: 'vfs_response';
  id: string;
  result?: unknown;
  error?: string;
}

/** Message sent from iframe to main page with execution result. */
interface ExecResult {
  type: 'exec_result';
  id: string;
  result?: string;
  logs: string[];
  error?: string;
}

/** Message sent from iframe to parent to proxy a cross-origin fetch (extension sandbox CORS bypass). */
interface FetchProxyRequest {
  type: 'fetch_proxy';
  id: string;
  url: string;
  init?: { method?: string; headers?: Record<string, string>; body?: string };
}

/** Message sent from parent to iframe with proxied fetch response. */
interface FetchProxyResponse {
  type: 'fetch_proxy_response';
  id: string;
  status?: number;
  statusText?: string;
  headers?: Record<string, string>;
  /** Binary body transferred as Uint8Array via structured clone. */
  body?: Uint8Array;
  error?: string;
}

type IframeMessage = ExecRequest | VfsRequest | VfsResponse | ExecResult | FetchProxyRequest | FetchProxyResponse;

// NOTE: The use of Function constructor inside the iframe is intentional —
// this tool's purpose IS to execute arbitrary user-provided JavaScript code.
// The iframe sandbox provides the isolation boundary.
const IFRAME_HTML = `<!DOCTYPE html><html><head><script>
const pendingVfs = new Map();
let vfsIdCounter = 0;

// ── Fetch proxy (same as main page) ──────────────────────────────────────
// Route cross-origin fetch through the CLI server's /api/fetch-proxy
// so that user code (and fetchToFile) can access any URL without CORS issues.
const _origFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  let parsed;
  try { parsed = new URL(url, location.origin); } catch { return _origFetch(input, init); }
  if (parsed.origin === location.origin) return _origFetch(input, init);
  if (parsed.hostname.endsWith('anthropic.com')) return _origFetch(input, init);
  const proxyInit = {
    method: (init && init.method) || 'GET',
    headers: Object.assign({}, init && init.headers ? Object.fromEntries(new Headers(init.headers).entries()) : {}, { 'X-Target-URL': url }),
    cache: 'no-store',
  };
  if (init && init.body && !['GET','HEAD'].includes(proxyInit.method)) proxyInit.body = init.body;
  if (init && init.signal) proxyInit.signal = init.signal;
  return _origFetch('/api/fetch-proxy', proxyInit);
};

// ── VFS bridge ───────────────────────────────────────────────────────────
const fs = {
  readFile: (path) => vfsCall('readFile', [path]),
  readFileBinary: (path) => vfsCall('readFileBinary', [path]),
  writeFile: (path, content) => vfsCall('writeFile', [path, content]),
  writeFileBinary: (path, data) => vfsCallBinary('writeFileBinary', [path], data),
  readDir: (path) => vfsCall('readDir', [path]),
  exists: (path) => vfsCall('exists', [path]),
  fetchToFile: async (url, path) => {
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('fetch ' + resp.status + ' ' + resp.statusText);
    const buf = await resp.arrayBuffer();
    await vfsCallBinary('writeFileBinary', [path], new Uint8Array(buf));
    return buf.byteLength;
  },
};

function vfsCall(op, args) {
  return new Promise((resolve, reject) => {
    const id = 'vfs-' + (++vfsIdCounter);
    pendingVfs.set(id, { resolve, reject });
    parent.postMessage({ type: 'vfs', id, op, args }, '*');
  });
}

function vfsCallBinary(op, args, binaryData) {
  return new Promise((resolve, reject) => {
    const id = 'vfs-' + (++vfsIdCounter);
    pendingVfs.set(id, { resolve, reject });
    parent.postMessage({ type: 'vfs', id, op, args, binaryData }, '*');
  });
}

// Listen for messages from parent
addEventListener('message', async (e) => {
  const msg = e.data;
  if (!msg || !msg.type) return;

  if (msg.type === 'vfs_response') {
    const pending = pendingVfs.get(msg.id);
    if (pending) {
      pendingVfs.delete(msg.id);
      if (msg.error) pending.reject(new Error(msg.error));
      else pending.resolve(msg.result);
    }
    return;
  }

  if (msg.type === 'exec') {
    const logs = [];
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const origInfo = console.info;

    console.log = (...args) => logs.push(args.map(String).join(' '));
    console.error = (...args) => logs.push('[error] ' + args.map(String).join(' '));
    console.warn = (...args) => logs.push('[warn] ' + args.map(String).join(' '));
    console.info = (...args) => logs.push(args.map(String).join(' '));

    try {
      // Intentional: Function constructor executes user-provided code (tool's purpose)
      const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
      const fn = AsyncFunction('fs', msg.code);
      const result = await fn(fs);
      const resultStr = result !== undefined ? JSON.stringify(result, null, 2) : undefined;
      parent.postMessage({ type: 'exec_result', id: msg.id, result: resultStr, logs }, '*');
    } catch (err) {
      parent.postMessage({
        type: 'exec_result', id: msg.id,
        error: err instanceof Error ? err.message : String(err),
        logs,
      }, '*');
    } finally {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      console.info = origInfo;
    }
  }
});
<\/script></head><body></body></html>`;

/** Create the JavaScript runtime tool bound to a VirtualFS instance. */
export function createJavaScriptTool(fs: VirtualFS): ToolDefinition {
  let iframe: HTMLIFrameElement | null = null;
  let iframeReady: Promise<HTMLIFrameElement> | null = null;
  let execIdCounter = 0;
  let vfsListenerRegistered = false;

  /** Register a single persistent listener for VFS and fetch-proxy requests from the iframe. */
  function ensureVfsListener(): void {
    if (vfsListenerRegistered) return;
    vfsListenerRegistered = true;
    window.addEventListener('message', (event: MessageEvent) => {
      const msg = event.data as IframeMessage;
      if (msg && msg.type === 'vfs') {
        handleVfsRequest(msg as VfsRequest);
      } else if (msg && msg.type === 'fetch_proxy') {
        handleFetchProxy(msg as FetchProxyRequest);
      }
    });
  }

  /** Handle fetch proxy requests from the sandboxed iframe (extension CORS bypass). */
  function handleFetchProxy(msg: FetchProxyRequest): void {
    (async () => {
      try {
        const init: RequestInit = { method: msg.init?.method ?? 'GET', cache: 'no-store' };
        if (msg.init?.headers) init.headers = msg.init.headers;
        if (msg.init?.body && !['GET', 'HEAD'].includes(init.method as string)) {
          init.body = msg.init.body;
        }
        const resp = await fetch(msg.url, init);
        const buf = await resp.arrayBuffer();
        const headers: Record<string, string> = {};
        resp.headers.forEach((v, k) => { headers[k] = v; });
        iframe?.contentWindow?.postMessage(
          {
            type: 'fetch_proxy_response',
            id: msg.id,
            status: resp.status,
            statusText: resp.statusText,
            headers,
            body: new Uint8Array(buf),
          } satisfies FetchProxyResponse,
          '*',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('Fetch proxy error', { url: msg.url, error: errMsg });
        iframe?.contentWindow?.postMessage(
          { type: 'fetch_proxy_response', id: msg.id, error: errMsg } satisfies FetchProxyResponse,
          '*',
        );
      }
    })();
  }

  /** Get or create the sandboxed iframe, waiting for it to load in extension mode. */
  function ensureIframe(): Promise<HTMLIFrameElement> {
    if (iframeReady) return iframeReady;

    iframe = document.createElement('iframe');
    iframe.style.display = 'none';

    const isExtension = typeof chrome !== 'undefined' && !!chrome?.runtime?.id;

    if (isExtension) {
      // Extension mode — use sandboxed page (allows Function constructor).
      // Must wait for load event before posting messages.
      iframeReady = new Promise<HTMLIFrameElement>((resolve) => {
        iframe!.addEventListener('load', () => {
          log.debug('Sandbox iframe loaded');
          resolve(iframe!);
        }, { once: true });
        iframe!.src = chrome.runtime.getURL('sandbox.html');
        document.body.appendChild(iframe!);
      });
    } else {
      // CLI mode — write inline HTML (synchronous, immediately ready)
      iframe.sandbox.add('allow-scripts');
      iframe.sandbox.add('allow-same-origin');
      document.body.appendChild(iframe);
      const doc = iframe.contentDocument!;
      doc.open();
      doc.write(IFRAME_HTML);
      doc.close();
      iframeReady = Promise.resolve(iframe);
    }

    ensureVfsListener();
    return iframeReady;
  }

  function handleVfsRequest(msg: VfsRequest): void {
    (async () => {
      try {
        let result: unknown;
        switch (msg.op) {
          case 'readFile':
            result = await fs.readFile(msg.args[0]);
            break;
          case 'readFileBinary': {
            // Return raw bytes as Uint8Array via structured clone
            const content = await fs.readFile(msg.args[0], { encoding: 'binary' });
            result = content instanceof Uint8Array ? content : new TextEncoder().encode(content as string);
            break;
          }
          case 'writeFile':
            await fs.writeFile(msg.args[0], msg.args[1]);
            result = true;
            break;
          case 'writeFileBinary':
            // Binary data arrives as Uint8Array via structured clone
            await fs.writeFile(msg.args[0], msg.binaryData ?? new Uint8Array());
            result = true;
            break;
          case 'readDir':
            result = await fs.readDir(msg.args[0]);
            break;
          case 'exists':
            try {
              await fs.stat(msg.args[0]);
              result = true;
            } catch {
              result = false;
            }
            break;
        }
        iframe?.contentWindow?.postMessage(
          { type: 'vfs_response', id: msg.id, result } satisfies VfsResponse,
          '*',
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        log.error('VFS bridge error', { op: msg.op, path: msg.args[0], error: errMsg });
        iframe?.contentWindow?.postMessage(
          {
            type: 'vfs_response',
            id: msg.id,
            error: errMsg,
          } satisfies VfsResponse,
          '*',
        );
      }
    })();
  }

  return {
    name: 'javascript',
    description:
      'Execute JavaScript code in a persistent sandboxed runtime. ' +
      'Variables and functions persist across calls (same iframe context). ' +
      'VFS bridge: fs.readFile(path), fs.readFileBinary(path) → Uint8Array, ' +
      'fs.writeFile(path, content), fs.writeFileBinary(path, uint8Array), ' +
      'fs.readDir(path), fs.exists(path), fs.fetchToFile(url, path) — all async. ' +
      'Use fs.readFileBinary() to load binary files (images, etc.) as Uint8Array for canvas/Blob operations. ' +
      'fs.fetchToFile(url, path) downloads any URL and saves binary content to the VFS (best way to download files). ' +
      'Top-level await is supported. Console output (log/error/warn) is captured. ' +
      'The return value of the last expression is captured if you use "return <expr>". ' +
      'Has access to browser APIs (fetch, URL, JSON, TextEncoder, etc.). ' +
      'fetch() works for cross-origin URLs (proxied through the CLI server).',
    inputSchema: {
      type: 'object',
      properties: {
        code: {
          type: 'string',
          description: 'JavaScript code to execute. Runs inside an async function — use await freely, use return to produce a result.',
        },
        timeout: {
          type: 'number',
          description: 'Execution timeout in milliseconds. Default: 30000.',
        },
      },
      required: ['code'],
    },
    async execute(input: Record<string, unknown>): Promise<ToolResult> {
      const code = input['code'] as string;
      const timeout = (input['timeout'] as number) ?? 30000;
      const id = `exec-${++execIdCounter}`;

      log.debug('Execute JS', { codeLength: code.length, timeout });

      try {
        const frame = await ensureIframe();

        const result = await new Promise<ExecResult>((resolve, reject) => {
          const timer = setTimeout(() => {
            cleanup();
            reject(new Error(`JavaScript execution timed out after ${timeout}ms`));
          }, timeout);

          function handler(event: MessageEvent) {
            const msg = event.data as IframeMessage;
            if (!msg || !msg.type) return;

            // VFS requests handled by persistent listener (ensureVfsListener)
            if (msg.type === 'exec_result' && (msg as ExecResult).id === id) {
              cleanup();
              resolve(msg as ExecResult);
            }
          }

          function cleanup() {
            clearTimeout(timer);
            window.removeEventListener('message', handler);
          }

          window.addEventListener('message', handler);

          frame.contentWindow!.postMessage(
            { type: 'exec', id, code } satisfies ExecRequest,
            '*',
          );
        });

        let output = '';
        if (result.logs.length > 0) {
          output += result.logs.join('\n');
        }
        if (result.error) {
          if (output) output += '\n';
          output += `Error: ${result.error}`;
          return { content: output || 'JavaScript error', isError: true };
        }
        if (result.result !== undefined) {
          if (output) output += '\n';
          output += result.result;
        }

        return { content: output || '(no output)' };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('JS execution error', { error: message });
        return { content: `JavaScript error: ${message}`, isError: true };
      }
    },
  };
}
