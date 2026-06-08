import { describe, expect, it, vi } from 'vitest';
import {
  buildApprovalCardHtml,
  runDevicePickerApproval,
} from '../../../src/shell/supplemental-commands/picker-approval.js';
import { toolUIRegistry } from '../../../src/tools/tool-ui.js';

function makeCtx() {
  const updates: Array<{ type: string; requestId: string }> = [];
  const onUpdate = (partial: unknown) => {
    const p = partial as { content?: Array<{ type: string; requestId: string }> };
    if (p.content?.[0]) updates.push(p.content[0]);
  };
  return { onUpdate, updates } as { onUpdate: (x: unknown) => void; updates: typeof updates };
}

async function resolveOnNextTick(ctx: { updates: Array<{ requestId: string }> }): Promise<string> {
  for (let i = 0; i < 5; i++) {
    if (ctx.updates[0]?.requestId) return ctx.updates[0].requestId;
    await Promise.resolve();
  }
  throw new Error('no UI request emitted');
}

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

describe('runDevicePickerApproval', () => {
  it('resolves with the handle + info when the popup grants a device', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('usb-device', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, {
      action: 'approve',
      data: { granted: true, handle: 'usb1', info: { vendorId: 0x2e8a, productId: 0x0003 } },
    });
    await expect(promise).resolves.toEqual({
      handle: 'usb1',
      info: { vendorId: 0x2e8a, productId: 0x0003 },
    });
  });

  it('rejects with the kind-specific denial message when the user picks Deny', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('serial-port', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, { action: 'deny' });
    await expect(promise).rejects.toThrow(/serial-port: denied by user/);
  });

  it('rejects with the cancelled message when the picker reports cancellation', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('hid-device', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, { action: 'approve', data: { cancelled: true } });
    await expect(promise).rejects.toThrow(/hid-device: cancelled/);
  });

  it('forwards a picker error verbatim', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('usb-device', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, {
      action: 'approve',
      data: { error: 'WebUSB disabled' },
    });
    await expect(promise).rejects.toThrow(/usb-device: WebUSB disabled/);
  });

  it('treats an unexpected response shape as a clean error', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('usb-device', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, { action: 'approve', data: {} });
    await expect(promise).rejects.toThrow(/no device selected|unexpected response/);
  });

  it('allows the popup-swap path to grant a device by info only (no handle)', async () => {
    const ctx = makeCtx();
    const promise = runDevicePickerApproval('usb-device', [], ctx as unknown as never);
    const id = await resolveOnNextTick(ctx);
    await toolUIRegistry.handleAction(id, {
      action: 'approve',
      data: { granted: true, info: { vendorId: 0x2e8a, productId: 0x0003 } },
    });
    const result = await promise;
    expect(result.handle).toBe('');
    expect(result.info).toMatchObject({ vendorId: 0x2e8a });
  });

  it('times out into a kind-tagged error after the approval window expires', async () => {
    vi.useFakeTimers();
    try {
      const ctx = makeCtx();
      const promise = runDevicePickerApproval('hid-device', [], ctx as unknown as never);
      // Attach the rejection handler synchronously so the cancel-driven
      // rawUiPromise rejection is observed before the timeout fires.
      const captured = promise.catch((err) => err);
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(130_000);
      const err = await captured;
      expect((err as Error).message).toMatch(/hid-device: timed out/);
    } finally {
      vi.useRealTimers();
    }
  });
});
