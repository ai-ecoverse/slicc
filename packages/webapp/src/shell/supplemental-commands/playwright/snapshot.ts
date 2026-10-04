import { normalizeAccessibilityText } from '../../../base/normalize-accessibility-text.js';
import { getPanelRpcClient } from '../../../kernel/panel-rpc.js';
import { listAllTargetsWithRemote, parseRef } from './state.js';
import type {
  PlaywrightHandlerCtx,
  PlaywrightState,
  SnapshotRef,
  TabHandle,
  TabRefState,
  TabSnapshot,
} from './types.js';

type BrowserAPI = PlaywrightHandlerCtx['browser'];
type PageInfo = Awaited<ReturnType<BrowserAPI['listPages']>>[number];
type AccessibilityNode = Awaited<ReturnType<TabHandle['getAccessibilityTree']>>;
type ResolvedAriaRef = Awaited<ReturnType<TabHandle['resolveAriaRef']>>;

export function escapeYaml(str: string): string {
  return str.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

export function formatAriaStates(description: string | undefined): string {
  if (!description) return '';
  const parts: string[] = [];
  for (const raw of description
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    if (raw === 'collapsed') {
      parts.push('[expanded=false]');
      continue;
    }
    parts.push(`[${raw}]`);
  }
  return parts.length > 0 ? ` ${parts.join(' ')}` : '';
}

export function renderNode(
  node: AccessibilityNode,
  refs: Map<string, SnapshotRef>,
  indent: string = '',
  framePrefix: string = '',
  frameId?: string
): string[] {
  const lines: string[] = [];
  const role = normalizeAccessibilityText(node.role, 'unknown').toLowerCase();
  const name = normalizeAccessibilityText(node.name);
  const value = normalizeAccessibilityText(node.value);

  let ref = '';
  if (node.ref && role !== 'text') {
    ref = framePrefix + node.ref;
    refs.set(ref, { role, name, localRef: node.ref, ...(frameId ? { frameId } : {}) });
  }

  let line = `${indent}- ${role}`;
  if (name) line += ` "${escapeYaml(name)}"`;
  if (ref) line += ` [ref=${ref}]`;

  line += formatAriaStates(node.description);
  if (value) line += `: "${escapeYaml(value)}"`;
  lines.push(line);

  if (node.children) {
    for (const child of node.children) {
      lines.push(...renderNode(child, refs, indent + '  ', framePrefix, frameId));
    }
  }
  return lines;
}

export function tabRefState(state: PlaywrightState, targetId: string): TabRefState {
  let refState = state.tabRefs.get(targetId);
  if (!refState) {
    refState = { floor: 0, framePrefixes: new Map() };
    state.tabRefs.set(targetId, refState);
  }
  return refState;
}

export function framePrefixFor(refState: TabRefState, frameId: string): string {
  let prefix = refState.framePrefixes.get(frameId);
  if (!prefix) {
    prefix = `f${refState.framePrefixes.size + 1}`;
    refState.framePrefixes.set(frameId, prefix);
  }
  return prefix;
}

export function recordRefSeq(refState: TabRefState, tree: AccessibilityNode): void {
  if (typeof tree.refSeq === 'number' && tree.refSeq > refState.floor) {
    refState.floor = tree.refSeq;
  }
}

export function requireTabSnapshot(state: PlaywrightState, targetId: string): TabSnapshot {
  const snapshot = state.snapshots.get(targetId);
  if (!snapshot) throw new Error('No snapshot available. Run "snapshot" first.');
  return snapshot;
}

export function requireSnapshotRef(snapshot: TabSnapshot, ref: string): SnapshotRef {
  const entry = snapshot.refs.get(ref);
  if (entry) return entry;
  throw new Error(
    `Unknown ref "${ref}": not in this tab's latest snapshot (the element was removed or ` +
      'renamed, or the page navigated). Run "snapshot" for current refs.'
  );
}

export async function resolveSnapshotRef(
  page: TabHandle,
  snapshot: TabSnapshot,
  ref: string
): Promise<ResolvedAriaRef & { entry: SnapshotRef }> {
  const entry = requireSnapshotRef(snapshot, ref);
  try {
    const resolved = await page.resolveAriaRef(entry.localRef, entry.frameId);
    return { ...resolved, entry };
  } catch (err) {
    if (err instanceof Error && err.name === 'StaleAriaRefError') {
      const label = entry.name ? `${entry.role} "${entry.name}"` : entry.role;
      throw new Error(
        `Ref "${ref}" (${label}) is no longer on the page. Run "snapshot" for current refs.`
      );
    }
    throw err;
  }
}

export function requireTopFrameRef(entry: SnapshotRef, ref: string, command: string): void {
  if (entry.frameId || parseRef(ref).isIframe) {
    throw new Error(`${command} does not support iframe refs ("${ref}")`);
  }
}

export async function callOnElement(
  page: TabHandle,
  objectId: string,
  functionDeclaration: string,
  args: unknown[] = []
): Promise<unknown> {
  const result = await page.send('Runtime.callFunctionOn', {
    objectId,
    functionDeclaration,
    arguments: args.map((value) => ({ value })),
    returnByValue: true,
  });
  const details = result['exceptionDetails'] as
    | { text?: string; exception?: { description?: string } }
    | undefined;
  if (details) {
    throw new Error(details.exception?.description ?? details.text ?? 'Element call failed');
  }
  return (result['result'] as { value?: unknown } | undefined)?.value;
}

export async function resolveAppTabId(browser: BrowserAPI, state: PlaywrightState): Promise<void> {
  if (state.appTabId) return;
  await findAppTab(state, await browser.listPages());
}

async function findAppTab(state: PlaywrightState, pages: PageInfo[]): Promise<void> {
  const appOrigin = await resolveAppOrigin();
  const appTab = pages.find((p) => p.url.startsWith(appOrigin) && !p.url.includes('/preview/'));
  state.appTabId = appTab ? appTab.targetId : null;
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
  return (await listPagesForTabs(browser, state)).actionable;
}

export async function listNumberedTabs(
  browser: BrowserAPI,
  state: PlaywrightState
): Promise<Array<PageInfo & { number: number }>> {
  const { all, actionable } = await listPagesForTabs(browser, state);
  return numberTabs(state, actionable, all);
}

async function listPagesForTabs(
  browser: BrowserAPI,
  state: PlaywrightState
): Promise<{ all: PageInfo[]; actionable: PageInfo[] }> {
  const pages = await listAllTargetsWithRemote(browser);

  if (!state.appTabId || !pages.some((p) => p.targetId === state.appTabId)) {
    await findAppTab(state, pages);
  }
  return { all: pages, actionable: pages.filter((page) => isActionablePage(state, page)) };
}

export function tabNumberFor(state: PlaywrightState, targetId: string): number {
  let number = state.tabNumbers.get(targetId);
  if (number === undefined) {
    number = ++state.lastTabNumber;
    state.tabNumbers.set(targetId, number);
  }
  return number;
}

export function numberTabs(
  state: PlaywrightState,
  pages: PageInfo[],
  present: PageInfo[] = pages
): Array<PageInfo & { number: number }> {
  const listed = new Set(present.map((page) => page.targetId));
  for (const targetId of [...state.tabNumbers.keys()]) {
    if (!listed.has(targetId) && !targetId.includes(':')) state.tabNumbers.delete(targetId);
  }
  return pages
    .map((page) => ({ ...page, number: tabNumberFor(state, page.targetId) }))
    .sort((a, b) => a.number - b.number);
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
  refs: Map<string, SnapshotRef>,
  refState: TabRefState
): Promise<string[]> {
  try {
    const frameTree = await page.getAccessibilityTreeForFrame(frameId, {
      refFloor: refState.floor,
    });
    recordRefSeq(refState, frameTree);
    return renderNode(frameTree, refs, indent, framePrefixFor(refState, frameId), frameId);
  } catch {
    return [];
  }
}

async function stitchIframeContent(
  page: TabHandle,
  content: string,
  baseUrl: string,
  refs: Map<string, SnapshotRef>,
  refState: TabRefState
): Promise<string> {
  if (typeof page.getFrameTree !== 'function') return content;
  try {
    const frames = await page.getFrameTree();
    const childFrames = frames.filter((f) => f.parentFrameId);
    if (childFrames.length === 0) return content;

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

      stitchedLines.push(
        ...(await renderChildFrame(
          page,
          matchedFrame.frameId,
          iframeMatch[1] + '  ',
          refs,
          refState
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
  refState: TabRefState,
  options?: { noIframes?: boolean }
): Promise<{
  url: string;
  title: string;
  text: string;
  refs: Map<string, SnapshotRef>;
}> {
  const pageInfo = await page.evaluate(
    `JSON.stringify({ url: location.href, title: document.title })`
  );
  const { url, title } = JSON.parse(pageInfo as string);
  const tree = await page.getAccessibilityTree({ refFloor: refState.floor });
  recordRefSeq(refState, tree);
  const refs = new Map<string, SnapshotRef>();
  let content = renderNode(tree, refs).join('\n');

  if (!options?.noIframes) {
    content = await stitchIframeContent(page, content, url, refs, refState);
  }

  return { url, title, text: content, refs };
}

export async function takeSnapshot(
  page: TabHandle,
  state: PlaywrightState,
  targetId: string,
  options?: { noIframes?: boolean }
): Promise<{ snapshot: TabSnapshot; output: string }> {
  const { url, title, text, refs } = await buildSnapshot(
    page,
    tabRefState(state, targetId),
    options
  );

  const snapshot: TabSnapshot = { url, title, refs, content: text, timestamp: Date.now() };
  state.snapshots.set(targetId, snapshot);

  const output = [`Page URL: ${url}`, `Page Title: ${title}`, '', text].join('\n');
  return { snapshot, output };
}
