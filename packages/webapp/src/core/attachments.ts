import type { ImageContent } from '@mariozechner/pi-ai';

export type MessageAttachmentKind = 'image' | 'text' | 'file';

export interface MessageAttachment {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  kind: MessageAttachmentKind;
  /** Base64 payload for LLM-supported image attachments. */
  data?: string;
  /** UTF-8 content for text-like file attachments. */
  text?: string;
  /**
   * VFS path (e.g. `/tmp/attachment-…`) when the file was persisted to the
   * virtual filesystem because it was too large to inline. The agent can
   * `read_file`/`bash cat` this path to access the full content.
   */
  path?: string;
  /** Human-readable reason when the payload could not be included. */
  error?: string;
}

export function formatAttachmentSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  const rounded = value >= 10 || unitIndex === 0 ? Math.round(value) : Math.round(value * 10) / 10;
  return `${rounded} ${units[unitIndex]}`;
}

export function formatAttachmentSummary(attachment: MessageAttachment): string {
  const mime = attachment.mimeType || 'application/octet-stream';
  return `${attachment.name} (${mime}, ${formatAttachmentSize(attachment.size)})`;
}

export function formatAttachmentForPrompt(attachment: MessageAttachment): string {
  const summary = formatAttachmentSummary(attachment);
  if (attachment.kind === 'image' && attachment.data) {
    return `[Attached image: ${summary}]`;
  }

  if (attachment.kind === 'text' && attachment.text !== undefined) {
    return [
      `----- BEGIN ATTACHMENT ${summary} -----`,
      attachment.text,
      `----- END ATTACHMENT ${attachment.name} -----`,
    ].join('\n');
  }

  if (attachment.path) {
    const kindLabel =
      attachment.kind === 'image' ? 'image' : attachment.kind === 'text' ? 'text file' : 'file';
    return `[Attached ${kindLabel} saved to ${attachment.path} — ${summary}. Read it from the virtual filesystem when you need its contents.]`;
  }

  if (attachment.error) {
    return `[Attachment not included: ${summary}. ${attachment.error}]`;
  }

  return `[Attachment not included: ${summary}. Unsupported binary attachment.]`;
}

export function formatPromptWithAttachments(
  text: string,
  attachments: readonly MessageAttachment[] | undefined
): string {
  if (!attachments?.length) return text;
  const blocks = attachments.map(formatAttachmentForPrompt);
  const trimmed = text.trim();
  return trimmed ? `${trimmed}\n\n${blocks.join('\n\n')}` : blocks.join('\n\n');
}

export function imageContentFromAttachments(
  attachments: readonly MessageAttachment[] | undefined
): ImageContent[] {
  if (!attachments?.length) return [];
  return attachments
    .filter((attachment) => attachment.kind === 'image' && attachment.data)
    .map((attachment) => ({
      type: 'image' as const,
      data: attachment.data!,
      mimeType: attachment.mimeType,
    }));
}
