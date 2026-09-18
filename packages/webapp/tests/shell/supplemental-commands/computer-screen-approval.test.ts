import { describe, expect, it } from 'vitest';
import { buildScreenShareApprovalHtml } from '../../../src/shell/supplemental-commands/computer/screen-approval.js';

describe('screen-share approval card', () => {
  it('renders Share screen without a PickerKind data-picker value', () => {
    const html = buildScreenShareApprovalHtml();
    expect(html).toContain('Share this display');
    expect(html).toContain('data-picker="screenshare"');
    expect(html).not.toContain('data-picker="hid-device"');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-action="deny"');
  });
});
