import { describe, expect, it } from 'vitest';
import { createNodeOs, DEFAULT_HOME, nodeOs } from '../../../src/kernel/realm/helpers/node-os.js';

describe('createNodeOs', () => {
  it('answers from the realm env for the two unit-dependent values', () => {
    const os = createNodeOs({ TMPDIR: '/tmp/cone-adobe', HOME: '/scoops/review/home' });
    expect(os.tmpdir()).toBe('/tmp/cone-adobe');
    expect(os.homedir()).toBe('/scoops/review/home');
  });

  it('keeps the pre-#2267 constants when the realm has no env', () => {
    // A realm booted without an env is a host with no unit behind it, and the
    // float-wide answers were correct for that case.
    for (const os of [createNodeOs(), createNodeOs({}), nodeOs]) {
      expect(os.tmpdir()).toBe('/tmp');
      expect(os.homedir()).toBe(DEFAULT_HOME);
    }
  });

  it('treats an empty or whitespace value as unset, never as a relative path', () => {
    // `path.join(os.tmpdir(), 'x')` on `''` yields a cwd-relative path, which
    // is how a library ends up writing into the user's workspace.
    const os = createNodeOs({ TMPDIR: '  ', HOME: '' });
    expect(os.tmpdir()).toBe('/tmp');
    expect(os.homedir()).toBe(DEFAULT_HOME);
  });

  it('reports the same machine identity as the process shim', () => {
    // `createProcessShim` hardcodes linux/x64 and says it mirrors this module.
    const os = createNodeOs({ TMPDIR: '/tmp/cone' });
    expect([os.platform(), os.arch(), os.type(), os.hostname()]).toEqual([
      'linux',
      'x64',
      'Linux',
      'slicc',
    ]);
    expect(os.cpus().length).toBeGreaterThan(0);
  });
});
