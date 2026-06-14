/**
 * Accessibility snapshot rendering plus actionable-page resolution for the
 * playwright-cli command family.
 */

import type { BrowserAPI, PageInfo } from '../../../cdp/index.js';
import { normalizeAccessibilityText } from '../../../cdp/normalize-accessibility-text.js';
import type { AccessibilityNode } from '../../../cdp/types.js';
import { createLogger } from '../../../core/logger.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import {
  TRAY_JOIN_STORAGE_KEY,
  TRAY_WORKER_STORAGE_KEY,
} from '../../../scoops/tray-runtime-config.js';
import type { PlaywrightState, TabSnapshot } from './types.js';

const log = createLogger('playwright');

export function escapeYaml(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function escapeCssAttr(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function renderNode(
  node: AccessibilityNode,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  counter: { value: number },
  indent: string = '',
  framePrefix: string = ''
): string[] {
  const lines: string[] = [];
  const role = normalizeAccessibilityText(node.role, 'unknown').toLowerCase();
  const name = normalizeAccessibilityText(node.name);
  const value = normalizeAccessibilityText(node.value);

  const skipRoles = ['none', 'presentation', 'generic', 'rootwebarea'];
  const needsRef =
    !skipRoles.includes(role) &&
    (name ||
      role === 'textbox' ||
      role === 'button' ||
      role === 'link' ||
      role === 'checkbox' ||
      role === 'radio');

  let ref = '';
  if (needsRef) {
    ref = framePrefix + `e${++counter.value}`;

    // Store backendNodeId for reliable ref-based clicking
    if (node.backendNodeId) {
      refToBackendNodeId.set(ref, node.backendNodeId);
    }

    const escapedName = escapeCssAttr(name);
    let selector = '';
    if (role === 'button' && name) {
      selector = `button[aria-label="${escapedName}"], button[title="${escapedName}"]`;
    } else if (role === 'link' && name) {
      selector = `a[aria-label="${escapedName}"], a[title="${escapedName}"]`;
    } else if (role === 'textbox') {
      if (name) {
        selector = `input[aria-label="${escapedName}"], textarea[aria-label="${escapedName}"], [contenteditable][aria-label="${escapedName}"], input[placeholder="${escapedName}"], textarea[placeholder="${escapedName}"], [contenteditable][placeholder="${escapedName}"], input[title="${escapedName}"], textarea[title="${escapedName}"], [contenteditable][title="${escapedName}"]`;
      } else {
        selector = `input, textarea, [contenteditable]`;
      }
    } else if (role === 'checkbox') {
      selector = `input[type="checkbox"]`;
    } else if (role === 'radio') {
      selector = `input[type="radio"]`;
    } else if (name) {
      selector = `[aria-label="${escapedName}"], [title="${escapedName}"]`;
    } else {
      selector = `[role="${role}"]`;
    }
    refToSelector.set(ref, selector);
  }

  let line = `${indent}- ${role}`;
  if (name) line += ` "${escapeYaml(name)}"`;
  if (ref) line += ` [ref=${ref}]`;
  if (value) line += `: "${escapeYaml(value)}"`;
  lines.push(line);

  if (node.children) {
    for (const child of node.children) {
      lines.push(
        ...renderNode(child, refToSelector, refToBackendNodeId, counter, indent + '  ', framePrefix)
      );
    }
  }
  return lines;
}

export async function resolveAppTabId(browser: BrowserAPI, state: PlaywrightState): Promise<void> {
  if (state.appTabId) return;
  const pages = await browser.listPages();
  const appOrigin = await resolveAppOrigin();
  const appTab = pages.find((p) => p.url.startsWith(appOrigin) && !p.url.includes('/preview/'));
  if (appTab) state.appTabId = appTab.targetId;
}

/**
 * Resolve the origin where the SLICC webapp is served.
 *
 *   - Page context: use `window.location.origin`.
 *   - Kernel worker (standalone agent shell): bridge to the page via
 *     panel-RPC `page-info`. Without this the worker was falling back
 *     to a hardcoded `http://localhost:5710`, which silently broke
 *     `playwright-cli` for any user running on a non-default port
 *     (e.g. parallel instances with `PORT=5720 npm run dev`).
 *   - Tests / Node fallback: keep the hardcoded default.
 */
async function resolveAppOrigin(): Promise<string> {
  if (typeof window !== 'undefined') return window.location.origin;
  const rpc = getPanelRpcClient();
  if (rpc) {
    try {
      const info = await rpc.call('page-info', undefined, { timeoutMs: 2000 });
      if (info.origin) return info.origin;
    } catch {
      // Fall through to the hardcoded default rather than failing the
      // whole command; the agent will still try to locate the app tab
      // and surface a clearer error if it can't.
    }
  }
  return 'http://localhost:5710';
}

function isAppTab(state: PlaywrightState, targetId: string): boolean {
  return targetId === state.appTabId;
}

function isChromeInternalUiTarget(page: PageInfo): boolean {
  const url = page.url.trim();
  const title = page.title.trim();

  return (
    title === 'Omnibox Popup' ||
    url.startsWith('chrome://') ||
    url.startsWith('chrome-search://') ||
    url.startsWith('chrome-untrusted://') ||
    url.startsWith('devtools://') ||
    (url.length === 0 && /popup$/i.test(title))
  );
}

function isActionablePage(state: PlaywrightState, page: PageInfo): boolean {
  return !isAppTab(state, page.targetId) && !isChromeInternalUiTarget(page);
}

/**
 * Cheap, synchronous check for whether a multi-browser tray is configured
 * (leader worker URL or follower join URL present). Reads `globalThis.localStorage`
 * — the real Storage on the page, or the page-seeded shim in the kernel worker.
 * Used to skip the `list-remote-targets` panel-RPC round-trip entirely when no
 * tray exists, so plain (non-tray) playwright commands stay at one local call.
 */
function isTrayConfigured(): boolean {
  try {
    const ls = (globalThis as { localStorage?: Storage }).localStorage;
    if (!ls) return false;
    return !!(ls.getItem(TRAY_WORKER_STORAGE_KEY) || ls.getItem(TRAY_JOIN_STORAGE_KEY));
  } catch {
    return false;
  }
}

export async function getActionablePages(
  browser: BrowserAPI,
  state: PlaywrightState
): Promise<PageInfo[]> {
  await resolveAppTabId(browser, state);
  // Use listAllTargets when available (includes remote tray targets).
  // In standalone mode the worker-side BrowserAPI has no trayTargetProvider, so
  // listAllTargets() returns local-only. When a tray is configured, supplement via
  // panel-RPC from the page-side BrowserAPI (fully wired) and dedupe by targetId.
  // The tray-configured gate keeps the no-tray common case to a single local call
  // (no per-command BroadcastChannel round-trip, no 3s-timeout exposure).
  let pages: PageInfo[];
  if (typeof browser.listAllTargets === 'function') {
    pages = await browser.listAllTargets();
    const rpc = isTrayConfigured() ? getPanelRpcClient() : null;
    if (rpc) {
      try {
        const { targets } = await rpc.call('list-remote-targets', undefined, { timeoutMs: 3000 });
        const seen = new Set(pages.map((p) => p.targetId));
        for (const t of targets) {
          if (!seen.has(t.targetId)) {
            seen.add(t.targetId);
            pages.push({ targetId: t.targetId, title: t.title, url: t.url });
          }
        }
      } catch (err) {
        log.debug('panel-rpc list-remote-targets failed', { err: String(err) });
      }
    }
  } else {
    pages = await browser.listPages();
  }
  return pages.filter((page) => isActionablePage(state, page));
}

export async function takeSnapshot(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string,
  options?: { noIframes?: boolean }
): Promise<{ snapshot: TabSnapshot; output: string }> {
  await browser.attachToPage(targetId);
  const pageInfo = await browser.evaluate(
    `JSON.stringify({ url: location.href, title: document.title })`
  );
  const { url, title } = JSON.parse(pageInfo as string);
  const tree = await browser.getAccessibilityTree();
  const refToSelector = new Map<string, string>();
  const refToBackendNodeId = new Map<string, number>();
  const refToFrameId = new Map<string, string>();
  const counter = { value: 0 };
  const snapshotLines = renderNode(tree, refToSelector, refToBackendNodeId, counter);
  let content = snapshotLines.join('\n');

  // Stitch iframe content into the snapshot
  if (!options?.noIframes && typeof browser.getFrameTree === 'function') {
    try {
      const frames = await browser.getFrameTree();
      const childFrames = frames.filter((f) => f.parentFrameId);

      if (childFrames.length > 0) {
        let frameIndex = 0;
        const outputLines = content.split('\n');
        const stitchedLines: string[] = [];
        const matchedFrameIds = new Set<string>();

        for (const line of outputLines) {
          stitchedLines.push(line);

          // Match iframe placeholder lines like: - iframe "Title": "https://example.com/frame"
          const iframeMatch = line.match(/^(\s*)- iframe\s/);
          if (!iframeMatch) continue;

          // Extract the src URL from the iframe placeholder value
          const valueMatch = line.match(/:\s*"([^"]+)"\s*$/);
          if (!valueMatch) continue;
          const iframeSrc = valueMatch[1];

          // Find matching child frame by URL
          const matchedFrame = childFrames.find((f) => {
            if (matchedFrameIds.has(f.frameId)) return false;
            try {
              // Compare normalized URLs (ignoring trailing slashes, fragments, but including query strings)
              const frameUrl = new URL(f.url);
              const srcUrl = new URL(iframeSrc, url);
              const normalizedSrc =
                srcUrl.origin + srcUrl.pathname.replace(/\/$/, '') + srcUrl.search;
              const normalizedFrame =
                frameUrl.origin + frameUrl.pathname.replace(/\/$/, '') + frameUrl.search;
              return normalizedFrame === normalizedSrc;
            } catch {
              return f.url === iframeSrc;
            }
          });

          if (!matchedFrame) continue;
          matchedFrameIds.add(matchedFrame.frameId);

          frameIndex++;
          const framePrefix = `f${frameIndex}`;
          const indent = iframeMatch[1] + '  ';

          try {
            const frameTree = await browser.getAccessibilityTreeForFrame(matchedFrame.frameId);
            const frameRefToSelector = new Map<string, string>();
            const frameRefToBackendNodeId = new Map<string, number>();
            const frameCounter = { value: 0 };
            const frameLines = renderNode(
              frameTree,
              frameRefToSelector,
              frameRefToBackendNodeId,
              frameCounter,
              indent,
              framePrefix
            );

            // Merge frame refs into main maps
            for (const [ref, selector] of frameRefToSelector) {
              refToSelector.set(ref, selector);
              refToFrameId.set(ref, matchedFrame.frameId);
            }
            for (const [ref, nodeId] of frameRefToBackendNodeId) {
              refToBackendNodeId.set(ref, nodeId);
              refToFrameId.set(ref, matchedFrame.frameId);
            }

            stitchedLines.push(...frameLines);
          } catch {
            // Cross-origin frames or other failures — keep the placeholder
          }
        }

        content = stitchedLines.join('\n');
      }
    } catch {
      // getFrameTree failed — keep the snapshot without iframe content
    }
  }

  const snapshot: TabSnapshot = {
    url,
    title,
    refToSelector,
    refToBackendNodeId,
    refToFrameId,
    content,
    timestamp: Date.now(),
  };
  state.snapshots.set(targetId, snapshot);

  const output = [`Page URL: ${url}`, `Page Title: ${title}`, '', content].join('\n');
  return { snapshot, output };
}
