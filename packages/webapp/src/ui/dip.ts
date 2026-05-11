// dips module
/**
 * Dips — hydrates ```shtml fenced code blocks and ![](/path.shtml) image
 * references in chat messages
 * into sandboxed srcdoc iframes with a minimal lick-only bridge.
 *
 * Cards are ephemeral (no state persistence, no readFile). Lick events
 * route to the cone via the onLick callback. Auto-height via ResizeObserver.
 */

import FS from '@isomorphic-git/lightning-fs';
import { collectThemeCSS } from './sprinkle-renderer.js';
import { isThemeLight, registerSprinkleWindow, unregisterSprinkleWindow } from './theme.js';

const isExtension =
  typeof chrome !== 'undefined' && !!(chrome as { runtime?: { id?: string } })?.runtime?.id;

/**
 * Fallback VFS reader for `.shtml` dips. The preview service worker is
 * the canonical way to fetch VFS content (it normalizes mounts, MIME
 * types, etc.), but on the very first install of a page the SW may not
 * be controlling yet — `clients.claim()` happens asynchronously, so
 * `/preview/*` requests fall through to the dev server and 404. This
 * direct reader bypasses the network entirely and reads the same
 * LightningFS database the SW uses, so dips render correctly even on
 * the first uncontrolled boot.
 */
let lfsReader: FS.PromisifiedFS | null = null;
function getLfsReader(): FS.PromisifiedFS {
  if (!lfsReader) lfsReader = new FS('slicc-fs').promises;
  return lfsReader;
}

/**
 * Path prefixes a dip is allowed to source from AND read from via the
 * VFS bridge. Inline ```shtml fenced blocks (agent-emitted) are never
 * trusted because the cone could relay attacker-controlled content.
 * Image dips loaded from a VFS path under one of these prefixes are
 * trusted because the user (or the bundled vfs-root) installed them.
 *
 * Keep this list short. Adding a prefix grants any .shtml under it
 * read access to every other path on the same allowlist.
 */
const TRUSTED_DIP_SOURCE_PREFIXES = [
  '/shared/sprinkles/',
  '/workspace/skills/sprinkles/',
  '/workspace/sprinkles/',
];

/**
 * Path prefixes a trusted dip may read via the VFS bridge. Narrower
 * than the source allowlist so a compromised welcome dip can't read
 * arbitrary user files (e.g. /home/**, repository working copies).
 */
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

/** Iframes whose dip source was trusted — eligible for the VFS bridge. */
const trustedDipWindows = new WeakSet<Window>();

async function readShtmlFromVFS(vfsPath: string, signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  const lfs = getLfsReader();
  const raw = await lfs.readFile(vfsPath, 'utf8');
  if (signal?.aborted) throw new DOMException('aborted', 'AbortError');
  return typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
}

/** Minimal bridge script: lick + read-only VFS + auto-height. */
const BRIDGE_SCRIPT = `(function() {
  var _cbId = 0;
  var _callbacks = {};

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
    }
  };
  function reportHeight() {
    parent.postMessage({ type: 'dip-height',
      height: document.documentElement.scrollHeight }, '*');
  }
  window.addEventListener('message', function(e) {
    if (!e.data || typeof e.data.type !== 'string') return;
    if (e.data.type === 'slicc-theme') {
      document.documentElement.classList.toggle('theme-light', !!e.data.isLight);
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
           Phase 2b.6 — forward as a separate message so the parent can
           run showDirectoryPicker, stash the handle in IDB, then dispatch
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

export interface DipInstance {
  dispose(): void;
}

/**
 * Inline draft of a dip whose content streams in over time. The chat
 * panel mounts one of these as soon as a fenced ```shtml block opens
 * during an in-flight assistant message, then calls `update()` with the
 * accumulating partial markup. Disposed before final `hydrateDips()`
 * runs so the trusted iframe replaces the draft cleanly.
 */
export interface DraftDipInstance {
  /** The iframe element. Caller is responsible for placement. */
  readonly element: HTMLIFrameElement;
  /** Push a new partial shtml content string into the draft. */
  update(content: string): void;
  /** Tear down the iframe and detach listeners. */
  dispose(): void;
}

/**
 * Pull the body of every fenced ```shtml block out of an in-flight
 * assistant message. Closed blocks (`...```\n`) and the trailing
 * unclosed block (still streaming) are both captured, in document
 * order, so callers can match each entry to its corresponding
 * placeholder/draft iframe by index.
 */
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

/** A segment of an in-flight assistant message: prose markdown or shtml. */
export type ContentSegment =
  | { kind: 'prose'; text: string }
  | { kind: 'shtml'; body: string; closed: boolean };

/**
 * Split `content` into ordered segments at every ```shtml fence boundary.
 * Each shtml block (open or closed) becomes its own segment so the chat
 * panel can give it a stable container — iframes inside that container
 * never get re-parented across re-renders, which is what avoids the
 * iframe-reload-per-frame failure mode that wiping an `innerHTML` parent
 * triggers in WHATWG-compliant browsers.
 */
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

/** Common styles injected into every dip iframe (final + draft). */
const DIP_HOST_STYLES = `html,body{margin:0;padding:0;overflow:hidden;background:transparent;box-sizing:border-box}
*,*::before,*::after{box-sizing:inherit}
/* Vertical breathing room around dip content. Horizontal padding is owned
   by the dip's own content (e.g. .sprinkle-action-card__body) so shtml
   widgets that already pad themselves don't end up double-indented. The
   ResizeObserver on document.body reports the post-padding scrollHeight
   correctly, so auto-height continues to work. */
body{padding:12px 0;font-family:var(--s2-font-family, sans-serif);font-size:13px;color:var(--s2-content-default)}
.sprinkle-inline{padding:var(--s2-spacing-100) 0}
.sprinkle-inline .sprinkle-btn{padding:4px 12px;font-size:12px;height:28px;box-shadow:none}
.sprinkle-inline .sprinkle-btn:not([class*="sprinkle-btn--"]){background:var(--s2-bg-elevated)}
.sprinkle-inline .sprinkle-card{box-shadow:none;margin:0}
.sprinkle-inline .sprinkle-action-card{margin:0;width:100%}
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

/**
 * Listens for `dip-draft-update` messages from the parent and replaces the
 * iframe body content with the new partial shtml. Lucide icons are re-run
 * after each update so newly-arrived `<i data-lucide>` markers materialize.
 * Custom elements (slicc-editor, slicc-diff) are upgraded automatically
 * by the browser when their tags appear in the DOM.
 */
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

function buildDipSrcdoc(content: string, isDraft: boolean): string {
  const themeCSS = collectThemeCSS();
  const htmlClass = isThemeLight() ? ' class="theme-light"' : '';
  // Drafts can't introspect content (it streams), so always include the
  // custom element bundles. Final dips only include them when needed to
  // keep the srcdoc small for short-lived widgets.
  const includeEditor = isDraft || content.includes('<slicc-editor');
  const includeDiff = isDraft || content.includes('<slicc-diff');
  const draftScript = isDraft ? `<script>${DRAFT_BRIDGE_EXTENSION}</script>` : '';
  return `<!DOCTYPE html>
<html${htmlClass}><head>
<meta charset="utf-8">
<style>${themeCSS}</style>
<style>${DIP_HOST_STYLES}</style>
<script>${BRIDGE_SCRIPT}</script>
${draftScript}
${includeEditor ? '<script src="/slicc-editor.js"></script>' : ''}
${includeDiff ? '<script src="/slicc-diff.js"></script>' : ''}
<script src="/lucide-icons.js"></script>
</head>
<body class="sprinkle-inline">${content}</body></html>`;
}

/**
 * Live dip iframes. Used by `broadcastToDips` so the host UI can post
 * a message to every mounted dip — handy for cases where a workflow
 * spans multiple turns (e.g. the onboarding `connect-llm` dip needs
 * to learn whether the parent's API-key probe succeeded).
 */
const liveDipWindows = new Set<Window>();

/**
 * Post a `slicc-*` payload to every live dip iframe. Dips listen for
 * matching `slicc-message` CustomEvents on `document` (see
 * `BRIDGE_SCRIPT`). Closed/detached iframes are ignored automatically
 * because they're removed from the registry on dispose().
 */
export function broadcastToDips(payload: { type: string; [k: string]: unknown }): void {
  if (typeof payload?.type !== 'string' || payload.type.indexOf('slicc-') !== 0) {
    throw new Error("broadcastToDips: payload.type must start with 'slicc-'");
  }
  for (const win of liveDipWindows) {
    try {
      win.postMessage(payload, '*');
    } catch {
      /* Closed iframes throw — ignore. */
    }
  }
}

/**
 * Mount an dip iframe in the given container element.
 * Exported for reuse by tool-ui-renderer (sprinkle chat).
 *
 * `trusted` controls whether the dip's bridge can use the read-only
 * VFS API (`slicc.readFile` etc.). Inline ```shtml from chat is
 * never trusted; only dips sourced from a VFS path under
 * TRUSTED_DIP_SOURCE_PREFIXES get the bridge.
 */
export function mountDip(
  container: HTMLElement,
  content: string,
  onLick: (action: string, data: unknown) => void,
  trusted = false
): DipInstance {
  const srcdoc = buildDipSrcdoc(content, /* isDraft */ false);

  if (isExtension) {
    return mountDipExtension(container, srcdoc, onLick, trusted);
  }

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  iframe.style.cssText = 'width:100%;border:none;overflow:hidden;display:block;';
  iframe.srcdoc = srcdoc;
  container.appendChild(iframe);
  // Register the contentWindow synchronously so dips that emit a
  // `connect-ready`-style lick during their initial inline script can
  // still receive the parent's response. The `load` event fires AFTER
  // the script has run, so waiting for it loses the first round-trip.
  if (iframe.contentWindow) {
    registerSprinkleWindow(iframe.contentWindow);
    liveDipWindows.add(iframe.contentWindow);
    if (trusted) trustedDipWindows.add(iframe.contentWindow);
  }
  iframe.addEventListener(
    'load',
    () => {
      // Re-register defensively — some browsers swap contentWindow on
      // the first `load` event for srcdoc iframes.
      registerSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.add(iframe.contentWindow);
        if (trusted) trustedDipWindows.add(iframe.contentWindow);
      }
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
      // Phase 2b.6 — picker buttons (`data-picker="directory"`)
      // post their click here instead of inline `dip-lick` so the
      // parent can run `showDirectoryPicker` on the propagated
      // user activation, stash the handle in IDB, then dispatch
      // the lick with `{ handleInIdb, idbKey, dirName }`. Until
      // this case landed, the message arrived at `mountDip` but
      // nothing dispatched to `handleDipPickerAction` — every
      // mount-dialog "Select directory" click was a silent no-op.
      void handleDipPickerAction(msg, onLick);
    } else if (
      msg.type === 'dip-readfile' ||
      msg.type === 'dip-exists' ||
      msg.type === 'dip-stat'
    ) {
      void handleDipVfsRequest(iframe.contentWindow, msg);
    }
  };
  window.addEventListener('message', messageHandler);

  return {
    dispose() {
      window.removeEventListener('message', messageHandler);
      unregisterSprinkleWindow(iframe.contentWindow);
      if (iframe.contentWindow) {
        liveDipWindows.delete(iframe.contentWindow);
        trustedDipWindows.delete(iframe.contentWindow);
      }
      iframe.remove();
    },
  };
}

/**
 * Mount a streaming-draft dip iframe. The caller is responsible for
 * placement (the returned `element` is detached on construction so it
 * can be re-parented across re-renders without reloading the iframe —
 * critical, otherwise every animation-frame flush would tear down the
 * preview).
 *
 * Drafts are NEVER trusted: they're not registered in `trustedDipWindows`
 * and the bridge does not service VFS requests for them. Lick + auto-
 * height + link-open all work the same as final dips so partial UI is
 * still interactive (within the same security model as inline shtml).
 *
 * Extension mode routes through `sprinkle-sandbox.html` (CSP-exempt
 * manifest sandbox) — same shape as the final-dip path, just with a
 * `dip-draft-render` setup message and `dip-draft-update` relay for
 * incremental body swaps. The chat panel's segment renderer keeps the
 * iframe pinned to its container in both runtimes, so re-parenting
 * isn't an issue here.
 */
export function mountDraftDip(onLick: (action: string, data: unknown) => void): DraftDipInstance {
  const srcdoc = buildDipSrcdoc('', /* isDraft */ true);
  if (isExtension) return mountDraftDipExtension(srcdoc, onLick);

  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts allow-same-origin');
  // `pointer-events:none` keeps users from clicking partial UI while the
  // agent is still writing it — half-typed `slicc.lick()` arguments or
  // unfinished forms shouldn't be reachable. Final dips replace the draft
  // on stream end and get the normal interactive iframe styles.
  iframe.style.cssText =
    'width:100%;border:none;overflow:hidden;display:block;pointer-events:none;';
  iframe.srcdoc = srcdoc;

  // Drafts queue updates that arrive before the iframe finishes loading.
  // The first post-load update flushes the queue.
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
    // Drafts never service VFS requests — silently ignore them.
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

/**
 * Handle a `dip-readfile` / `dip-exists` / `dip-stat` request from a
 * dip iframe. Reads from the same LightningFS the preview SW uses, so
 * onboarding markers / profiles / etc. are visible to the dip without
 * a parent-side handshake. Returns `true` when the message was handled.
 *
 * Two layers of access control:
 *
 * 1. The iframe's contentWindow must be in `trustedDipWindows`. Inline
 *    ```shtml from chat is never registered there, so an
 *    attacker-controlled cone reply can't read user files.
 * 2. The requested path must match a TRUSTED_DIP_READ_PREFIXES entry.
 *    A compromised welcome dip can't escape its sandbox to read
 *    `/home/**` / repository working copies / etc.
 */
async function handleDipVfsRequest(
  iframeWindow: Window | null,
  msg: { type: string; id?: number; path?: string }
): Promise<boolean> {
  if (!iframeWindow || typeof msg.id !== 'number') return false;
  const path = typeof msg.path === 'string' ? msg.path : '';
  const lfs = getLfsReader();
  const respond = (payload: Record<string, unknown>) => {
    try {
      iframeWindow.postMessage({ ...payload, id: msg.id }, '*');
    } catch {
      /* iframe gone — ignore */
    }
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
    try {
      const raw = await lfs.readFile(path, 'utf8');
      const content = typeof raw === 'string' ? raw : new TextDecoder().decode(raw as Uint8Array);
      respond({ type: 'dip-readfile-response', content });
    } catch (err) {
      respond({
        type: 'dip-readfile-response',
        error: err instanceof Error ? err.message : 'Read failed',
      });
    }
    return true;
  }
  if (msg.type === 'dip-exists') {
    try {
      await lfs.stat(path);
      respond({ type: 'dip-exists-response', exists: true });
    } catch {
      respond({ type: 'dip-exists-response', exists: false });
    }
    return true;
  }
  if (msg.type === 'dip-stat') {
    try {
      const st = await lfs.stat(path);
      respond({
        type: 'dip-stat-response',
        stat: {
          isFile: st.isFile(),
          isDirectory: st.isDirectory(),
          size: st.size,
          mtimeMs: st.mtimeMs,
        },
      });
    } catch (err) {
      respond({
        type: 'dip-stat-response',
        error: err instanceof Error ? err.message : 'Stat failed',
      });
    }
    return true;
  }
  return false;
}

/**
 * Open a link from a sandboxed dip in a new tab. Only http(s)
 * and mailto: URLs are allowed to avoid navigating the host page through
 * javascript:/data: schemes relayed from the iframe.
 */
function openDipLink(url: unknown): void {
  if (typeof url !== 'string' || !url) return;
  if (!/^(https?:|mailto:)/i.test(url)) return;
  try {
    window.open(url, '_blank', 'noopener,noreferrer');
  } catch {
    /* extension window.open may return null — fire and forget */
  }
}

/**
 * Find all `code.language-shtml` blocks and `img[src$=".shtml"]` elements in
 * a container, replace them with sandboxed dip iframes. Image references are
 * loaded asynchronously via the VFS preview path. Returns instances for
 * lifecycle tracking — image-path entries are placeholders whose `dispose()`
 * aborts the in-flight fetch and tears down whatever iframe (if any) was
 * eventually mounted, so callers can rely on disposal even when hydration is
 * still in flight.
 */
export function hydrateDips(
  containerEl: HTMLElement,
  onLick: (action: string, data: unknown) => void
): DipInstance[] {
  const instances: DipInstance[] = [];

  //    Fenced ```shtml code blocks
  // Inline dips come from agent output and are NEVER trusted — even if
  // the cone is benign today, a future webhook/scoop could relay
  // attacker-controlled markdown that exfiltrates user files via the
  // VFS bridge.
  const codeEls = containerEl.querySelectorAll<HTMLElement>('pre > code.language-shtml');
  for (const codeEl of codeEls) {
    const preEl = codeEl.parentElement!;
    const shtmlContent = codeEl.textContent ?? '';

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    preEl.replaceWith(wrapper);

    instances.push(mountDip(wrapper, shtmlContent, onLick, /* trusted */ false));
  }

  //    ![alt](/path/to/file.shtml) image references                  
  const imgEls = containerEl.querySelectorAll<HTMLImageElement>('img[src$=".shtml"]');
  for (const imgEl of imgEls) {
    const src = imgEl.getAttribute('src');
    if (!src) continue;

    const wrapper = document.createElement('div');
    wrapper.className = 'msg__dip';
    if (imgEl.alt) wrapper.setAttribute('title', imgEl.alt);
    imgEl.replaceWith(wrapper);

    // Each pending image becomes a placeholder DipInstance immediately so
    // the caller's lifecycle bookkeeping (chat-panel's per-message map) sees
    // a non-empty array even before the async fetch resolves. The placeholder
    // owns an AbortController + a flag so dispose() cancels the fetch and
    // tears down whatever iframe (if any) was eventually mounted.
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

    // Resolve the .shtml content. Prefer the preview service worker
    // (handles mounts, MIME types, project-serve mode, etc.), but fall
    // back to a direct LightningFS read for VFS-rooted paths so dips
    // still render on the very first boot before the SW claims the
    // page. Only paths starting with `/` are read directly; relative
    // / cross-origin URLs always go through the network.
    const isVfsPath = src.startsWith('/');
    const swControlled = typeof navigator !== 'undefined' && !!navigator.serviceWorker?.controller;
    const fetchUrl = isVfsPath ? `/preview${src}` : src;

    const resolveContent = async (): Promise<string> => {
      if (isVfsPath && !swControlled) {
        // SW isn't controlling — go straight to LightningFS.
        return readShtmlFromVFS(src, controller.signal);
      }
      // The extension side panel registers its own
      // chrome-extension:// service worker that handles routing for
      // the extension UI but doesn't intercept `/preview/*` like the
      // standalone dev-server SW does. `navigator.serviceWorker.
      // controller` is still truthy, so we can't rely on `swControlled`
      // alone — wrap the fetch and treat any rejection as a signal to
      // fall back to the direct LightningFS read for VFS paths.
      let resp: Response;
      try {
        resp = await fetch(fetchUrl, { signal: controller.signal });
      } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw err;
        if (isVfsPath) return readShtmlFromVFS(src, controller.signal);
        throw err;
      }
      if (resp.ok) return resp.text();
      // Some dev-server responses bypass the SW even when it claims to
      // be controlling (e.g. extension boot, stale registration).
      // Retry once via direct LightningFS for VFS paths before failing.
      if (isVfsPath) return readShtmlFromVFS(src, controller.signal);
      throw new Error(`HTTP ${resp.status}`);
    };

    // Image-sourced dips are trusted only when they live under a known
    // sprinkles directory — the welcome flow / installed sprinkles. A
    // .shtml the agent wrote to /scoops/foo/x.shtml does NOT get the
    // VFS bridge.
    const trusted = isVfsPath && isTrustedDipSource(src);

    resolveContent()
      .then((shtmlContent) => {
        // Skip mounting if dispose() ran while the fetch was in flight, or
        // if the wrapper was detached from the DOM by some other path.
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

/** Dispose all dip instances and clear the array. */
export function disposeDips(instances: DipInstance[]): void {
  for (const inst of instances) {
    try {
      inst.dispose();
    } catch {
      /* best-effort cleanup */
    }
  }
  instances.length = 0;
}

/**
 * Handle a `dip-picker-action` from a CLI dip: run the File System
 * Access picker on the click activation chain, stash the granted
 * `FileSystemDirectoryHandle` in the shared mount-handle IDB store,
 * then forward the click as an `onLick` carrying `{ handleInIdb,
 * idbKey, dirName }` so a worker-resident `LocalMountBackend.create`
 * (Phase 2b.6) can pick it up via `loadAndClearPendingHandle`.
 *
 * In standalone-CLI (non-worker) mode the same plumbing works: the
 * agent's `onAction` handler already has the `handleInIdb` branch and
 * reads from IDB instead of calling `showDirectoryPicker` itself.
 *
 * Errors / cancellations are surfaced as `{ cancelled: true }` /
 * `{ error: <msg> }` so the agent's existing onAction handler renders
 * them through its own error path.
 */
async function handleDipPickerAction(
  msg: { type: string; action: string; data?: unknown; picker?: string },
  onLick: (action: string, data: unknown) => void
): Promise<void> {
  if (msg.picker !== 'directory') {
    // Unknown picker kind — forward as a regular lick so the action
    // still reaches the registry.
    onLick(msg.action, msg.data);
    return;
  }
  const win = window as Window & {
    showDirectoryPicker?: (opts?: { mode?: string }) => Promise<FileSystemDirectoryHandle>;
  };
  if (typeof win.showDirectoryPicker !== 'function') {
    onLick(msg.action, { error: 'File System Access API not available' });
    return;
  }
  let handle: FileSystemDirectoryHandle;
  try {
    handle = await win.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'AbortError') {
      onLick(msg.action, { cancelled: true });
      return;
    }
    onLick(msg.action, { error: err instanceof Error ? err.message : String(err) });
    return;
  }
  const idbKey = `pendingMount:dip-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  try {
    const { storePendingHandle } = await import('../fs/mount-picker-popup.js');
    await storePendingHandle(idbKey, handle);
  } catch (err: unknown) {
    onLick(msg.action, {
      error: `failed to store directory handle: ${err instanceof Error ? err.message : String(err)}`,
    });
    return;
  }
  onLick(msg.action, { handleInIdb: true, idbKey, dirName: handle.name });
}

/**
 * Extension mode: route dip through the manifest sandbox (CSP-exempt).
 * The sandbox creates a nested srcdoc iframe and relays messages back.
 */
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
      }
      iframe.remove();
    },
  };
}

/**
 * Extension-mode draft dip. Mirrors `mountDipExtension` but with
 * draft-specific wiring:
 *
 * - Posts `dip-draft-render { srcdoc }` instead of `dip-render` so the
 *   sandbox knows to mount the child iframe in non-interactive mode.
 * - `update(content)` posts `dip-draft-update { content }` to the
 *   sandbox; the sandbox relays it to the nested child iframe, where
 *   the `DRAFT_BRIDGE_EXTENSION` listener (already inlined into the
 *   draft srcdoc by `buildDipSrcdoc`) replaces `document.body.innerHTML`.
 * - `pointer-events: none` lives on the outer (sandbox) iframe and on
 *   the inner srcdoc — both layers block clicks until final hydration.
 *
 * The element is detached on construction so the caller (the chat
 * panel's segment renderer) controls placement. Drafts are not
 * registered in `trustedDipWindows` and never service VFS requests.
 */
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
    // Drafts never service VFS requests — silently ignore them.
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
