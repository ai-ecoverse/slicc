import { describe, expect, it } from 'vitest';
import { buildScoopShellEnv, ownLickTargetFor } from '../../src/scoops/scoop-context.js';
import { DEFAULT_JSH_SEARCH_ROOTS } from '../../src/shell/jsh-discovery.js';
import { LICK_TARGET_ENV } from '../../src/shell/lick-target-env.js';

describe('buildScoopShellEnv', () => {
  it('pins HOME, USER, and PATH for a non-cone scoop', () => {
    const env = buildScoopShellEnv({
      isCone: false,
      folder: 'research',
      secretEnv: {},
      tmpDir: '/tmp/cone/research',
    });
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

  it('a scoop carries SLICC_LICK_TARGET too, so its own licks come back to it (Codex P1 on #2525)', () => {
    const env = buildScoopShellEnv({
      isCone: false,
      folder: 'helper-scoop',
      secretEnv: {},
      tmpDir: '/tmp/cone/helper-scoop',
      lickTarget: 'helper-scoop',
    });
    expect(env[LICK_TARGET_ENV]).toBe('helper-scoop');

    expect(env.HOME).toBe('/scoops/helper-scoop/home');
    expect(env.USER).toBe('helper-scoop');
  });

  it('a secret cannot spoof a scoop lick target either', () => {
    expect(
      buildScoopShellEnv({
        isCone: false,
        folder: 'helper-scoop',
        secretEnv: { [LICK_TARGET_ENV]: 'cone' },
        tmpDir: '/tmp/cone/helper-scoop',
        lickTarget: 'helper-scoop',
      })[LICK_TARGET_ENV]
    ).toBe('helper-scoop');
  });

  it('every unit pins TMPDIR — a scoop under its owning cone (#2267)', () => {
    expect(
      buildScoopShellEnv({
        isCone: false,
        folder: 'research',
        secretEnv: {},
        tmpDir: '/tmp/cone-adobe/research',
      }).TMPDIR
    ).toBe('/tmp/cone-adobe/research');
  });

  it('a secret named TMPDIR cannot redirect a unit onto another cone scratch root', () => {
    expect(
      buildScoopShellEnv({
        isCone: true,
        folder: 'cone-adobe',
        secretEnv: { TMPDIR: '/tmp/cone' },
        tmpDir: '/tmp/cone-adobe',
      }).TMPDIR
    ).toBe('/tmp/cone-adobe');
  });

  it('a scoop with no target stays untargeted rather than inventing one', () => {
    expect(
      buildScoopShellEnv({
        isCone: false,
        folder: 'research',
        secretEnv: {},
        tmpDir: '/tmp/cone/research',
      })[LICK_TARGET_ENV]
    ).toBeUndefined();
  });

  it('the cone pins nothing — only secrets pass through', () => {
    const env = buildScoopShellEnv({
      isCone: true,
      folder: 'main',
      secretEnv: { API_KEY: 'masked' },
      tmpDir: '/tmp/main',
    });

    expect(env).toEqual({ API_KEY: 'masked', TMPDIR: '/tmp/main' });
  });

  it('an extra cone carries SLICC_LICK_TARGET so its licks come back to it (#2272)', () => {
    expect(
      buildScoopShellEnv({
        isCone: true,
        folder: 'cone-research',
        secretEnv: { API_KEY: 'k' },
        tmpDir: '/tmp/cone-research',
        lickTarget: 'cone-research',
      })
    ).toEqual({
      API_KEY: 'k',
      TMPDIR: '/tmp/cone-research',
      [LICK_TARGET_ENV]: 'cone-research',
    });

    expect(
      buildScoopShellEnv({
        isCone: true,
        folder: 'cone-research',
        secretEnv: { [LICK_TARGET_ENV]: 'cone' },
        tmpDir: '/tmp/cone-research',
        lickTarget: 'cone-research',
      })[LICK_TARGET_ENV]
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
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone', jid: 'cone_3' }, 'cone_2')
    ).toBe('cone');
  });

  it('an unknown default root leaves every cone naming itself', () => {
    expect(
      ownLickTargetFor(root, { parentJid: null, folder: 'cone', jid: 'cone_1' }, undefined)
    ).toBe('cone');
  });

  it('a secret named PATH/HOME/USER cannot override the scoop pins (Codex P2)', () => {
    const env = buildScoopShellEnv({
      isCone: false,
      folder: 'research',
      secretEnv: {
        PATH: '/evil',
        HOME: '/evil-home',
        USER: 'root',
        TMPDIR: '/evil-tmp',
        API_KEY: 'masked',
      },
      tmpDir: '/tmp/cone/research',
    });
    expect(env.PATH).toContain('/scoops/research/workspace/skills');
    expect(env.PATH).not.toContain('/evil');
    expect(env.HOME).toBe('/scoops/research/home');
    expect(env.USER).toBe('research');
    expect(env.TMPDIR).toBe('/tmp/cone/research');

    expect(env.API_KEY).toBe('masked');
  });
});
