import { SliccQuickLook } from '@slicc/webcomponents';
import { findBase64Mentions } from '../../core/base64-mentions.js';
import {
  BASE64_PREVIEW_OPEN_EVENT,
  type Base64PreviewOpenDetail,
  elideBase64Payloads,
} from '../base64-preview-linker.js';
import { buildRenderedView } from './file-actions.js';

export interface Base64PreviewWiringDeps {
  thread: HTMLElement;
  log: { error(message: string, ...data: unknown[]): void };
}

const AGENT_TAG = 'slicc-agent-message';
const USER_TAG = 'slicc-user-message';
const MESSAGE_SELECTOR = `${AGENT_TAG},${USER_TAG}`;

const WATCHED_ATTRIBUTES = ['streaming', 'text', 'timestamp', 'queued'];

function bodyOf(message: HTMLElement): HTMLElement | null {
  if (message.tagName.toLowerCase() === USER_TAG) {
    return message.shadowRoot?.querySelector<HTMLElement>('.b') ?? null;
  }
  return message.querySelector<HTMLElement>('.body') ?? message;
}

export function wireBase64Previews(deps: Base64PreviewWiringDeps): () => void {
  try {
    return wireBase64PreviewsUnsafe(deps);
  } catch (err) {
    deps.log.error('Base64 preview wiring failed; continuing without it', err);
    return () => {};
  }
}

function wireBase64PreviewsUnsafe(deps: Base64PreviewWiringDeps): () => void {
  const { thread, log } = deps;

  if (!(thread instanceof Node)) return () => {};

  const process = (message: Element): void => {
    if (!(message instanceof HTMLElement)) return;

    if (message.hasAttribute('streaming')) return;
    const body = bodyOf(message);
    if (!body) return;

    if (findBase64Mentions(body.textContent ?? '').length === 0) return;
    try {
      elideBase64Payloads(body);
    } catch (err) {
      log.error('Base64 elision failed', err);
    }
  };

  const scan = (root: ParentNode): void => {
    for (const message of root.querySelectorAll(MESSAGE_SELECTOR)) process(message);
  };

  scan(thread);

  const observer = new MutationObserver((records) => {
    for (const record of records) {
      const target = record.target as HTMLElement | null;
      if (record.type === 'attributes') {
        if (target) process(target);
        continue;
      }
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        if (node.matches(MESSAGE_SELECTOR)) process(node);
        else scan(node);
      }

      const owner = target?.closest?.(MESSAGE_SELECTOR);
      if (owner) process(owner);
    }
  });

  observer.observe(thread, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: WATCHED_ATTRIBUTES,
  });

  const onOpen = (event: Event): void => {
    const { payload } = (event as CustomEvent<Base64PreviewOpenDetail>).detail;
    try {
      openPayloadPreview(payload);
    } catch (err) {
      log.error('Base64 preview failed', err);
    }
  };
  thread.addEventListener(BASE64_PREVIEW_OPEN_EVENT, onOpen);

  return () => {
    observer.disconnect();
    thread.removeEventListener(BASE64_PREVIEW_OPEN_EVENT, onOpen);
  };
}

function openPayloadPreview(payload: Base64PreviewOpenDetail['payload']): void {
  if (!payload.text) {
    SliccQuickLook.open({
      path: payload.name,
      content: payload.bytes.buffer,
      mimeType: payload.mime,
      text: false,
    });
    return;
  }

  const contents = new TextDecoder().decode(payload.bytes);
  const rendered = buildRenderedView(payload.name, payload.mime, contents);
  SliccQuickLook.open({
    path: payload.name,
    content: contents,
    mimeType: payload.mime,
    text: true,
    ...(rendered ? { rendered } : {}),
  });
}
