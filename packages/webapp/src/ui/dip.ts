import type {
  PermissionDenyDetail,
  PermissionGrant,
  PermissionKind,
  PermissionRequestOptions,
} from '@slicc/webcomponents';
import { isExtensionRealm } from '../core/runtime-env.js';
import {
  getNavigatorHid,
  getSharedHidRegistry,
  type HidDeviceFilter,
} from '../kernel/hid-device-registry.js';
import * as hidOps from '../kernel/hid-operations.js';
import * as serialOps from '../kernel/serial-operations.js';
import {
  getNavigatorSerial,
  getSharedSerialRegistry,
  type SerialFilter,
  type SerialOpenOptions,
} from '../kernel/serial-port-registry.js';
import {
  getNavigatorUsb,
  getSharedUsbRegistry,
  type UsbDeviceFilter,
} from '../kernel/usb-device-registry.js';
import * as usbOps from '../kernel/usb-operations.js';
import { isNestedInAnotherFrame, nudgeIframeRepaint } from './iframe-repaint.js';
import { iframeThemeBridgeSource } from './iframe-theme.js';
import {
  runJshOp,
  type SprinkleAgentOptions,
  type SprinkleAgentResult,
  type SprinkleExecHandler,
  type SprinkleExecResult,
  type SprinkleFetchResult,
} from './sprinkle-bridge.js';
import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';
import { getLeaderPermissionsSurface } from './wc/wc-permissions-registry.js';

const isExtension = isExtensionRealm();

interface DipIframeResponseBody {
  type: string;
  error?: string;
  result?: unknown;
  content?: string;
  exists?: boolean;
  stat?: {
    isFile: boolean;
    isDirectory: boolean;
    size: number;
    mtimeMs: number;
  };
}

interface DipPickerActionData {
  filters?: unknown[];
}

function dipPickerFiltersFromData(data: unknown): unknown[] {
  if (data == null || typeof data !== 'object' || Array.isArray(data)) {
    return [];
  }
  const filters = (data as DipPickerActionData).filters;
  return Array.isArray(filters) ? filters : [];
}

async function readShtmlFromVFS(vfsPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const content = await readViaPreviewVfsBridge(vfsPath, true, signal);
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  if (content === null) throw new Error(`VFS read failed: ${vfsPath}`);
  return typeof content === 'string' ? content : new TextDecoder().decode(content);
}

interface PreviewVfsBridgeChannel {
  postMessage(data: unknown): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
  removeEventListener(type: 'message', listener: (ev: MessageEvent) => void): void;
}

let previewVfsBridgeChannel: PreviewVfsBridgeChannel | null = null;
function getPreviewVfsBridge(): PreviewVfsBridgeChannel | null {
  if (previewVfsBridgeChannel) return previewVfsBridgeChannel;
  if (typeof BroadcastChannel === 'undefined') return null;
  try {
    previewVfsBridgeChannel = new BroadcastChannel('preview-vfs') as PreviewVfsBridgeChannel;
  } catch {
    return null;
  }
  return previewVfsBridgeChannel;
}

async function readViaPreviewVfsBridge(
  vfsPath: string,
  asText: boolean,
  signal?: AbortSignal
): Promise<string | Uint8Array | null> {
  const bc = getPreviewVfsBridge();
  if (!bc) return null;
  const id = `dip-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return new Promise<string | Uint8Array | null>((resolve) => {
    let settled = false;
    const cleanup = () => {
      bc.removeEventListener('message', handler);
      signal?.removeEventListener('abort', onAbort);
    };
    const handler = (event: MessageEvent): void => {
      if (settled) return;
      if (event.data?.type !== 'preview-vfs-response' || event.data.id !== id) return;
      settled = true;
      cleanup();
      if (event.data.error) {
        resolve(null);
        return;
      }
      resolve(event.data.content ?? null);
    };
    const onAbort = () => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    };
    bc.addEventListener('message', handler);
    signal?.addEventListener('abort', onAbort);
    setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, 5000);
    bc.postMessage({ type: 'preview-vfs-read', id, path: vfsPath, asText });
  });
}

const TRUSTED_DIP_SOURCE_PREFIXES = [
  '/shared/sprinkles/',
  '/workspace/skills/sprinkles/',
  '/workspace/sprinkles/',
];

const TRUSTED_DIP_READ_PREFIXES = [
  '/shared/',
  '/workspace/skills/sprinkles/',
  '/workspace/sprinkles/',
];

function isTrustedDipSource(path: string): boolean {
  return TRUSTED_DIP_SOURCE_PREFIXES.some((p) => path.startsWith(p));
}

function isTrustedDipReadPath(path: string): boolean {
  if (typeof path !== 'string' || !path.startsWith('/')) return false;
  if (path.includes('..')) return false;
  return TRUSTED_DIP_READ_PREFIXES.some((p) => path.startsWith(p));
}

const trustedDipWindows = new WeakSet<Window>();

const EXEC_BRIDGE_METHODS = `,
    exec: Object.assign(function(cmd) {
      return _vfsCall('dip-exec', { cmd: cmd }, function(m) { return m.result; });
    }, { spawn: function(argv) {
      return _vfsCall('dip-jsh', { op: 'spawn', args: [argv] }, function(m) { return m.result; });
    } }),
    agent: function(prompt, opts) {
      return _vfsCall('dip-agent', { prompt: prompt, opts: opts || null },
        function(m) { return m.result; });
    }`;

const JSH_BRIDGE_METHODS = `,
    fetch: function(url, init) {
      return _vfsCall('dip-jsh', { op: 'fetch', args: [url, init || null] }, function(m) { return m.result; });
    },
    http: { client: function(cfg) {
      function mk(method) { return function(path, opts) { return _vfsCall('dip-jsh', { op: 'http', args: [cfg, method, path, opts || null] }, function(m) { return m.result; }); }; }
      return { get: mk('get'), post: mk('post'), put: mk('put'), patch: mk('patch'), 'delete': mk('delete') };
    } },
    browser: {
      findTab: function(q) { return _vfsCall('dip-jsh', { op: 'browser', args: ['findTab', q] }, function(m) { return m.result; }); },
      ensureTab: function(url, options) { return _vfsCall('dip-jsh', { op: 'browser', args: ['ensureTab', url, options || {}] }, function(m) { return m.result; }); },
      eval: function(tab, code) { return _vfsCall('dip-jsh', { op: 'browser', args: ['eval', tab, code] }, function(m) { return m.result; }); },
      evalAsync: function(tab, code) { return _vfsCall('dip-jsh', { op: 'browser', args: ['evalAsync', tab, code] }, function(m) { return m.result; }); },
      cookie: function(tab, name) { return _vfsCall('dip-jsh', { op: 'browser', args: ['cookie', tab, name] }, function(m) { return m.result; }); },
      localStorage: function(tab, key) { return _vfsCall('dip-jsh', { op: 'browser', args: ['localStorage', tab, key] }, function(m) { return m.result; }); },
      fetch: function(tab, url, opts) { return _vfsCall('dip-jsh', { op: 'browser', args: ['fetch', tab, url, opts || {}] }, function(m) { return m.result; }); }
    },
    fetchToFile: function(url, path) {
      return _vfsCall('dip-jsh', { op: 'fetchToFile', args: [url, path] }, function(m) { return m.result; });
    }`;

const DEVICE_BRIDGE_METHODS = `,
    _device: function(channel, op, args) {
      return _vfsCall('dip-device-op',
        { channel: channel, op: op, args: args || [] },
        function(m) { return m.result; });
    },
    hid: {
      list: function() { return _vfsCall('dip-device-op', { channel: 'hid', op: 'list', args: [] }, function(m) { return m.result; }); },
      request: function(filters) { return _vfsCall('dip-device-op', { channel: 'hid', op: 'request', args: [filters || []] }, function(m) { return m.result; }); },
      open: function(handle) { return _vfsCall('dip-device-op', { channel: 'hid', op: 'open', args: [handle] }, function(m) { return m.result; }).then(function() {}); },
      close: function(handle) { return _vfsCall('dip-device-op', { channel: 'hid', op: 'close', args: [handle] }, function(m) { return m.result; }).then(function() {}); },
      sendReport: function(handle, reportId, data) { return _vfsCall('dip-device-op', { channel: 'hid', op: 'sendReport', args: [handle, reportId, data] }, function(m) { return m.result; }).then(function() {}); },
      on: function(event, cb) { if (event === 'inputreport') _hidInputReportListeners.add(cb); },
      off: function(event, cb) { if (event === 'inputreport') _hidInputReportListeners.delete(cb); }
    },
    serial: {
      list: function() { return _vfsCall('dip-device-op', { channel: 'serial', op: 'list', args: [] }, function(m) { return m.result; }); },
      request: function(filters) { return _vfsCall('dip-device-op', { channel: 'serial', op: 'request', args: [filters || []] }, function(m) { return m.result; }); },
      open: function(handle, options) { return _vfsCall('dip-device-op', { channel: 'serial', op: 'open', args: [handle, options] }, function(m) { return m.result; }).then(function() {}); },
      close: function(handle) { return _vfsCall('dip-device-op', { channel: 'serial', op: 'close', args: [handle] }, function(m) { return m.result; }).then(function() {}); }
    },
    usb: {
      list: function() { return _vfsCall('dip-device-op', { channel: 'usb', op: 'list', args: [] }, function(m) { return m.result; }); },
      request: function(filters) { return _vfsCall('dip-device-op', { channel: 'usb', op: 'request', args: [filters || []] }, function(m) { return m.result; }); },
      open: function(handle) { return _vfsCall('dip-device-op', { channel: 'usb', op: 'open', args: [handle] }, function(m) { return m.result; }).then(function() {}); },
      close: function(handle) { return _vfsCall('dip-device-op', { channel: 'usb', op: 'close', args: [handle] }, function(m) { return m.result; }).then(function() {}); }
    }`;

function buildBridgeScript(includeExec: boolean): string {
  return `(function() {
  var _cbId = 0;
  var _callbacks = {};
  var _hidInputReportListeners = new Set();

  function _vfsCall(type, params, extractResult) {
    return new Promise(function(resolve, reject) {
      var id = ++_cbId;
      _callbacks[id] = function(msg) {
        if (msg.error) reject(new Error(msg.error));
        else resolve(extractResult ? extractResult(msg) : undefined);
      };
      var m = { type: type, id: id };
      if (params) { for (var k in params) m[k] = params[k]; }
      parent.postMessage(m, '*');
    });
  }

  window.slicc = window.bridge = {
    lick: function(event) {
      var action = typeof event === 'string' ? event : event.action;
      var data = typeof event === 'string' ? undefined : ('data' in event ? event.data : event);
      parent.postMessage({ type: 'dip-lick', action: action, data: data }, '*');
    },
    /* Read-only VFS access. Mirrors the sprinkle bridge so dips can
       check onboarding markers, profiles, etc. without a parent-side
       handshake. */
    readFile: function(path) {
      return _vfsCall('dip-readfile', { path: path }, function(m) { return m.content; });
    },
    exists: function(path) {
      return _vfsCall('dip-exists', { path: path }, function(m) { return m.exists; });
    },
    stat: function(path) {
      return _vfsCall('dip-stat', { path: path }, function(m) { return m.stat; });
    }${includeExec ? EXEC_BRIDGE_METHODS : ''}${includeExec ? JSH_BRIDGE_METHODS : ''}${includeExec ? DEVICE_BRIDGE_METHODS : ''}
  };
  function reportHeight() {
    parent.postMessage({ type: 'dip-height',
      height: document.documentElement.scrollHeight }, '*');
  }
  ${iframeThemeBridgeSource}
  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'slicc-theme') {
      applyIframeTheme(e);
      return;
    }
    /* Pushed device events (currently 'hid:inputreport'). The host
       attaches the underlying listener on slicc.hid.open(handle) for
       this dip; teardown happens automatically on dispose. */
    if (e.data.type === 'dip-device-event' && e.data.channel === 'hid:inputreport') {
      _hidInputReportListeners.forEach(function(cb) {
        try { cb(e.data.payload); } catch(ex) {}
      });
      return;
    }
    /* VFS callback responses target the originating call by id. */
    if (e.data.id && _callbacks[e.data.id]) {
      var cb = _callbacks[e.data.id];
      delete _callbacks[e.data.id];
      cb(e.data);
      return;
    }
    /* Forward any other slicc-* message to in-page listeners via a
       CustomEvent. Dips can opt in with
       window.addEventListener('slicc-message', (ev) => ev.detail). */
    if (e.data.type.indexOf('slicc-') === 0) {
      try {
        document.dispatchEvent(new CustomEvent('slicc-message', { detail: e.data }));
      } catch (ex) {}
    }
  });
  window.addEventListener('load', function() {
    reportHeight();
    new ResizeObserver(reportHeight).observe(document.body);
  });
  /* Support data-action attributes (Tool UI compat) — auto-lick on click.
     Also intercept <a href> clicks and relay to the parent so links open
     despite the iframe sandbox blocking top-level navigation. */
  document.addEventListener('click', function(e) {
    var el = e.target;
    while (el && el !== document.body) {
      if (el.dataset && el.dataset.action) {
        var actionData = el.dataset.actionData;
        if (actionData) { try { actionData = JSON.parse(actionData); } catch(ex) {} }
        /* Picker hint (e.g. data-picker="directory") needs the parent to
           run File System Access API on the click activation chain.
           Forward as a separate message so the parent can run
           showDirectoryPicker, stash the handle in IDB, then dispatch
           the lick with the IDB key. */
        var picker = el.dataset.picker;
        if (picker) {
          parent.postMessage({
            type: 'dip-picker-action',
            action: el.dataset.action,
            data: actionData || null,
            picker: picker,
          }, '*');
        } else {
          window.slicc.lick({ action: el.dataset.action, data: actionData || null });
        }
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      if (el.tagName === 'A' && el.getAttribute('href')) {
        var href = el.getAttribute('href');
        /* Allow in-iframe anchor navigation (#foo). Skip javascript: for safety. */
        if (href.charAt(0) === '#') return;
        if (/^javascript:/i.test(href)) { e.preventDefault(); return; }
        /* Resolve relative URLs against the iframe's base. */
        var resolved;
        try { resolved = new URL(href, document.baseURI).href; } catch(ex) { resolved = href; }
        parent.postMessage({ type: 'dip-open-link', url: resolved }, '*');
        e.preventDefault();
        e.stopPropagation();
        return;
      }
      el = el.parentElement;
    }
  });
})();`;
}

export interface DipInstance {
  dispose(): void;
}

export interface DraftDipInstance {
  readonly element: HTMLIFrameElement;

  update(content: string): void;

  dispose(): void;
}

export function extractShtmlBlocks(content: string): string[] {
  const blocks: string[] = [];
  const re = /```shtml\n([\s\S]*?)(?:\n```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    blocks.push(m[1] ?? '');
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return blocks;
}

export type ContentSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'shtml'; body: string; closed: boolean };

export function splitContentSegments(content: string): ContentSegment[] {
  const segments: ContentSegment[] = [];
  let lastEnd = 0;
  const re = /```shtml\n([\s\S]*?)(\n```|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(content)) !== null) {
    if (m.index > lastEnd) {
      segments.push({ kind: 'prose', text: content.slice(lastEnd, m.index) });
    }
    segments.push({
      kind: 'shtml',
      body: m[1] ?? '',
      closed: m[2] === '\n```',
    });
    lastEnd = m.index + m[0].length;
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  if (lastEnd < content.length) {
    segments.push({ kind: 'prose', text: content.slice(lastEnd) });
  }
  return segments;
}

const DIP_HOST_STYLES = `html,body{margin:0;padding:0;overflow:hidden;background:transparent;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
/* Vertical breathing room around dip content. Horizontal padding is owned
   by the dip's own content (e.g. .sprinkle-action-card__body) so shtml
   widgets that already pad themselves don't end up double-indented. The
   ResizeObserver on document.body reports the post-padding scrollHeight
   correctly, so auto-height continues to work. The .sprinkle-inline rule
   (set on the iframe body) carries 2px of horizontal padding so the 1px
   focus ring (box-shadow:0 0 0 1px on inputs/select below) doesn't get
   clipped at the iframe paint boundary. */
body{padding:12px 0;font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}
.sprinkle-inline{padding:var(--s2-spacing-100) 2px}
.sprinkle-inline .sprinkle-btn{padding:4px 12px;font-size:12px;height:28px;box-shadow:none}
.sprinkle-inline .sprinkle-btn:not([class*="sprinkle-btn--"]){background:var(--s2-bg-elevated)}
.sprinkle-inline .sprinkle-card{box-shadow:none;margin:0}
.sprinkle-inline .sprinkle-action-card{margin:0;width:100%}
/* Stacked action cards in one dip need breathing room between them. The
   margin:0 above zeroes the single-card case (iframe padding owns that
   spacing); this adjacent-sibling rule outranks a plain authored class,
   so multiple .sprinkle-action-card in one message no longer touch edge
   to edge. See vfs-root/workspace/skills/dips/SKILL.md. */
.sprinkle-inline .sprinkle-action-card + .sprinkle-action-card{margin-top:12px}
.sprinkle-inline .sprinkle-action-card .sprinkle-table{width:100%}
.sprinkle-inline .sprinkle-grid{width:100%}
input[type="range"]{width:100%;height:4px;-webkit-appearance:none;appearance:none;background:var(--s2-gray-300);border-radius:2px;outline:none;cursor:default}
input[type="range"]::-webkit-slider-thumb{-webkit-appearance:none;width:18px;height:18px;border-radius:50%;background:var(--s2-accent);cursor:default;border:2px solid var(--s2-bg-base)}
input[type="range"]::-moz-range-thumb{width:14px;height:14px;border-radius:50%;background:var(--s2-accent);cursor:default;border:2px solid var(--s2-bg-base)}
input[type="text"],input[type="number"],textarea{width:100%;padding:7px 12px;font-size:13px;font-family:var(--s2-font-family,sans-serif);color:var(--s2-content-default);background:var(--s2-bg-layer-2);border:1px solid var(--s2-border-subtle,var(--s2-gray-300));border-radius:8px;outline:none;box-sizing:border-box}
input[type="text"]:focus,input[type="number"]:focus,textarea:focus{border-color:var(--s2-accent);box-shadow:0 0 0 1px var(--s2-accent)}
input[type="text"]::placeholder,textarea::placeholder{color:var(--s2-content-disabled,var(--s2-gray-400))}
select{padding:6px 12px;font-size:13px;font-family:var(--s2-font-family,sans-serif);color:var(--s2-content-default);background:var(--s2-bg-layer-2);border:1px solid var(--s2-border-subtle,var(--s2-gray-300));border-radius:8px;outline:none;cursor:default}
select:focus{border-color:var(--s2-accent);box-shadow:0 0 0 1px var(--s2-accent)}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;height:28px;padding:4px 12px;border:1px solid var(--s2-border-default,var(--s2-gray-300));border-radius:9999px;background:transparent;color:var(--s2-content-default);font-size:12px;font-weight:700;font-family:var(--s2-font-family,sans-serif);cursor:default;transition:background 130ms ease}
button:hover{background:color-mix(in srgb,var(--s2-content-default) 6%,transparent)}
button:disabled{opacity:0.4;pointer-events:none}
canvas{display:block;width:100%;border-radius:8px}
mark{background:color-mix(in srgb,var(--s2-accent) 25%,transparent);color:inherit;border-radius:2px;padding:0 2px}
.c-purple{background:#3C3489;color:#EEEDFE}.c-teal{background:#085041;color:#E1F5EE}
.c-coral{background:#712B13;color:#FAECE7}.c-pink{background:#72243E;color:#FBEAF0}
.c-gray{background:#444441;color:#F1EFE8}.c-blue{background:#0C447C;color:#E6F1FB}
.c-amber{background:#633806;color:#FAEEDA}.c-red{background:#791F1F;color:#FCEBEB}
.c-green{background:#27500A;color:#EAF3DE}`;

const DRAFT_BRIDGE_EXTENSION = `(function(){
  window.addEventListener('message', function(e){
    if (!e.data || e.data.type !== 'dip-draft-update') return;
    var content = typeof e.data.content === 'string' ? e.data.content : '';
    document.body.innerHTML = content;
    if (window.lucide && typeof window.lucide.createIcons === 'function') {
      try { window.lucide.createIcons(); } catch(ex){}
    }
  });
})();`;

function buildDipSrcdoc(content: string, isDraft: boolean, trusted = false): string {
  const themeCSS = collectThemeCSS();
  const htmlClass = isThemeLight() ? ' class="theme-light"' : '';

  const includeEditor = isDraft || content.includes('<slicc-editor');
  const includeDiff = isDraft || content.includes('<slicc-diff');
  const draftScript = isDraft ? `<script>${DRAFT_BRIDGE_EXTENSION}</script>` : '';

  const bridgeScript = buildBridgeScript(trusted && !isDraft);
  return `<!DOCTYPE html>
<html${htmlClass}><head>
<meta charset="utf-8">
<style>${themeCSS}</style>
<style>${DIP_HOST_STYLES}</style>
<script>${bridgeScript}</script>
${draftScript}
${includeEditor ? '<script src="/slicc-editor.js"></script>' : ''}
${includeDiff ? '<script src="/slicc-diff.js"></script>' : ''}
<script src="/lucide-icons.js"></script>
</head>
<body class="sprinkle-inline">${content}</body></html>`;
}

const liveDipWindows = new Set<Window>();

export function broadcastToDips(payload: { type: string; [k: string]: unknown }): void {
  if (typeof payload?.type !== 'string' || payload.type.indexOf('slicc-') !== 0) {
    throw new Error("broadcastToDips: payload.type must start with 'slicc-'");
  }
  for (const win of liveDipWindows) {
    try {
      win.postMessage(payload, '*');
    } catch {}
  }
}

let dipExecHandler: SprinkleExecHandler | undefined;

export function setDipExecHandler(handler: SprinkleExecHandler | undefined): void {
  dipExecHandler = handler;
}

function shellQuoteDip(value: string): string {
  if (value.length === 0) return `''`;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildDipAgentCommand(prompt: string, opts?: SprinkleAgentOptions): string {
  const cwd = opts?.cwd ?? '.';
  const allowed = opts?.allowedCommands ?? '*';
  const parts = ['agent'];
  if (opts?.model) parts.push('--model', shellQuoteDip(opts.model));
  if (opts?.thinking) parts.push('--thinking', shellQuoteDip(opts.thinking));
  if (opts?.readOnly) parts.push('--read-only', shellQuoteDip(opts.readOnly));
  parts.push(shellQuoteDip(cwd), shellQuoteDip(allowed), shellQuoteDip(prompt));
  return parts.join(' ');
}

async function runDipExec(cmd: string): Promise<SprinkleExecResult> {
  if (!dipExecHandler) {
    return { stdout: '', stderr: 'exec: shell bridge not available\n', exitCode: 127 };
  }
  try {
    return await dipExecHandler(cmd);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { stdout: '', stderr: `exec: ${message}\n`, exitCode: 1 };
  }
}

async function runDipAgent(
  prompt: string,
  opts?: SprinkleAgentOptions
): Promise<SprinkleAgentResult> {
  const result = await runDipExec(buildDipAgentCommand(prompt, opts));
  return { stdout: result.stdout || result.stderr, exitCode: result.exitCode };
}

async function runDipJsh(op: string, args: unknown[]): Promise<unknown> {
  const value = await runJshOp(runDipExec, op, args);
  if (op === 'fetch') {
    const v = value as SprinkleFetchResult;
    const bin = atob(v.bodyBase64);
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return { ...v, body: new TextDecoder('utf-8').decode(u8) };
  }
  return value;
}

const dipHidSubs = new WeakMap<Window, Map<string, () => void | Promise<void>>>();

function pushDipHidInputReport(
  iframeWindow: Window,
  payload: { handle: string; reportId: number; data: Uint8Array }
): void {
  try {
    iframeWindow.postMessage(
      { type: 'dip-device-event', channel: 'hid:inputreport', payload },
      '*'
    );
  } catch {}
}

async function attachDipHidInputReports(iframeWindow: Window, handle: string): Promise<void> {
  let map = dipHidSubs.get(iframeWindow);
  if (!map) {
    map = new Map();
    dipHidSubs.set(iframeWindow, map);
  }
  if (map.has(handle)) return;
  const off = await hidOps.hidSubscribeInputReports(getSharedHidRegistry(), handle, (report) => {
    const bytes = report.bytes instanceof Uint8Array ? report.bytes : new Uint8Array(report.bytes);
    pushDipHidInputReport(iframeWindow, {
      handle,
      reportId: report.reportId,
      data: bytes,
    });
  });
  map.set(handle, off);
}

async function detachDipHidInputReports(iframeWindow: Window, handle: string): Promise<void> {
  const map = dipHidSubs.get(iframeWindow);
  if (!map) return;
  const off = map.get(handle);
  if (off) {
    map.delete(handle);
    try {
      await Promise.resolve(off());
    } catch {}
  }
  if (map.size === 0) dipHidSubs.delete(iframeWindow);
}

function disposeDipHidSubs(iframeWindow: Window): void {
  const map = dipHidSubs.get(iframeWindow);
  if (!map) return;
  for (const off of map.values()) {
    try {
      void Promise.resolve(off()).catch(() => {});
    } catch {}
  }
  dipHidSubs.delete(iframeWindow);
}

function toDipUint8Array(value: unknown): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) {
    const view = value as ArrayBufferView;
    return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
  }
  if (Array.isArray(value)) return new Uint8Array(value as number[]);
  throw new Error('expected Uint8Array, ArrayBuffer, or number[]');
}

async function runDipHidOp(
  iframeWindow: Window,
  op: string,
  args: readonly unknown[]
): Promise<unknown> {
  const reg = getSharedHidRegistry();
  switch (op) {
    case 'list': {
      const hid = getNavigatorHid();
      if (!hid) throw new Error('WebHID is unavailable in this browser');
      return hidOps.hidList(reg, hid);
    }
    case 'request': {
      const hid = getNavigatorHid();
      if (!hid) throw new Error('WebHID is unavailable in this browser');
      return hidOps.hidRequest(reg, hid, (args[0] as HidDeviceFilter[]) ?? []);
    }
    case 'info':
      return hidOps.hidDeviceInfo(reg, args[0] as string);
    case 'open': {
      const handle = args[0] as string;
      await hidOps.hidOpen(reg, handle);
      await attachDipHidInputReports(iframeWindow, handle);
      return { ok: true };
    }
    case 'close': {
      const handle = args[0] as string;
      await detachDipHidInputReports(iframeWindow, handle);
      await hidOps.hidClose(reg, handle);
      return { ok: true };
    }
    case 'sendReport': {
      const handle = args[0] as string;
      const reportId = args[1] as number;
      const bytes = toDipUint8Array(args[2]);
      const buf = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength
      ) as ArrayBuffer;
      await hidOps.hidSendReport(reg, handle, reportId, buf);
      return { ok: true };
    }
    default:
      throw new Error(`hid: unknown op '${op}'`);
  }
}

async function runDipSerialOp(op: string, args: readonly unknown[]): Promise<unknown> {
  const reg = getSharedSerialRegistry();
  switch (op) {
    case 'list': {
      const serial = getNavigatorSerial();
      if (!serial) throw new Error('Web Serial is unavailable in this browser');
      return serialOps.serialList(reg, serial);
    }
    case 'request': {
      const serial = getNavigatorSerial();
      if (!serial) throw new Error('Web Serial is unavailable in this browser');
      return serialOps.serialRequest(reg, serial, (args[0] as SerialFilter[]) ?? []);
    }
    case 'info':
      return serialOps.serialDeviceInfo(reg, args[0] as string);
    case 'open': {
      const handle = args[0] as string;
      const options = (args[1] as SerialOpenOptions) ?? { baudRate: 9600 };
      await serialOps.serialOpen(reg, handle, options);
      return { ok: true };
    }
    case 'close': {
      await serialOps.serialClose(reg, args[0] as string);
      return { ok: true };
    }
    default:
      throw new Error(`serial: unknown op '${op}'`);
  }
}

async function runDipUsbOp(op: string, args: readonly unknown[]): Promise<unknown> {
  const reg = getSharedUsbRegistry();
  switch (op) {
    case 'list': {
      const usb = getNavigatorUsb();
      if (!usb) throw new Error('WebUSB is unavailable in this browser');
      return usbOps.usbList(reg, usb);
    }
    case 'request': {
      const usb = getNavigatorUsb();
      if (!usb) throw new Error('WebUSB is unavailable in this browser');
      return usbOps.usbRequest(reg, usb, (args[0] as UsbDeviceFilter[]) ?? []);
    }
    case 'info':
      return usbOps.usbDeviceInfo(reg, args[0] as string);
    case 'open': {
      await usbOps.usbOpen(reg, args[0] as string);
      return { ok: true };
    }
    case 'close': {
      await usbOps.usbClose(reg, args[0] as string);
      return { ok: true };
    }
    default:
      throw new Error(`usb: unknown op '${op}'`);
  }
}

async function runDipDeviceOp(
  iframeWindow: Window,
  channel: 'hid' | 'serial' | 'usb',
  op: string,
  args: readonly unknown[]
): Promise<unknown> {
  switch (channel) {
    case 'hid':
      return runDipHidOp(iframeWindow, op, args);
    case 'serial':
      return runDipSerialOp(op, args);
    case 'usb':
      return runDipUsbOp(op, args);
    default:
      throw new Error(`unknown device channel '${channel}'`);
  }
}

async function handleDipDeviceRequest(
  iframeWindow: Window | null,
  msg: {
    type: string;
    id?: number;
    channel?: string;
    op?: string;
    args?: unknown[];
  }
): Promise<boolean> {
  if (!iframeWindow || typeof msg.id !== 'number') return false;
  const respond = (payload: DipIframeResponseBody) => {
    try {
      iframeWindow.postMessage({ ...payload, id: msg.id }, '*');
    } catch {}
  };

  if (!trustedDipWindows.has(iframeWindow)) {
    respond({ type: 'dip-device-op-response', error: 'device access not allowed for this dip' });
    return true;
  }

  const channel = msg.channel;
  if (channel !== 'hid' && channel !== 'serial' && channel !== 'usb') {
    respond({ type: 'dip-device-op-response', error: `unknown device channel '${channel}'` });
    return true;
  }

  try {
    const result = await runDipDeviceOp(
      iframeWindow,
      channel,
      typeof msg.op === 'string' ? msg.op : '',
      Array.isArray(msg.args) ? msg.args : []
    );
    respond({ type: 'dip-device-op-response', result });
  } catch (err) {
    respond({
      type: 'dip-device-op-response',
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return true;
}

async function handleDipExecRequest(
  iframeWindow: Window | null,
  msg: {
    type: string;
    id?: number;
    cmd?: string;
    prompt?: string;
    opts?: SprinkleAgentOptions;
    op?: string;
    args?: unknown[];
  }
): Promise<boolean> {
  if (!iframeWindow || typeof msg.id !== 'number') return false;
  const respond = (payload: DipIframeResponseBody) => {
    try {
      iframeWindow.postMessage({ ...payload, id: msg.id }, '*');
    } catch {}
  };

  if (!trustedDipWindows.has(iframeWindow)) {
    respond({ type: `${msg.type}-response`, error: 'exec not allowed for this dip' });
    return true;
  }

  if (msg.type === 'dip-exec') {
    const result = await runDipExec(typeof msg.cmd === 'string' ? msg.cmd : '');
    respond({ type: 'dip-exec-response', result });
    return true;
  }
  if (msg.type === 'dip-agent') {
    const result = await runDipAgent(typeof msg.prompt === 'string' ? msg.prompt : '', msg.opts);
    respond({ type: 'dip-agent-response', result });
    return true;
  }
  if (msg.type === 'dip-jsh') {
    try {
      const result = await runDipJsh(
        typeof msg.op === 'string' ? msg.op : '',
        Array.isArray(msg.args) ? msg.args : []
      );
      respond({ type: 'dip-jsh-response', result });
    } catch (err) {
      respond({
        type: 'dip-jsh-response',
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return true;
  }
  return false;
}

export function mountDip(
  container: HTMLElement,
  content: string,
  onLick: (action: string, data: unknown) => void,
  trusted = false
): DipInstance {
  const srcdoc = buildDipSrcdoc(content, false, trusted);

  if (isExtension) {
    return mountDipExtension(container, srcdoc, onLick, trusted);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);

  if (iframe.contentWindow) {
    registerSprinkleWindow(iframe.contentWindow);
    liveDipWindows.add(iframe.contentWindow);
    if (trusted) trustedDipWindows.add(iframe.contentWindow);
  }
  iframe.addEventListener(
    'load',
    () => {
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.add(iframe.contentWindow);
        if (trusted) trustedDipWindows.add(iframe.contentWindow);
      }
      if (isNestedInAnotherFrame()) nudgeIframeRepaint(iframe);
    },
    {
      once: true,
    }
  );

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'dip-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'dip-height') {
      iframe.style.height = msg.height + 'px';
    } else if (msg.type === 'dip-open-link') {
      openDipLink(msg.url);
    } else if (msg.type === 'dip-picker-action') {
      void handleDipPickerAction(msg, onLick);
    } else if (
      msg.type === 'dip-readfile' ||
      msg.type === 'dip-exists' ||
      msg.type === 'dip-stat'
    ) {
      void handleDipVfsRequest(iframe.contentWindow, msg);
    } else if (msg.type === 'dip-exec' || msg.type === 'dip-agent' || msg.type === 'dip-jsh') {
      void handleDipExecRequest(iframe.contentWindow, msg);
    } else if (msg.type === 'dip-device-op') {
      void handleDipDeviceRequest(iframe.contentWindow, msg);
    }
  };
  window.addEventListener('message', messageHandler);

  let visibilityObserver: IntersectionObserver | null = null;
  if (isNestedInAnotherFrame() && typeof IntersectionObserver !== 'undefined') {
    let skipNextVisible = false;
    const observer = new IntersectionObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (!entry.isIntersecting) return;
      if (skipNextVisible) {
        skipNextVisible = false;
        return;
      }
      observer.unobserve(iframe);
      nudgeIframeRepaint(iframe, () => {
        skipNextVisible = true;
        observer.observe(iframe);
      });
    });
    visibilityObserver = observer;
    observer.observe(iframe);
  }

  return {
    dispose() {
      visibilityObserver?.disconnect();
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.delete(iframe.contentWindow);
        trustedDipWindows.delete(iframe.contentWindow);
        disposeDipHidSubs(iframe.contentWindow);
      }
      iframe.remove();
    },
  };
}

export function mountDraftDip(onLick: (action: string, data: unknown) => void): DraftDipInstance {
  const srcdoc = buildDipSrcdoc('', true);
  if (isExtension) return mountDraftDipExtension(srcdoc, onLick);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');

  iframe.style.cssText =
    'width:100%;border:none;overflow:hidden;display:block;pointer-events:none;';
  iframe.srcdoc = srcdoc;

  let ready = false;
  let pendingContent: string | null = null;
  let lastSent: string | null = null;
  const sendUpdate = (content: string) => {
    if (lastSent === content) return;
    lastSent = content;
    iframe.contentWindow?.postMessage({ type: 'dip-draft-update', content }, '*');
  };

  if (iframe.contentWindow) {
    registerSprinkleWindow(iframe.contentWindow);
    liveDipWindows.add(iframe.contentWindow);
  }
  iframe.addEventListener(
    'load',
    () => {
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) liveDipWindows.add(iframe.contentWindow);
      ready = true;
      if (pendingContent !== null) {
        sendUpdate(pendingContent);
        pendingContent = null;
      }
      if (isNestedInAnotherFrame()) nudgeIframeRepaint(iframe);
    },
    { once: true }
  );

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;
    if (msg.type === 'dip-lick') onLick(msg.action, msg.data);
    else if (msg.type === 'dip-height') iframe.style.height = msg.height + 'px';
    else if (msg.type === 'dip-open-link') openDipLink(msg.url);
  };
  window.addEventListener('message', messageHandler);

  return {
    element: iframe,
    update(content: string) {
      if (ready) sendUpdate(content);
      else pendingContent = content;
    },
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) liveDipWindows.delete(iframe.contentWindow);
      iframe.remove();
    },
  };
}

async function handleDipVfsRequest(
  iframeWindow: Window | null,
  msg: { type: string; id?: number; path?: string }
): Promise<boolean> {
  if (!iframeWindow || typeof msg.id !== 'number') return false;
  const path = typeof msg.path === 'string' ? msg.path : '';
  const respond = (payload: DipIframeResponseBody) => {
    try {
      iframeWindow.postMessage({ ...payload, id: msg.id }, '*');
    } catch {}
  };

  if (!trustedDipWindows.has(iframeWindow)) {
    respond({ type: `${msg.type}-response`, error: 'VFS access not allowed for this dip' });
    return true;
  }
  if (!isTrustedDipReadPath(path)) {
    respond({ type: `${msg.type}-response`, error: `VFS path not allowed: ${path}` });
    return true;
  }

  if (msg.type === 'dip-readfile') {
    const raw = await readViaPreviewVfsBridge(path, true);
    if (raw === null) {
      respond({ type: 'dip-readfile-response', error: 'Read failed' });
      return true;
    }
    const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    respond({ type: 'dip-readfile-response', content });
    return true;
  }
  if (msg.type === 'dip-exists') {
    const raw = await readViaPreviewVfsBridge(path, true);
    respond({ type: 'dip-exists-response', exists: raw !== null });
    return true;
  }
  if (msg.type === 'dip-stat') {
    const raw = await readViaPreviewVfsBridge(path, false);
    if (raw === null) {
      respond({ type: 'dip-stat-response', error: 'Stat failed' });
      return true;
    }
    const size = typeof raw === 'string' ? raw.length : raw.byteLength;
    respond({
      type: 'dip-stat-response',
      stat: {
        isFile: true,
        isDirectory: false,
        size,
        mtimeMs: 0,
      },
    });
    return true;
  }
  return false;
}

function openDipLink(url: unknown): void {
  if (typeof url !== 'string' || !url) return;
  if (!/^(https?:|mailto:)/i.test(url)) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {}
}

export function hydrateDips(
  containerEl: HTMLElement,
  onLick: (action: string, data: unknown) => void
): DipInstance[] {
  const instances: DipInstance[] = [];

  const codeEls = containerEl.querySelectorAll<HTMLElement>('pre > code.language-shtml');
  for (const codeEl of codeEls) {
    const preEl = codeEl.parentElement!;
    const shtmlContent = codeEl.textContent ?? '';

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    preEl.replaceWith(wrapper);

    instances.push(mountDip(wrapper, shtmlContent, onLick, false));
  }

  const imgEls = containerEl.querySelectorAll<HTMLImageElement>('img[src$=".shtml"]');
  for (const imgEl of imgEls) {
    const src = imgEl.getAttribute('src');
    if (!src) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    if (imgEl.alt) wrapper.setAttribute('title', imgEl.alt);
    imgEl.replaceWith(wrapper);

    const controller = new AbortController();
    let mounted: DipInstance | null = null;
    let disposed = false;
    const placeholder: DipInstance = {
      dispose() {
        disposed = true;
        controller.abort();
        if (mounted) {
          mounted.dispose();
          mounted = null;
        }
      },
    };
    instances.push(placeholder);

    const isVfsPath = src.startsWith('/');
    const swControlled = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
    const fetchUrl = isVfsPath ? `/preview${src}` : src;

    const resolveContent = async (): Promise<string> => {
      if (isVfsPath && !swControlled) {
        return readShtmlFromVFS(src, controller.signal);
      }

      let resp: Response;
      try {
        resp = await fetch(fetchUrl, { signal: controller.signal });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        if (isVfsPath) return readShtmlFromVFS(src, controller.signal);
        throw err;
      }
      if (resp.ok) return resp.text();

      if (isVfsPath) return readShtmlFromVFS(src, controller.signal);
      throw new Error(`HTTP ${resp.status}`);
    };

    const trusted = isVfsPath && isTrustedDipSource(src);

    resolveContent()
      .then((shtmlContent) => {
        if (disposed || !wrapper.isConnected) return;
        mounted = mountDip(wrapper, shtmlContent, onLick, trusted);
      })
      .catch((err) => {
        if (disposed || (err as { name?: string })?.name === 'AbortError') return;
        wrapper.textContent = `Failed to load dip: ${src}`;
        wrapper.style.cssText =
          'padding:8px;font-size:12px;color:var(--s2-negative);font-family:var(--s2-font-mono)';
      });
  }

  return instances;
}

export function disposeDips(instances: DipInstance[]): void {
  for (const inst of instances) {
    try {
      inst.dispose();
    } catch {}
  }
  instances.length = 0;
}

export async function handleDipPickerAction(
  msg: { type: string; action: string; data?: unknown; picker?: string },
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  const filters = dipPickerFiltersFromData(msg.data);

  if (isExtension) {
    await handleDipPickerActionExtension(msg.picker, msg.action, filters, onLick);
    return;
  }
  switch (msg.picker) {
    case 'directory':
      await runDirectoryPicker(msg.action, onLick);
      return;
    case 'usb-device':
      await runUsbPicker(msg.action, filters, onLick);
      return;
    case 'serial-port':
      await runSerialPicker(msg.action, filters, onLick);
      return;
    case 'hid-device':
      await runHidPicker(msg.action, filters, onLick);
      return;
    default:
      onLick(msg.action, msg.data);
      return;
  }
}

async function handleDipPickerActionExtension(
  picker: string | undefined,
  action: string,
  filters: unknown[],
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  try {
    switch (picker) {
      case 'directory': {
        const { openMountPickerPopup } = await import('../fs/mount-picker-popup.js');
        const res = await openMountPickerPopup();
        if (res.cancelled) onLick(action, { cancelled: true });
        else if (res.error) onLick(action, { error: res.error });
        else if (res.idbKey)
          onLick(action, {
            handleInIdb: true,
            idbKey: res.idbKey,
            dirName: res.dirName ?? '',
          });
        else onLick(action, { error: 'mount picker returned no handle key' });
        return;
      }
      case 'usb-device': {
        const { openUsbPickerPopup } = await import('../shell/supplemental-commands/usb-picker.js');
        const res = await openUsbPickerPopup(filters as Parameters<typeof openUsbPickerPopup>[0]);

        if ('cancelled' in res) onLick(action, { cancelled: true });
        else if ('error' in res) onLick(action, { error: res.error });
        else onLick(action, { granted: true, info: res.info });
        return;
      }
      case 'serial-port': {
        const { openSerialPickerPopup } = await import(
          '../shell/supplemental-commands/serial-picker.js'
        );
        const res = await openSerialPickerPopup(
          filters as Parameters<typeof openSerialPickerPopup>[0]
        );
        if ('cancelled' in res) onLick(action, { cancelled: true });
        else if ('error' in res) onLick(action, { error: res.error });
        else onLick(action, { granted: true, info: res.info });
        return;
      }
      case 'hid-device': {
        const { openHidPickerPopup } = await import('../shell/supplemental-commands/hid-picker.js');
        const res = await openHidPickerPopup(filters as Parameters<typeof openHidPickerPopup>[0]);
        if ('cancelled' in res) onLick(action, { cancelled: true });
        else if ('error' in res) onLick(action, { error: res.error });
        else onLick(action, { granted: true, info: res.info });
        return;
      }
      default:
        onLick(action, { error: `unknown picker kind: ${picker ?? '(none)'}` });
        return;
    }
  } catch (err: unknown) {
    onLick(action, { error: err instanceof Error ? err.message : String(err) });
  }
}

async function requestPickerFromSurface(
  kind: PermissionKind,
  opts?: PermissionRequestOptions
): Promise<
  | { ok: true; grant: PermissionGrant }
  | { ok: false; reason: PermissionDenyDetail['reason']; message?: string }
  | null
> {
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;

  const denyRef: { current: PermissionDenyDetail | null } = { current: null };
  const onDeny = (event: Event): void => {
    const detail = (event as CustomEvent<PermissionDenyDetail>).detail;
    if (detail.kind === kind) denyRef.current = detail;
  };
  surface.addEventListener('slicc-permission-deny', onDeny);
  try {
    const grant = await surface.request(kind, opts);
    if (grant) return { ok: true, grant };
    const deny = denyRef.current;
    return {
      ok: false,
      reason: deny?.reason ?? 'error',
      ...(deny?.message ? { message: deny.message } : {}),
    };
  } finally {
    surface.removeEventListener('slicc-permission-deny', onDeny);
  }
}

function dispatchPickerDenial(
  action: string,
  denial: { reason: PermissionDenyDetail['reason']; message?: string },
  unavailableMessage: string,
  onLick: (action: string, data: unknown) => void
): void {
  if (denial.reason === 'cancelled') {
    onLick(action, { cancelled: true });
    return;
  }
  if (denial.reason === 'unavailable') {
    onLick(action, { error: unavailableMessage });
    return;
  }
  onLick(action, { error: denial.message ?? 'unknown error' });
}

async function runDirectoryPicker(
  action: string,
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  const result = await requestPickerFromSurface('filesystem');
  if (!result) {
    onLick(action, { error: 'File System Access API not available' });
    return;
  }
  if (!result.ok) {
    dispatchPickerDenial(action, result, 'File System Access API not available', onLick);
    return;
  }
  const grant = result.grant as Extract<PermissionGrant, { kind: 'filesystem' }>;
  const handle = grant.handle;
  const idbKey = `pendingMount:dip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { storePendingHandle } = await import('../fs/mount-picker-popup.js');
    await storePendingHandle(idbKey, handle);
  } catch (err: unknown) {
    onLick(action, {
      error: `failed to store directory handle: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  onLick(action, { handleInIdb: true, idbKey, dirName: handle.name });
}

async function runUsbPicker(
  action: string,
  filters: unknown[],
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  const result = await requestPickerFromSurface('usb', { filters });
  if (!result) {
    onLick(action, { error: 'WebUSB is not available' });
    return;
  }
  if (!result.ok) {
    dispatchPickerDenial(action, result, 'WebUSB is not available', onLick);
    return;
  }
  const grant = result.grant as Extract<PermissionGrant, { kind: 'usb' }>;
  const { getSharedUsbRegistry, deviceToInfo } = await import('../kernel/usb-device-registry.js');
  const registry = getSharedUsbRegistry();
  const handle = registry.register(grant.device as Parameters<typeof registry.register>[0]);
  const info = deviceToInfo(handle, grant.device as Parameters<typeof deviceToInfo>[1]);
  onLick(action, { granted: true, handle, info });
}

async function runSerialPicker(
  action: string,
  filters: unknown[],
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  const result = await requestPickerFromSurface('serial', filters.length ? { filters } : undefined);
  if (!result) {
    onLick(action, { error: 'Web Serial is not available' });
    return;
  }
  if (!result.ok) {
    dispatchPickerDenial(action, result, 'Web Serial is not available', onLick);
    return;
  }
  const grant = result.grant as Extract<PermissionGrant, { kind: 'serial' }>;
  const serialMod = await import('../kernel/serial-port-registry.js');
  const registry = serialMod.getSharedSerialRegistry();
  const handle = registry.register(grant.port as Parameters<typeof registry.register>[0]);
  const entry = registry.get(handle);
  const info = entry ? serialMod.deviceToInfo(handle, entry) : { handle };
  onLick(action, { granted: true, handle, info });
}

async function runHidPicker(
  action: string,
  filters: unknown[],
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  const result = await requestPickerFromSurface('hid', { filters });
  if (!result) {
    onLick(action, { error: 'WebHID is not available' });
    return;
  }
  if (!result.ok) {
    dispatchPickerDenial(action, result, 'WebHID is not available', onLick);
    return;
  }

  const grant = result.grant as Extract<PermissionGrant, { kind: 'hid' }>;
  const { getSharedHidRegistry, hidDeviceToInfo } = await import(
    '../kernel/hid-device-registry.js'
  );
  const registry = getSharedHidRegistry();
  const infos = (grant.devices as unknown[]).map((d) => {
    const handle = registry.register(d as Parameters<typeof registry.register>[0]);
    return hidDeviceToInfo(handle, d as Parameters<typeof hidDeviceToInfo>[1]);
  });
  const primary = infos[0];
  onLick(action, { granted: true, handle: primary.handle, info: primary, devices: infos });
}

function mountDipExtension(
  container: HTMLElement,
  srcdoc: string,
  onLick: (action: string, data: unknown) => void,
  trusted = false
): DipInstance {
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  container.appendChild(iframe);

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;

    if (msg.type === 'dip-lick') {
      onLick(msg.action, msg.data);
    } else if (msg.type === 'dip-height') {
      iframe.style.height = msg.height + 'px';
    } else if (msg.type === 'dip-open-link') {
      openDipLink(msg.url);
    } else if (
      msg.type === 'dip-readfile' ||
      msg.type === 'dip-exists' ||
      msg.type === 'dip-stat'
    ) {
      void handleDipVfsRequest(iframe.contentWindow, msg);
    } else if (msg.type === 'dip-exec' || msg.type === 'dip-agent' || msg.type === 'dip-jsh') {
      void handleDipExecRequest(iframe.contentWindow, msg);
    } else if (msg.type === 'dip-device-op') {
      void handleDipDeviceRequest(iframe.contentWindow, msg);
    } else if (msg.type === 'dip-picker-action') {
      void handleDipPickerAction(msg, onLick);
    }
  };
  window.addEventListener('message', messageHandler);

  iframe.addEventListener(
    'load',
    () => {
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.add(iframe.contentWindow);
        if (trusted) trustedDipWindows.add(iframe.contentWindow);
      }
      iframe.contentWindow?.postMessage(
        { type: 'dip-render', srcdoc, isLight: isThemeLight() },
        '*'
      );
    },
    { once: true }
  );

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.delete(iframe.contentWindow);
        trustedDipWindows.delete(iframe.contentWindow);
        disposeDipHidSubs(iframe.contentWindow);
      }
      iframe.remove();
    },
  };
}

function mountDraftDipExtension(
  srcdoc: string,
  onLick: (action: string, data: unknown) => void
): DraftDipInstance {
  const iframe = document.createElement('iframe');
  iframe.src = chrome.runtime.getURL('sprinkle-sandbox.html');
  iframe.style.cssText =
    'width:100%;border:none;overflow:hidden;display:block;pointer-events:none;';

  let ready = false;
  let pendingContent: string | null = null;
  let lastSent: string | null = null;
  const sendUpdate = (content: string) => {
    if (lastSent === content) return;
    lastSent = content;
    iframe.contentWindow?.postMessage({ type: 'dip-draft-update', content }, '*');
  };

  const messageHandler = (event: MessageEvent) => {
    if (event.source !== iframe.contentWindow) return;
    const msg = event.data;
    if (!msg?.type) return;
    if (msg.type === 'dip-lick') onLick(msg.action, msg.data);
    else if (msg.type === 'dip-height') iframe.style.height = msg.height + 'px';
    else if (msg.type === 'dip-open-link') openDipLink(msg.url);
  };
  window.addEventListener('message', messageHandler);

  iframe.addEventListener(
    'load',
    () => {
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) liveDipWindows.add(iframe.contentWindow);
      iframe.contentWindow?.postMessage(
        { type: 'dip-draft-render', srcdoc, isLight: isThemeLight() },
        '*'
      );
      ready = true;
      if (pendingContent !== null) {
        sendUpdate(pendingContent);
        pendingContent = null;
      }
    },
    { once: true }
  );

  return {
    element: iframe,
    update(content: string) {
      if (ready) sendUpdate(content);
      else pendingContent = content;
    },
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) liveDipWindows.delete(iframe.contentWindow);
      iframe.remove();
    },
  };
}
