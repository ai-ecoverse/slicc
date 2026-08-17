/**
 * Tests for buildScoopShellEnv (#2085 + Codex P2 on #2143): scoop shells pin
 * HOME/USER/PATH, and user-created secrets must never override those pins.
 */

import { describe, expect, it } from 'vitest';
import { buildScoopShellEnv } from '../../src/scoops/scoop-context.js';
import { DEFAULT_JSH_SEARCH_ROOTS } from '../../src/shell/jsh-discovery.js';

describe('buildScoopShellEnv', () => {
  it('pins HOME, USER, and PATH for a non-cone scoop', () => {
    const env = buildScoopShellEnv(false, 'research', {});
    expect(env.HOME).toBe('/scoops/research/home');
    expect(env.USER).toBe('research');
    expect(env.PATH).toBe(
      [
        '/usr/bin',
        '/scoops/research/workspace/skills',
        '/scoops/research/workspace/bin',
        ...DEFAULT_JSH_SEARCH_ROOTS,
      ].join(':')
    );
  });

  it('the cone pins nothing — only secrets pass through', () => {
    const env = buildScoopShellEnv(true, 'main', { API_KEY: 'masked' });
    expect(env).toEqual({ API_KEY: 'masked' });
  });

  it('a secret named PATH/HOME/USER cannot override the scoop pins (Codex P2)', () => {
    const env = buildScoopShellEnv(false, 'research', {
      PATH: '/evil',
      HOME: '/evil-home',
      USER: 'root',
      API_KEY: 'masked',
    });
    expect(env.PATH).toContain('/scoops/research/workspace/skills');
    expect(env.PATH).not.toContain('/evil');
    expect(env.HOME).toBe('/scoops/research/home');
    expect(env.USER).toBe('research');
    // Ordinary secrets still pass through.
    expect(env.API_KEY).toBe('masked');
  });
});
