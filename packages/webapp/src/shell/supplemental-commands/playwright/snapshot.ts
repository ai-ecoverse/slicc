import { normalizeAccessibilityText } from '../../../base/normalize-accessibility-text.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import { listAllTargetsWithRemote } from './state.js';
import type { PlaywrightHandlerCtx, PlaywrightState, TabHandle, TabSnapshot } from './types.js';

type BrowserAPI = PlaywrightHandlerCtx['browser'];
type PageInfo = Awaited<ReturnType<BrowserAPI['listPages']>>[number];
type AccessibilityNode = Awaited<ReturnType<TabHandle['getAccessibilityTree']>>;

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

async function resolveAppOrigin(): Promise<string> {
  if (typeof window !== 'undefined') return window.location.origin;
  const rpc = getPanelRpcClient();
  if (rpc) {
    try {
      const info = await rpc.call('page-info', undefined, { timeoutMs: 2000 });
      if (info.origin) return info.origin;
    } catch {}
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

  const pages = await listAllTargetsWithRemote(browser);
  return pages.filter((page) => isActionablePage(state, page));
}

interface FrameInfo {
  frameId: string;
  parentFrameId?: string;
  url: string;
}

function normalizeUrlForMatch(rawUrl: string, base?: string): string | null {
  try {
    const u = new URL(rawUrl, base);
    return u.origin + u.pathname.replace(/\/$/, '') + u.search;
  } catch {
    return null;
  }
}

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

async function renderChildFrame(
  page: TabHandle,
  frameId: string,
  indent: string,
  framePrefix: string,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  refToFrameId: Map<string, string>
): Promise<string[]> {
  try {
    const frameTree = await page.getAccessibilityTreeForFrame(frameId);
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
    return [];
  }
}

async function stitchIframeContent(
  page: TabHandle,
  content: string,
  baseUrl: string,
  refToSelector: Map<string, string>,
  refToBackendNodeId: Map<string, number>,
  refToFrameId: Map<string, string>
): Promise<string> {
  if (typeof page.getFrameTree !== 'function') return content;
  try {
    const frames = await page.getFrameTree();
    const childFrames = frames.filter((f) => f.parentFrameId);
    if (childFrames.length === 0) return content;

    let frameIndex = 0;
    const stitchedLines: string[] = [];
    const matchedFrameIds = new Set<string>();

    for (const line of content.split('\n')) {
      stitchedLines.push(line);

      const iframeMatch = line.match(/^(\s*)- iframe(?=\s|:)/);
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
          page,
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
    return content;
  }
}

export async function buildSnapshot(
  page: TabHandle,
  options?: { noIframes?: boolean }
): Promise<{
  url: string;
  title: string;
  text: string;
  refToSelector: Map<string, string>;
  refToBackendNodeId: Map<string, number>;
  refToFrameId: Map<string, string>;
}> {
  const pageInfo = await page.evaluate(
    `JSON.stringify({ url: location.href, title: document.title })`
  );
  const { url, title } = JSON.parse(pageInfo as string);
  const tree = await page.getAccessibilityTree();
  const refToSelector = new Map<string, string>();
  const refToBackendNodeId = new Map<string, number>();
  const refToFrameId = new Map<string, string>();
  const counter = { value: 0 };
  const snapshotLines = renderNode(tree, refToSelector, refToBackendNodeId, counter);
  let content = snapshotLines.join('\n');

  if (!options?.noIframes) {
    content = await stitchIframeContent(
      page,
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
  page: TabHandle,
  state: PlaywrightState,
  targetId: string,
  options?: { noIframes?: boolean }
): Promise<{ snapshot: TabSnapshot; output: string }> {
  const { url, title, text, refToSelector, refToBackendNodeId, refToFrameId } = await buildSnapshot(
    page,
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
