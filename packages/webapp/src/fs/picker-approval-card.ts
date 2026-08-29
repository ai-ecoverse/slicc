/**
 * Shared cone-side approval card markup for picker kinds (mount/usb/serial/hid).
 *
 * Lives in `fs/` (bottom of the layer stack) so mount helpers can render
 * approval cards without importing up into `shell/`. Shell device pickers
 * re-export from `shell/supplemental-commands/picker-approval.ts`.
 */

import { escapeHtml } from '@slicc/webcomponents/internal/html';
import type { PickerKind } from './picker-popup.js';

interface PickerKindText {
  title: string;
  approve: string;
}

const PICKER_KIND_TEXT: Record<PickerKind, PickerKindText> = {
  directory: { title: 'Mount local directory', approve: 'Select directory' },
  'usb-device': { title: 'Connect USB device', approve: 'Select USB device' },
  'serial-port': { title: 'Connect serial port', approve: 'Select serial port' },
  'hid-device': { title: 'Connect HID device', approve: 'Select HID device' },
};

/** Build the standard approval-card HTML for a picker kind + filters. */
export function buildApprovalCardHtml(
  kind: PickerKind,
  filters: unknown[] = [],
  targetPath?: string
): string {
  const text = PICKER_KIND_TEXT[kind];
  const dataAttr = filters.length
    ? ` data-action-data='${JSON.stringify({ filters }).replace(/'/g, '&apos;')}'`
    : '';
  const metaHtml =
    kind === 'directory' && targetPath
      ? `<div class="sprinkle-action-card__meta">Target: ${escapeHtml(targetPath)}</div>`
      : '';
  return `
    <div class="sprinkle-action-card">
      <div class="sprinkle-action-card__header">
        <div class="sprinkle-action-card__title-group">${text.title}${metaHtml}</div>
        <span class="sprinkle-badge sprinkle-badge--notice">approval</span>
      </div>
      <div class="sprinkle-action-card__actions">
        <button class="sprinkle-btn sprinkle-btn--secondary" data-action="deny">Deny</button>
        <button class="sprinkle-btn sprinkle-btn--primary" data-action="approve" data-picker="${kind}"${dataAttr}>${text.approve}</button>
      </div>
    </div>
  `;
}
