/**
 * Accessibility snapshot rendering plus actionable-page resolution for the
 * playwright-cli command family.
 */

import type { BrowserAPI, PageInfo } from '../../../cdp/index.js';
import { normalizeAccessibilityText } from '../../../cdp/normalize-accessibility-text.js';
import type { AccessibilityNode } from '../../../cdp/types.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import { listFederatedTargets } from '../../../scoops/federated-targets.js';
import type { PlaywrightState, TabSnapshot } from './types.js';

export function escapeYaml(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function escapeCssAttr(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

const SKIP_REF_ROLES = ['none', 'presentation', 'generic', 'rootwebarea'];
const REF_ROLES = ['textbox', 'button', 'link', 'checkbox', 'radio'];

function nodeNeedsRef(role: string, name: string): boolean {
  if (SKIP_REF_ROLES.includes(role)) return false;
  return !!name || REF_ROLES.includes(role);
}

/** Build the CSS selector recorded for a ref, given its role and accessible name. */
function buildRefSelector(role: string, name: string): string {
  const escapedName = escapeCssAttr(name);
  if (role === 'button' && name) {
    return [
      `button[aria-label="${escapedName}"]`,
      `button[title="${escapedName}"]`,
      `[role="button"][aria-label="${escapedName}"]`,
      `[role="button"][title="${escapedName}"]`,
      `input[type="button"][value="${escapedName}"]`,
      `input[type="submit"][value="${escapedName}"]`,
      `input[type="reset"][value="${escapedName}"]`,
    ].join(', ');
  }
  if (role === 'link' && name) {
    return `a[aria-label="${escapedName}"], a[title="${escapedName}"], [role="link"][aria-label="${escapedName}"], [role="link"][title="${escapedName}"]`;
  }
  if (role === 'textbox') {
    return name
      ? `input[aria-label="${escapedName}"], textarea[aria-label="${escapedName}"], [contenteditable][aria-label="${escapedName}"], input[placeholder="${escapedName}"], textarea[placeholder="${escapedName}"], [contenteditable][placeholder="${escapedName}"], input[title="${escapedName}"], textarea[title="${escapedName}"], [contenteditable][title="${escapedName}"]`
      : `input, textarea, [contenteditable]`;
  }
  if (role === 'checkbox') return `input[type="checkbox"]`;
  if (role === 'radio') return `input[type="radio"]`;
  if (name) return `[aria-label="${escapedName}"], [title="${escapedName}"]`;
  return `[role="${role}"]`;
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

  let ref = '';
  if (nodeNeedsRef(role, name)) {
    ref = framePrefix + `e${++counter.value}`;
    // Store backendNodeId for reliable ref-based clicking
    if (node.backendNodeId) {
      refToBackendNodeId.set(ref, node.backendNodeId);
    }
    refToSelector.set(ref, buildRefSelector(role, name));
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

export async function getActionablePages(
  browser: BrowserAPI,
  state: PlaywrightState
): Promise<PageInfo[]> {
  await resolveAppTabId(browser, state);
  // Local CDP tabs plus the federated tray fleet (followers), then drop the
  // app tab and chrome-internal UI. The aggregation lives in
  // `scoops/federated-targets.ts` so this command and the substrate
  // `/api/targets` handler stay at parity.
  const pages = await listFederatedTargets(browser, getPanelRpcClient);
  return pages.filter((page) => isActionablePage(state, page));
}

interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
}

/** Normalize a URL for frame-matching: ignore trailing slashes/fragments, keep query. */
function normalizeUrlForMatch(rawUrl: string, base?: string): string | null {
  try {
    const u = new URL(rawUrl, base);
    return u.origin + u.pathname.replace(/\/$/, '') + u.search;
  } catch {
    return null;
  }
}

/** Find the (not-yet-matched) child frame whose URL matches an iframe placeholder src. */
function findMatchingChildFrame(
  childFrames: FrameInfo[],
  iframeSrc: string,
  baseUrl: string,
  matchedFrameIds: Set<string>
): FrameInfo | undefined {
  const normalizedSrc = normalizeUrlForMatch(iframeSrc, baseUrl);
  return childFrames.find((f) => {
    if (matchedFrameIds.has(f.frameId)) return false;
    const normalizedFrame = normalizeUrlForMatch(f.url);
    if (normalizedFrame !== null && normalizedSrc !== null) {
      return normalizedFrame === normalizedSrc;
    }
    return f.url === iframeSrc;
  });
}

/** Render a child frame's accessibility tree and merge its refs into the parent maps. */
async function renderChildFrame(
  browser: BrowserAPI,
  frameId: string,
  indent: string,
  framePrefix: string,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  refToFrameId: Map<string, string>
): Promise<string[]> {
  try {
    const frameTree = await browser.getAccessibilityTreeForFrame(frameId);
    const frameRefToSelector = new Map<string, string>();
    const frameRefToBackendNodeId = new Map<string, number>();
    const frameLines = renderNode(
      frameTree,
      frameRefToSelector,
      frameRefToBackendNodeId,
      { value: 0 },
      indent,
      framePrefix
    );
    for (const [ref, selector] of frameRefToSelector) {
      refToSelector.set(ref, selector);
      refToFrameId.set(ref, frameId);
    }
    for (const [ref, nodeId] of frameRefToBackendNodeId) {
      refToBackendNodeId.set(ref, nodeId);
      refToFrameId.set(ref, frameId);
    }
    return frameLines;
  } catch {
    // Cross-origin frames or other failures — keep the placeholder
    return [];
  }
}

/** Stitch child-iframe accessibility content under each iframe placeholder line. */
async function stitchIframeContent(
  browser: BrowserAPI,
  content: string,
  baseUrl: string,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  refToFrameId: Map<string, string>
): Promise<string> {
  if (typeof browser.getFrameTree !== 'function') return content;
  try {
    const frames = await browser.getFrameTree();
    const childFrames = frames.filter((f) => f.parentFrameId);
    if (childFrames.length === 0) return content;

    let frameIndex = 0;
    const stitchedLines: string[] = [];
    const matchedFrameIds = new Set<string>();

    for (const line of content.split('\n')) {
      stitchedLines.push(line);

      // Match iframe placeholder lines like: - iframe "Title": "https://example.com/frame"
      const iframeMatch = line.match(/^(\s*)- iframe\s/);
      if (!iframeMatch) continue;
      const valueMatch = line.match(/:\s*"([^"]+)"\s*$/);
      if (!valueMatch) continue;

      const matchedFrame = findMatchingChildFrame(
        childFrames,
        valueMatch[1],
        baseUrl,
        matchedFrameIds
      );
      if (!matchedFrame) continue;
      matchedFrameIds.add(matchedFrame.frameId);

      frameIndex++;
      stitchedLines.push(
        ...(await renderChildFrame(
          browser,
          matchedFrame.frameId,
          iframeMatch[1] + '  ',
          `f${frameIndex}`,
          refToSelector,
          refToBackendNodeId,
          refToFrameId
        ))
      );
    }
    return stitchedLines.join('\n');
  } catch {
    // getFrameTree failed — keep the snapshot without iframe content
    return content;
  }
}

/**
 * Build the accessibility snapshot data for the current tab (must be attached).
 * Returns raw snapshot fields without touching `state` — callers decide whether
 * to persist to memory and/or write to a file.
 */
export async function buildSnapshot(
  browser: BrowserAPI,
  options?: { noIframes?: boolean }
): Promise<{
  url: string;
  title: string;
  text: string;
  refToSelector: Map<string, string>;
  refToBackendNodeId: Map<string, number>;
  refToFrameId: Map<string, string>;
}> {
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

  if (!options?.noIframes) {
    content = await stitchIframeContent(
      browser,
      content,
      url,
      refToSelector,
      refToBackendNodeId,
      refToFrameId
    );
  }

  return { url, title, text: content, refToSelector, refToBackendNodeId, refToFrameId };
}

export async function takeSnapshot(
  browser: BrowserAPI,
  state: PlaywrightState,
  targetId: string,
  options?: { noIframes?: boolean }
): Promise<{ snapshot: TabSnapshot; output: string }> {
  await browser.attachToPage(targetId);
  const { url, title, text, refToSelector, refToBackendNodeId, refToFrameId } = await buildSnapshot(
    browser,
    options
  );

  const snapshot: TabSnapshot = {
    url,
    title,
    refToSelector,
    refToBackendNodeId,
    refToFrameId,
    content: text,
    timestamp: Date.now(),
  };
  state.snapshots.set(targetId, snapshot);

  const output = [`Page URL: ${url}`, `Page Title: ${title}`, '', text].join('\n');
  return { snapshot, output };
}
