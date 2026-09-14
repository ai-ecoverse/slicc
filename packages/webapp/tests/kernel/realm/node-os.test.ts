import { describe, expect, it } from 'vitest';
import { createNodeOs, DEFAULT_HOME, nodeOs } from '../../../src/kernel/realm/helpers/node-os.js';

describe('createNodeOs', () => {
  it('answers from the realm env for the two unit-dependent values', () => {
    const os = createNodeOs({ TMPDIR: '/tmp/cone-adobe', HOME: '/scoops/review/home' });
    expect(os.tmpdir()).toBe('/tmp/cone-adobe');
    expect(os.homedir()).toBe('/scoops/review/home');
  });

  it('keeps the pre-#2267 constants when the realm has no env', () => {
    for (const os of [createNodeOs(), createNodeOs({}), nodeOs]) {
      expect(os.tmpdir()).toBe('/tmp');
      expect(os.homedir()).toBe(DEFAULT_HOME);
    }
  });

  it('returns a padded path verbatim — trimming would break process.env equality', () => {
    const os = createNodeOs({ TMPDIR: ' /tmp/odd name ', HOME: ' /home/odd ' });
    expect(os.tmpdir()).toBe(' /tmp/odd name ');
    expect(os.homedir()).toBe(' /home/odd ');
  });

  it('treats an empty or whitespace value as unset, never as a relative path', () => {
    const os = createNodeOs({ TMPDIR: '  ', HOME: '' });
    expect(os.tmpdir()).toBe('/tmp');
    expect(os.homedir()).toBe(DEFAULT_HOME);
  });

  it('reports the same machine identity as the process shim', () => {
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
