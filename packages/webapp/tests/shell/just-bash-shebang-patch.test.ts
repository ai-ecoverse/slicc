import { Bash, defineCommand } from 'just-bash';
import { Bash as BrowserBash, defineCommand as defineBrowserCommand } from 'just-bash/browser';
import { describe, expect, it } from 'vitest';

// Upstream ran every executable file as a bash script and dropped its
// shebang, so `./example` built by `emcc -o example` (#!/usr/bin/env node)
// failed to parse. A non-shell shebang now runs its interpreter on the file.
describe.each([
  ['node', Bash, defineCommand],
  ['browser', BrowserBash, defineBrowserCommand],
] as const)('just-bash shebang dispatch patch (%s)', (_runtime, Shell, define) => {
  const node = define('node', async (args: string[]) => ({
    stdout: `node ran ${args.join('|')}\n`,
    stderr: '',
    exitCode: 3,
  }));
  const files = {
    '/t/js': '#!/usr/bin/env node\nconsole.log(1)\n',
    '/t/direct': '#!/usr/bin/node\nconsole.log(1)\n',
    '/t/sh': '#!/bin/sh\necho "sh script $1"\n',
    '/t/envbash': '#!/usr/bin/env bash\necho "bash script $#"\n',
    '/t/plain': 'echo plain\n',
  };
  const shell = async () => {
    const sh = new Shell({ customCommands: [node], files });
    await sh.exec('chmod +x /t/js /t/direct /t/sh /t/envbash /t/plain');
    return sh;
  };

  it('runs a non-shell interpreter on the file with the arguments', async () => {
    const sh = await shell();
    expect((await sh.exec('/t/js a "b c"; echo rc=$?')).stdout).toBe(
      'node ran /t/js|a|b c\nrc=3\n'
    );
    expect((await sh.exec('/t/direct x')).stdout).toBe('node ran /t/direct|x\n');
  });

  it('keeps shell shebangs and shebang-less files as bash scripts', async () => {
    const sh = await shell();
    expect((await sh.exec('/t/sh x')).stdout).toBe('sh script x\n');
    expect((await sh.exec('/t/envbash 1 2')).stdout).toBe('bash script 2\n');
    expect((await sh.exec('/t/plain')).stdout).toBe('plain\n');
  });

  it('`bash file` still reads the file as shell, whatever its shebang', async () => {
    const sh = await shell();
    await sh.exec('printf "#!/usr/bin/env node\\necho as-bash\\n" > /f.sh');
    expect((await sh.exec('bash /f.sh')).stdout).toBe('as-bash\n');
  });
});
