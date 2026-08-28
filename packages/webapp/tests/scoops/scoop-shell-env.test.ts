/**
 * Tests for buildScoopShellEnv (#2085 + Codex P2 on #2143): scoop shells pin
 * HOME/USER/PATH, every unit pins TMPDIR (#2267), and user-created secrets
 * must never override any of those pins.
 */

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
    // `ownLickTargetFor` answers `scoop.folder` for a child and `tools.ts`
    // already stamps it on background-`bash` licks. Dropping it here made the
    // env-driven producers (`fswatch`/`crontask`/`webhook`) in the SAME shell
    // fall through to `rootsOf(scoops)[0]` and deliver a scoop's callbacks
    // into an unrelated cone's chat.
    const env = buildScoopShellEnv({
      isCone: false,
      folder: 'helper-scoop',
      secretEnv: {},
      tmpDir: '/tmp/cone/helper-scoop',
      lickTarget: 'helper-scoop',
    });
    expect(env[LICK_TARGET_ENV]).toBe('helper-scoop');
    // The isolation pins still hold alongside it.
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
    // `echo $TMPDIR` printed empty in cone and scoop alike, so nothing could
    // discover a scratch root at all and `mktemp` had no sane default.
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
    // Same class as the PATH/HOME/USER spoof (Codex P2 on #2143): secrets
    // spread first so an isolation pin always wins.
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
    // TMPDIR is the one pin every unit carries (#2267) — a cone has to be
    // able to discover its own scratch root too.
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
    // A secret cannot spoof the target.
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
    // Ordinary secrets still pass through.
    expect(env.API_KEY).toBe('masked');
  });
});
