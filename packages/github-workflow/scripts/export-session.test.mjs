import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setup } from '../tests/helpers.mjs';
import { main } from './export-session.mjs';

describe('export-session', () => {
  let t;
  beforeEach(() => {
    t = setup();
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });
  afterEach(() => {
    t.teardown();
    vi.restoreAllMocks();
  });

  it('exports the active session and copies the bundle back', () => {
    const local = join(t.root, 'out', 'session.zip');
    t.inputs({ local });
    const bytes = main();
    expect(readFileSync(local, 'utf8')).toBe('PK-fake-zip:active');
    expect(bytes).toBe('PK-fake-zip:active'.length);
    expect(t.outputs()).toEqual({ bytes: String(bytes), local });
    expect(console.log).toHaveBeenCalledWith('exported /tmp/slicc-session-export.zip');
    const [exportCall, readCall] = t.calls();
    expect(exportCall.verb).toBe('exec');
    expect(exportCall.rest[0]).toBe(`session export --output '/tmp/slicc-session-export.zip'`);
    expect(readCall.rest[0]).toBe(`base64 '/tmp/slicc-session-export.zip'`);
  });

  it('exports a frozen session by id to a custom vfs path', () => {
    const local = join(t.root, 'frozen.zip');
    t.inputs({ local, 'session-id': 'sess-42', 'vfs-path': '/workspace/x.zip' });
    main();
    expect(readFileSync(local, 'utf8')).toBe('PK-fake-zip:sess-42');
  });

  it('requires local', () => {
    t.inputs({ local: '' });
    expect(() => main()).toThrow(/"local" is required/);
  });
});
