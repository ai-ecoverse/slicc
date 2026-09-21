import { describe, expect, it } from 'vitest';
import { createStandalonePanelRpcHandlers } from '../../src/ui/panel-rpc-handlers.js';

/**
 * Composition-root smoke: every `build*Handlers()` factory still lands on
 * the record `installPanelRpcHandler` consumes. Per-op behavior lives in
 * `tests/ui/panel-rpc/`.
 */
describe('createStandalonePanelRpcHandlers', () => {
  it('spreads one op from each panel-rpc factory', () => {
    const handlers = createStandalonePanelRpcHandlers({});
    expect(handlers['page-info']).toBeTypeOf('function');
    expect(handlers['clipboard-read-text']).toBeTypeOf('function');
    expect(handlers['hear-status']).toBeTypeOf('function');
    expect(handlers['tray-reset']).toBeTypeOf('function');
    expect(handlers['slicc-list']).toBeTypeOf('function');
    expect(handlers['usb-list']).toBeTypeOf('function');
    expect(handlers['hid-list']).toBeTypeOf('function');
    expect(handlers['serial-list']).toBeTypeOf('function');
    expect(handlers['esptool-chip-info']).toBeTypeOf('function');
    expect(handlers['list-remote-targets']).toBeTypeOf('function');
    expect(handlers['permission-request']).toBeTypeOf('function');
    expect(handlers['proxied-fetch']).toBeTypeOf('function');
    expect(handlers['sudo-request']).toBeTypeOf('function');
    expect(handlers['secret-request']).toBeTypeOf('function');
    expect(handlers['secrets-bridge']).toBeTypeOf('function');
    expect(handlers['mount-sign-and-forward']).toBeTypeOf('function');
    expect(handlers['theme-apply']).toBeTypeOf('function');
    expect(handlers['layout-apply']).toBeTypeOf('function');
    expect(handlers['computer-tab-screenshot']).toBeTypeOf('function');
  });
});
