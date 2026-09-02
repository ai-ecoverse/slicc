/**
 * Markdown serialization of a chat history — the "copy chat history"
 * format. The implementation lives at the transcript layer
 * (`transcript/chat-markdown.ts`) so the frozen-archive writer can render
 * the same body from the kernel worker; this module keeps the UI-side
 * import site.
 */

export { formatChatForClipboard } from '../transcript/chat-markdown.js';
