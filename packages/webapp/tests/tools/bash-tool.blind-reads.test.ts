/**
 * #3459 end to end through the real shell: a memory pass's `bash` result
 * carries the blind-read note for every route a probe can take — `cat`,
 * `ls /`, `readlink`, `cp` — including the ones the shell's adapter serves
 * from synchronous fast paths or dedicated methods (Codex on #3483). The
 * shell prints `No such file or directory` either way; the note is what
 * tells the pass that the answer was the sandbox edge.
 */

import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BlindReadLog } from '../../src/base/blind-reads.js';
import { createBlindReadFs } from '../../src/fs/blind-read-fs.js';
import { RestrictedFS, VirtualFS } from '../../src/fs/index.js';
import { AlmostBashShellHeadless } from '../../src/shell/almost-bash-shell-headless.js';
import { createBashTool } from '../../src/tools/bash-tool.js';
import type { ToolDefinition } from '../../src/tools/types.js';

const VISIBLE = ['/sessions/', '/shared/', '/workspace/'];
const DRAFT = '/sessions/.curation/dream-x.md/draft.md';
// A scoop's shell has HOME pinned to its own folder (`buildScoopShellEnv`), so
// the `~/.profile` sourcing before the first command is not a blind read.
const HOME = '/scoops/agent-memory-dreamer/home';

describe('bash tool + blind-read fs (#3459)', () => {
  let vfs: VirtualFS;
  let log: BlindReadLog;
  let bash: ToolDefinition;
  let dbCounter = 0;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `test-bash-blind-${dbCounter++}`, wipe: true });
    await vfs.mkdir('/etc', { recursive: true });
    await vfs.mkdir('/workspace', { recursive: true });
    await vfs.mkdir('/tmp', { recursive: true });
    await vfs.mkdir('/sessions/.curation/dream-x.md', { recursive: true });
    await vfs.writeFile('/etc/llmstxtignore', 'www.printful.com\n');
    await vfs.symlink('/etc/llmstxtignore', '/etc/link');
    await vfs.writeFile('/workspace/CLAUDE.md', '# Memory\n');
    await vfs.writeFile(DRAFT, '# Memory\n');
    await vfs.mkdir(HOME, { recursive: true });
    const restricted = new RestrictedFS(vfs, [DRAFT, `${HOME}/`], VISIBLE);
    log = new BlindReadLog(VISIBLE);
    const fs = createBlindReadFs(restricted as unknown as VirtualFS, restricted, log);
    const shell = new AlmostBashShellHeadless({ fs, cwd: '/workspace', env: { HOME } });
    bash = createBashTool(shell, fs, '/tmp', { annotateResult: () => log.takeNote() });
  });

  afterEach(async () => {
    await vfs.dispose();
  });

  it('annotates cat, readlink and cp of an outside path, and ls of a filtered parent', async () => {
    const cat = await bash.execute({ command: 'cat /etc/llmstxtignore' });
    expect(cat.content).toContain('No such file or directory');
    expect(cat.content).toMatch(/\[not visible from this pass\] [^\n]*\/etc\/llmstxtignore/);

    const ls = await bash.execute({ command: 'ls /' });
    expect(ls.content).toContain('workspace');
    expect(ls.content).not.toMatch(/^etc$/m);
    expect(ls.content).toContain('[filtered listing] /');

    const readlink = await bash.execute({ command: 'readlink /etc/link' });
    expect(readlink.content).toMatch(/\[not visible from this pass\] [^\n]*\/etc\/link/);

    // `cp` is the one command that relays the fs message itself; and a path
    // already reported by the `cat` above is not repeated in the note.
    const cp = await bash.execute({ command: 'cp /etc/llmstxtignore /tmp/copy' });
    expect(cp.content).toContain('unknown from here, not absent');
    expect(cp.content).not.toContain('[not visible from this pass]');
    expect(await vfs.exists('/tmp/copy')).toBe(false);
    const cpFresh = await bash.execute({ command: 'cp /etc/other /tmp/copy' });
    expect(cpFresh.content).toMatch(/\[not visible from this pass\] [^\n]*\/etc\/other/);

    expect(log.outsidePaths()).toEqual(expect.arrayContaining(['/etc/llmstxtignore', '/etc/link']));
  });

  it('adds no note to a command that stayed inside the roots, nor to an unknown command', async () => {
    const result = await bash.execute({ command: 'cat /workspace/CLAUDE.md; ls /workspace' });
    expect(result.content).toContain('# Memory');
    expect(result.content).not.toContain('[not visible');
    expect(result.content).not.toContain('[filtered listing]');
    // The shell's own `/usr/bin/<name>` lookup is not the pass's probe.
    const missing = await bash.execute({ command: 'nosuchcmd' });
    expect(missing.content).toContain('command not found');
    expect(missing.content).not.toContain('[not visible');
  });
});
