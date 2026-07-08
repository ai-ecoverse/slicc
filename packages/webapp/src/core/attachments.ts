import type { ImageContent } from '@earendil-works/pi-ai';
import type { MessageAttachment } from '@slicc/shared-ts';

// Wire types moved to @slicc/shared-ts (tray sync protocol payloads);
// re-exported here so core/-layer importers keep their local import site.
export type { MessageAttachment, MessageAttachmentKind } from '@slicc/shared-ts';

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
    // Captures carry BOTH: a downscaled inline copy for vision and the
    // full-resolution original persisted to the VFS.
    return attachment.path
      ? `[Attached image: ${summary} — full-resolution copy saved to ${attachment.path}]`
      : `[Attached image: ${summary}]`;
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

/**
 * Strip `path` from attachments before they cross a runtime boundary
 * (typically tray follower → leader). The path was generated against
 * the sender's VFS and is meaningless on the receiver — keeping it
 * would mislead the agent into trying to read a non-existent file.
 *
 * Attachments that still carry inline `data`/`text` keep their content
 * and lose only the path. Path-only attachments are demoted to a
 * `not-included` placeholder with an explanatory error so the prompt
 * accurately reflects what the agent can and cannot reach.
 */
export function stripLocalPathsForRemote(
  attachments: readonly MessageAttachment[] | undefined,
  reason = 'The original file lives on a remote runtime and is not accessible here.'
): MessageAttachment[] {
  if (!attachments?.length) return [];
  return attachments.map((attachment) => {
    if (!attachment.path) return { ...attachment };
    const { path: _omitted, ...rest } = attachment;
    const hasInline =
      (attachment.kind === 'image' && !!attachment.data) ||
      (attachment.kind === 'text' && attachment.text !== undefined);
    if (hasInline) return rest;
    return { ...rest, error: rest.error ?? reason };
  });
}
