import { describe, expect, it, vi } from 'vitest';
import { withShebangExecHint } from '../../src/shell/shebang-exec-hint.js';

function fsWith(files: Record<string, string>) {
  return {
    resolvePath: (base: string, path: string) => {
      const raw = path.startsWith('/') ? path : `${base}/${path}`;
      const out: string[] = [];
      for (const segment of raw.split('/')) {
        if (segment === '' || segment === '.') continue;
        if (segment === '..') out.pop();
        else out.push(segment);
      }
      return `/${out.join('/')}`;
    },
    readFile: vi.fn(async (path: string) => {
      const content = files[path];
      if (content === undefined) throw new Error(`ENOENT: ${path}`);
      return content;
    }),
  };
}

describe('withShebangExecHint', () => {
  it('appends an interpreter hint when executing a shebang file is EACCES', async () => {
    const result = await withShebangExecHint(
      {
        stdout: '',
        stderr: 'bash: ./execbit-probe.sh: Permission denied\n',
        exitCode: 126,
      },
      '/tmp',
      fsWith({ '/tmp/execbit-probe.sh': '#!/bin/bash\necho ran-ok\n' })
    );
    expect(result.exitCode).toBe(126);
    expect(result.stderr).toContain('Permission denied');
    expect(result.stderr).toContain('run it with the interpreter, e.g. bash ./execbit-probe.sh');
  });

  it('names the shebang interpreter for env-style bang lines', async () => {
    const result = await withShebangExecHint(
      {
        stdout: '',
        stderr: '/workspace/tool.py: Permission denied\n',
        exitCode: 126,
      },
      '/workspace',
      fsWith({ '/workspace/tool.py': '#!/usr/bin/env python3\nprint(1)\n' })
    );
    expect(result.stderr).toContain('e.g. python3 /workspace/tool.py');
  });

  it('does not hint on success, missing shebang, or a chmod diagnostic', async () => {
    const fs = fsWith({ '/tmp/plain.txt': 'not a script\n' });
    await expect(
      withShebangExecHint({ stdout: 'ok\n', stderr: '', exitCode: 0 }, '/tmp', fs)
    ).resolves.toEqual({ stdout: 'ok\n', stderr: '', exitCode: 0 });

    const denied = {
      stdout: '',
      stderr: 'bash: ./plain.txt: Permission denied\n',
      exitCode: 126,
    };
    await expect(withShebangExecHint(denied, '/tmp', fs)).resolves.toEqual(denied);

    const chmod = {
      stdout: '',
      stderr:
        "chmod: EOPNOTSUPP: the VFS does not support an executable bit; run it with the interpreter, e.g. bash <file> '/tmp/x.sh'\n",
      exitCode: 1,
    };
    await expect(withShebangExecHint(chmod, '/tmp', fs)).resolves.toEqual(chmod);
  });
});
