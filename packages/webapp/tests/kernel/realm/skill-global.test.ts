/**
 * Tests for `createSkillGlobal` — the `skill` realm global.
 *
 * Covers:
 *  - Path math (skill.dir / refs / assets) for typical, root, and
 *    no-slash argv shapes.
 *  - skill.config() round-trip: missing file → null, read after write,
 *    shallow merge semantics, write error surfacing.
 *  - skill.token(providerId) delegates to `oauth-token <id>`, shell-
 *    quotes funny ids, propagates stderr on non-zero exit.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createSkillGlobal,
  type SkillExecBridge,
  type SkillFsBridge,
} from '../../../src/kernel/realm/skill-global.js';

function makeFs(initial: Record<string, string> = {}): SkillFsBridge & {
  store: Map<string, string>;
} {
  const store = new Map<string, string>(Object.entries(initial));
  return {
    store,
    async readFile(path: string) {
      const v = store.get(path);
      if (v === undefined) throw new Error('ENOENT: ' + path);
      return v;
    },
    async writeFile(path: string, content: string) {
      store.set(path, content);
      return true as const;
    },
    async exists(path: string) {
      return store.has(path);
    },
  };
}

function makeExec(
  impl: (cmd: string) => { stdout: string; stderr: string; exitCode: number }
): SkillExecBridge & { calls: string[] } {
  const calls: string[] = [];
  const exec = (async (cmd: string) => {
    calls.push(cmd);
    return impl(cmd);
  }) as SkillExecBridge & { calls: string[] };
  exec.calls = calls;
  return exec;
}

describe('createSkillGlobal — path math', () => {
  it('resolves dir/refs/assets from a typical argv[1]', () => {
    const skill = createSkillGlobal({
      argv: ['node', '/workspace/skills/concur/concur.jsh'],
      fs: makeFs(),
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(skill.dir).toBe('/workspace/skills/concur');
    expect(skill.refs).toBe('/workspace/skills/concur/references');
    expect(skill.assets).toBe('/workspace/skills/concur/assets');
  });

  it('handles a script at the filesystem root', () => {
    const skill = createSkillGlobal({
      argv: ['node', '/runme.jsh'],
      fs: makeFs(),
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(skill.dir).toBe('/');
    expect(skill.refs).toBe('//references');
    expect(skill.assets).toBe('//assets');
  });

  it('falls back to empty dir when argv[1] has no slash', () => {
    const skill = createSkillGlobal({
      argv: ['node', 'inline'],
      fs: makeFs(),
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(skill.dir).toBe('');
    expect(skill.refs).toBe('references');
    expect(skill.assets).toBe('assets');
  });

  it('produces a frozen object', () => {
    const skill = createSkillGlobal({
      argv: ['node', '/workspace/skills/x/x.jsh'],
      fs: makeFs(),
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(Object.isFrozen(skill)).toBe(true);
  });
});

describe('skill.config()', () => {
  const argv = ['node', '/workspace/skills/concur/concur.jsh'];
  const configPath = '/workspace/skills/concur/.config';

  it('returns null when the config file is missing', async () => {
    const fs = makeFs();
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(await skill.config()).toBeNull();
  });

  it('parses an existing JSON object', async () => {
    const fs = makeFs({ [configPath]: '{"companyId":"123","mode":"prod"}' });
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(await skill.config()).toEqual({ companyId: '123', mode: 'prod' });
  });

  it('writes a fresh config and round-trips it', async () => {
    const fs = makeFs();
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    const merged = await skill.config({ companyId: '123' });
    expect(merged).toEqual({ companyId: '123' });
    expect(fs.store.has(configPath)).toBe(true);
    expect(await skill.config()).toEqual({ companyId: '123' });
  });

  it('shallow-merges over existing keys', async () => {
    const fs = makeFs({ [configPath]: '{"companyId":"123","mode":"prod"}' });
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    const merged = await skill.config({ mode: 'dev', newKey: true });
    expect(merged).toEqual({ companyId: '123', mode: 'dev', newKey: true });
    expect(await skill.config()).toEqual({ companyId: '123', mode: 'dev', newKey: true });
  });
});

describe('skill.config() — error paths', () => {
  const argv = ['node', '/workspace/skills/x/x.jsh'];
  const configPath = '/workspace/skills/x/.config';

  it('throws on malformed JSON', async () => {
    const fs = makeFs({ [configPath]: 'not json {' });
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    await expect(skill.config()).rejects.toThrow(/failed to parse/);
  });

  it('throws when stored value is not a plain object', async () => {
    const fs = makeFs({ [configPath]: '[1,2,3]' });
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    await expect(skill.config()).rejects.toThrow(/must contain a JSON object/);
  });

  it('rejects non-object updates', async () => {
    const skill = createSkillGlobal({
      argv,
      fs: makeFs(),
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    await expect(skill.config([1, 2] as unknown as Record<string, unknown>)).rejects.toThrow(
      TypeError
    );
    await expect(skill.config(null as unknown as Record<string, unknown>)).rejects.toThrow(
      TypeError
    );
  });

  it('treats empty file content as no config', async () => {
    const fs = makeFs({ [configPath]: '   \n' });
    const skill = createSkillGlobal({
      argv,
      fs,
      exec: makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 })),
    });
    expect(await skill.config()).toBeNull();
  });
});

describe('skill.token(providerId)', () => {
  const argv = ['node', '/workspace/skills/concur/concur.jsh'];

  it('delegates to oauth-token and returns trimmed stdout', async () => {
    const exec = makeExec(() => ({ stdout: 'ghp_xxxxMASKEDxxxx\n', stderr: '', exitCode: 0 }));
    const skill = createSkillGlobal({ argv, fs: makeFs(), exec });
    const tok = await skill.token('github');
    expect(tok).toBe('ghp_xxxxMASKEDxxxx');
    expect(exec.calls).toEqual(['oauth-token github']);
  });

  it('shell-quotes provider ids with funny characters', async () => {
    const exec = makeExec(() => ({ stdout: 'tok\n', stderr: '', exitCode: 0 }));
    const skill = createSkillGlobal({ argv, fs: makeFs(), exec });
    await skill.token('mcp:weird name');
    expect(exec.calls[0]).toBe("oauth-token 'mcp:weird name'");
  });

  it('surfaces stderr on a non-zero exit', async () => {
    const exec = makeExec(() => ({
      stdout: '',
      stderr: 'oauth-token: unknown provider "nope"\n',
      exitCode: 1,
    }));
    const skill = createSkillGlobal({ argv, fs: makeFs(), exec });
    await expect(skill.token('nope')).rejects.toThrow(/unknown provider/);
  });

  it('rejects empty providerId', async () => {
    const exec = makeExec(() => ({ stdout: '', stderr: '', exitCode: 0 }));
    const skill = createSkillGlobal({ argv, fs: makeFs(), exec });
    await expect(skill.token('')).rejects.toThrow(TypeError);
    await expect(skill.token('   ')).rejects.toThrow(TypeError);
    expect(exec.calls).toEqual([]);
  });

  it('synthesizes a helpful error when stderr is empty', async () => {
    const exec = makeExec(() => ({ stdout: '', stderr: '', exitCode: 2 }));
    const skill = createSkillGlobal({ argv, fs: makeFs(), exec });
    await expect(skill.token('github')).rejects.toThrow(/exited with code 2/);
  });
});

describe('createSkillGlobal — end-to-end', () => {
  it('integrates dir, config, and token through a typical skill flow', async () => {
    const argv = ['node', '/workspace/skills/oryx/oryx.jsh'];
    const fs = makeFs();
    const exec = makeExec(() => ({ stdout: 'masked-token\n', stderr: '', exitCode: 0 }));
    const skill = createSkillGlobal({ argv, fs, exec });

    expect(skill.dir).toBe('/workspace/skills/oryx');
    expect(await skill.config()).toBeNull();
    await skill.config({ apiBase: 'https://oryx.example.com' });
    expect(await skill.config()).toEqual({ apiBase: 'https://oryx.example.com' });

    const stored = fs.store.get('/workspace/skills/oryx/.config');
    expect(stored).toBeTypeOf('string');
    expect(stored!.endsWith('\n')).toBe(true);
    expect(JSON.parse(stored!)).toEqual({ apiBase: 'https://oryx.example.com' });

    const tok = await skill.token('oryx');
    expect(tok).toBe('masked-token');
    expect(exec.calls).toEqual(['oauth-token oryx']);
  });
});

// Silence unused-import warning for `vi` if no spy ends up in the file.
void vi;
