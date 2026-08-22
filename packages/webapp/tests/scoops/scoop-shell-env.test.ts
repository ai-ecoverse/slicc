/**
 * Tests for buildScoopShellEnv (#2085 + Codex P2 on #2143): scoop shells pin
 * HOME/USER/PATH, and user-created secrets must never override those pins.
 */

import { describe, expect, it } from 'vitest';
import { buildScoopShellEnv, ownLickTargetFor } from '../../src/scoops/scoop-context.js';
import { DEFAULT_JSH_SEARCH_ROOTS } from '../../src/shell/jsh-discovery.js';
import { LICK_TARGET_ENV } from '../../src/shell/lick-target-env.js';

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

  it('an extra cone carries SLICC_LICK_TARGET so its licks come back to it (#2272)', () => {
    expect(buildScoopShellEnv(true, 'cone-research', { API_KEY: 'k' }, 'cone-research')).toEqual({
      API_KEY: 'k',
      [LICK_TARGET_ENV]: 'cone-research',
    });
    // A secret cannot spoof the target.
    expect(
      buildScoopShellEnv(true, 'cone-research', { [LICK_TARGET_ENV]: 'cone' }, 'cone-research')[
        LICK_TARGET_ENV
      ]
    ).toBe('cone-research');
  });
});

describe('ownLickTargetFor', () => {
  const child = { display: { role: 'child' as const, label: 'x' } };
  const root = { display: { role: 'primary' as const, label: 'x' } };
  it('children and extra cones name themselves; the default root stays untargeted', () => {
    expect(
      ownLickTargetFor(child, { parentJid: 'cone_1', folder: 'helper-scoop', jid: 'x_1' }, 'cone_1')
    ).toBe('helper-scoop');
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone-research', jid: 'cone_2' }, 'cone_1')
    ).toBe('cone-research');
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone', jid: 'cone_1' }, 'cone_1')
    ).toBeUndefined();
  });

  it('a cone that inherited the freed `cone` folder still names itself (Codex P1)', () => {
    // The original primary was dropped, so `coneFolderFor()` handed its freed
    // `cone` folder to this newer cone -- but the untargeted default is still
    // the oldest *surviving* root (`cone_2`). A folder test would call this
    // one primary and drop its stamp, sending its licks to `cone_2`'s chat.
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone', jid: 'cone_3' }, 'cone_2')
    ).toBe('cone');
  });

  it('an unknown default root leaves every cone naming itself', () => {
    // Fail safe: an explicit self-stamp still routes to the right unit,
    // whereas a dropped stamp would silently fall back to another cone.
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone', jid: 'cone_1' }, undefined)
    ).toBe('cone');
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
