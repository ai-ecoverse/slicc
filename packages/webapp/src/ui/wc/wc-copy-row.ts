import { formatChatForClipboard } from '../chat-clipboard.js';
import type { ChatMessage } from '../types.js';

const COPY_SVG =
  '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" ' +
  'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
  '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/>' +
  '<path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>';

export interface CopyRowDeps {
  getMessages(): readonly ChatMessage[];

  writeText?(text: string): Promise<void>;
}

export function lastAssistantText(messages: readonly ChatMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role === 'assistant' && !m.isStreaming && !m.queued) return m.content;
  }
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') return messages[i].content;
  }
  return null;
}

export function createCopyRow(deps: CopyRowDeps): HTMLElement {
  const write = deps.writeText ?? ((text: string) => navigator.clipboard.writeText(text));
  const row = document.createElement('div');
  row.className = 'wc-copy-row';
  row.style.cssText = 'display:flex;justify-content:flex-start;margin:-8px 0 14px;';

  const btn = document.createElement('slicc-press-button');
  btn.setAttribute('tooltip', 'Copy last response · hold to copy chat');
  btn.setAttribute('label', 'Copy last response — hold to copy entire chat');
  btn.setAttribute('disable-double-click', '');
  btn.style.cssText = 'color:var(--txt-3);cursor:pointer;display:inline-flex;';

  const range = document.createRange();
  btn.append(range.createContextualFragment(COPY_SVG));

  const flashSuccess = (): void => {
    btn.style.color = 'var(--green)';
    setTimeout(() => {
      btn.style.color = 'var(--txt-3)';
    }, 1500);
  };

  btn.addEventListener('short-click', () => {
    void (async () => {
      const text = lastAssistantText(deps.getMessages());
      await write(text ?? formatChatForClipboard([...deps.getMessages()]));
      flashSuccess();
    })();
  });
  btn.addEventListener('long-press', () => {
    void (async () => {
      const formatted = formatChatForClipboard([...deps.getMessages()]);
      if (!formatted) return;
      await write(formatted);
      flashSuccess();
    })();
  });

  row.append(btn);
  return row;
}
