import { FileMentionResolver } from '../../core/file-mention-resolver.js';
import { findFileMentions } from '../../core/file-mentions.js';
import { parsePathHints, TOOL_PATH_HINTS_ATTR } from '../../core/tool-call-paths.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import {
  FILE_MENTION_OPEN_EVENT,
  type FileMentionOpenDetail,
  linkifyFileMentions,
} from '../file-mention-linker.js';
import { openFilePreview } from './file-actions.js';

export interface FileMentionWiringDeps {
  thread: HTMLElement;

  openFs(): Promise<LocalVfsClient>;
  log: { error(message: string, ...data: unknown[]): void };
}

const MESSAGE_TAG = 'slicc-agent-message';

const TOOL_ROW_SELECTOR = `slicc-action-row[${TOOL_PATH_HINTS_ATTR}]`;

const HINT_ROW_LOOKBACK = 40;

function collectPathHints(thread: ParentNode, bubble: HTMLElement): string[] {
  const rows: string[] = [];
  const all = thread.querySelectorAll<HTMLElement>(TOOL_ROW_SELECTOR);
  for (const row of all) {
    if (bubble.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING) break;
    rows.push(row.getAttribute(TOOL_PATH_HINTS_ATTR) ?? '');
  }
  return rows.slice(-HINT_ROW_LOOKBACK).flatMap((value) => parsePathHints(value));
}

function whenIdle(task: () => void): void {
  const idle = (globalThis as { requestIdleCallback?: (cb: () => void) => number })
    .requestIdleCallback;
  if (typeof idle === 'function') idle(task);
  else setTimeout(task, 0);
}

export function wireFileMentions(deps: FileMentionWiringDeps): () => void {
  try {
    return wireFileMentionsUnsafe(deps);
  } catch (err) {
    deps.log.error('File mention wiring failed; continuing without it', err);
    return () => {};
  }
}

function wireFileMentionsUnsafe(deps: FileMentionWiringDeps): () => void {
  const { thread, openFs, log } = deps;

  if (!(thread instanceof Node)) return () => {};

  let resolverPromise: Promise<FileMentionResolver> | null = null;
  const getResolver = (): Promise<FileMentionResolver> => {
    resolverPromise ??= openFs().then((fs) => new FileMentionResolver(fs));
    return resolverPromise;
  };

  const process = (bubble: Element): void => {
    if (!(bubble instanceof HTMLElement)) return;

    if (bubble.hasAttribute('streaming')) return;
    const body = bubble.querySelector<HTMLElement>('.body') ?? bubble;

    if (findFileMentions(body.textContent ?? '').length === 0) return;

    whenIdle(() => {
      const hints = collectPathHints(thread, bubble);
      void getResolver()
        .then((resolver) => linkifyFileMentions(body, resolver, hints))
        .catch((err) => log.error('File mention linking failed', err));
    });
  };

  const scan = (root: ParentNode): void => {
    for (const bubble of root.querySelectorAll(MESSAGE_TAG)) process(bubble);
  };

  scan(thread);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      if (record.type === 'attributes') {
        if (record.target instanceof HTMLElement) process(record.target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.tagName.toLowerCase() === MESSAGE_TAG) process(node);
        else scan(node);
      }

      const owner = (record.target as HTMLElement | null)?.closest?.(MESSAGE_TAG);
      if (owner) process(owner);
    }
  });

  observer.observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['streaming'],
  });

  const onOpen = (event: Event): void => {
    const { path, line } = (event as CustomEvent<FileMentionOpenDetail>).detail;
    void openFs()
      .then((fs) => openFilePreview(fs, path, line !== undefined ? { line } : {}))
      .catch((err) => log.error('File mention preview failed', err));
  };
  thread.addEventListener(FILE_MENTION_OPEN_EVENT, onOpen);

  return () => {
    observer.disconnect();
    thread.removeEventListener(FILE_MENTION_OPEN_EVENT, onOpen);
  };
}
