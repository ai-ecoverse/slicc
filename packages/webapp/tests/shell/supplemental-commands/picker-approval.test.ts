import { describe, expect, it } from 'vitest';
import { buildApprovalCardHtml } from '../../../src/shell/supplemental-commands/picker-approval.js';

describe('buildApprovalCardHtml', () => {
  it('renders the directory card with a data-picker="directory" approve button', () => {
    const html = buildApprovalCardHtml('directory');
    expect(html).toContain('Mount local directory');
    expect(html).toContain('data-action="approve"');
    expect(html).toContain('data-picker="directory"');
    expect(html).toContain('Select directory');
    expect(html).toContain('data-action="deny"');
  });

  it('renders the usb-device card with kind-specific labels and data-picker', () => {
    const html = buildApprovalCardHtml('usb-device');
    expect(html).toContain('Connect USB device');
    expect(html).toContain('data-picker="usb-device"');
    expect(html).toContain('Select USB device');
  });

  it('renders the serial-port card with kind-specific labels and data-picker', () => {
    const html = buildApprovalCardHtml('serial-port');
    expect(html).toContain('Connect serial port');
    expect(html).toContain('data-picker="serial-port"');
    expect(html).toContain('Select serial port');
  });

  it('renders the hid-device card with kind-specific labels and data-picker', () => {
    const html = buildApprovalCardHtml('hid-device');
    expect(html).toContain('Connect HID device');
    expect(html).toContain('data-picker="hid-device"');
    expect(html).toContain('Select HID device');
  });

  it('omits data-action-data when no filters are supplied', () => {
    const html = buildApprovalCardHtml('usb-device');
    expect(html).not.toContain('data-action-data');
  });

  it('encodes supplied filters into data-action-data as JSON', () => {
    const filters = [{ vendorId: 0x2e8a, productId: 0x0003 }];
    const html = buildApprovalCardHtml('usb-device', filters);
    expect(html).toContain('data-action-data=');
    // JSON.stringify produces double-quoted keys; assert the shape rather
    // than the exact attribute syntax.
    const match = html.match(/data-action-data='([^']+)'/);
    expect(match).not.toBeNull();
    expect(JSON.parse(match![1])).toEqual({ filters });
  });
});
