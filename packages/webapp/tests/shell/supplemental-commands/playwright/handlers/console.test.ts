import { describe, expect, it } from 'vitest';
import { consoleHandler } from '../../../../../src/shell/supplemental-commands/playwright/handlers/console.js';
import {
  createHandlerCtx,
  createMockBrowser,
  createMockTransport,
  createPlaywrightState,
} from '../../../helpers/playwright-harness.js';

const TAB = 'tab-1';

describe('console handler', () => {
  it('requires a --tab flag', async () => {
    const result = await consoleHandler(createHandlerCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('--tab');
  });

  it('rejects an invalid min-level', async () => {
    const result = await consoleHandler(
      createHandlerCtx({ positional: ['verbose'], flags: { tab: TAB } })
    );
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('Invalid level');
  });

  it('subscribes on first use and captures console messages through the CDP pipeline', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    // First call subscribes and reports nothing yet.
    const empty = await consoleHandler(ctx);
    expect(empty.stdout).toBe('No console messages\n');
    expect(transport.send).toHaveBeenCalledWith('Runtime.enable', {}, 'session-1');
    expect(transport.hasListener('Runtime.consoleAPICalled')).toBe(true);

    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'log',
      args: [{ value: 'hello' }, { value: 'world' }],
    });

    const result = await consoleHandler(ctx);
    expect(result.stdout).toBe('[log] hello world\n');
    expect(result.exitCode).toBe(0);
  });

  it('ignores events from other sessions', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    await consoleHandler(ctx);
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'other-session',
      type: 'log',
      args: [{ value: 'leak' }],
    });

    const result = await consoleHandler(ctx);
    expect(result.stdout).toBe('No console messages\n');
  });

  it('normalizes non-LEVELS CDP types to their nearest severity', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    await consoleHandler(ctx);
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'assert',
      args: [{ value: 'boom' }],
    });
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'trace',
      args: [{ value: 'trail' }],
    });

    const result = await consoleHandler(ctx);
    // assert → error, trace → debug (debug is below the default `log` floor).
    expect(result.stdout).toContain('[error] boom');
    expect(result.stdout).not.toContain('trail');
  });

  it('falls back to arg description then empty string, and defaults missing type to log', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    await consoleHandler(ctx);
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      args: [{ description: 'Error: nope' }, {}],
    });

    const result = await consoleHandler(ctx);
    expect(result.stdout).toBe('[log] Error: nope \n');
  });

  it('filters by an explicit min-level', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();
    const ctx = createHandlerCtx({ browser, state, flags: { tab: TAB } });

    await consoleHandler(ctx);
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'log',
      args: [{ value: 'info msg' }],
    });
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'error',
      args: [{ value: 'err msg' }],
    });

    const result = await consoleHandler(
      createHandlerCtx({ browser, state, positional: ['error'], flags: { tab: TAB } })
    );
    expect(result.stdout).toBe('[error] err msg\n');
  });

  it('--clear empties the buffer regardless of the min-level filter', async () => {
    const transport = createMockTransport();
    const { browser } = createMockBrowser({ transport, sessionId: 'session-1' });
    const state = createPlaywrightState();

    await consoleHandler(createHandlerCtx({ browser, state, flags: { tab: TAB } }));
    await transport.emit('Runtime.consoleAPICalled', {
      sessionId: 'session-1',
      type: 'error',
      args: [{ value: 'err msg' }],
    });

    // Read at the `log` floor with --clear: the error line prints, then all
    // messages are dropped.
    const cleared = await consoleHandler(
      createHandlerCtx({ browser, state, flags: { tab: TAB, clear: 'true' } })
    );
    expect(cleared.stdout).toBe('[error] err msg\n');

    const after = await consoleHandler(createHandlerCtx({ browser, state, flags: { tab: TAB } }));
    expect(after.stdout).toBe('No console messages\n');
  });
});
