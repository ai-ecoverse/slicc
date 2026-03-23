import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IFileSystem } from 'just-bash';
import {
  createPbcopyCommand,
  createPbpasteCommand,
  createClipboardAutoCommand,
} from '../../../src/shell/supplemental-commands/clipboard-commands.js';

function createMockCtx(stdin = '') {
  const fs: Partial<IFileSystem> = {
    resolvePath: (base: string, path: string) => (path.startsWith('/') ? path : `${base}/${path}`),
  };

  return {
    fs: fs as IFileSystem,
    cwd: '/home',
    env: new Map<string, string>(),
    stdin,
  };
}

function stubClipboard() {
  let stored = '';
  const clipboard = {
    writeText: vi.fn(async (text: string) => {
      stored = text;
    }),
    readText: vi.fn(async () => stored),
  };
  vi.stubGlobal('navigator', { clipboard });
  return clipboard;
}

describe('pbcopy command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createPbcopyCommand();
    expect(cmd.name).toBe('pbcopy');
  });

  it('shows help with --help', async () => {
    const cmd = createPbcopyCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pbcopy');
  });

  it('shows help with -h', async () => {
    const cmd = createPbcopyCommand();
    const result = await cmd.execute(['-h'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pbcopy');
  });

  it('copies stdin to clipboard', async () => {
    const clipboard = stubClipboard();
    const cmd = createPbcopyCommand();
    const result = await cmd.execute([], createMockCtx('hello world'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(clipboard.writeText).toHaveBeenCalledWith('hello world');
  });

  it('copies empty stdin to clipboard', async () => {
    const clipboard = stubClipboard();
    const cmd = createPbcopyCommand();
    const result = await cmd.execute([], createMockCtx(''));
    expect(result.exitCode).toBe(0);
    expect(clipboard.writeText).toHaveBeenCalledWith('');
  });

  it('returns error when clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const cmd = createPbcopyCommand();
    const result = await cmd.execute([], createMockCtx('test'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('clipboard API is unavailable');
  });

  it('returns error when writeText fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        writeText: vi.fn(async () => {
          throw new Error('Permission denied');
        }),
      },
    });
    const cmd = createPbcopyCommand();
    const result = await cmd.execute([], createMockCtx('test'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to write to clipboard');
  });
});

describe('pbpaste command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createPbpasteCommand();
    expect(cmd.name).toBe('pbpaste');
  });

  it('shows help with --help', async () => {
    const cmd = createPbpasteCommand();
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: pbpaste');
  });

  it('reads clipboard and outputs verbatim (no trailing newline)', async () => {
    const clipboard = stubClipboard();
    clipboard.readText.mockResolvedValue('clipboard content');
    const cmd = createPbpasteCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('clipboard content');
    expect(result.stderr).toBe('');
  });

  it('returns error when clipboard is unavailable', async () => {
    vi.stubGlobal('navigator', {});
    const cmd = createPbpasteCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('clipboard API is unavailable');
  });

  it('returns error when readText fails', async () => {
    vi.stubGlobal('navigator', {
      clipboard: {
        readText: vi.fn(async () => {
          throw new Error('Permission denied');
        }),
      },
    });
    const cmd = createPbpasteCommand();
    const result = await cmd.execute([], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('failed to read from clipboard');
  });
});

describe('xclip / xsel auto-detect command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates command with given name', () => {
    expect(createClipboardAutoCommand('xclip').name).toBe('xclip');
    expect(createClipboardAutoCommand('xsel').name).toBe('xsel');
  });

  it('shows help with --help', async () => {
    const cmd = createClipboardAutoCommand('xclip');
    const result = await cmd.execute(['--help'], createMockCtx());
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('usage: xclip');
  });

  it('copies when stdin is provided', async () => {
    const clipboard = stubClipboard();
    const cmd = createClipboardAutoCommand('xclip');
    const result = await cmd.execute([], createMockCtx('some text'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('');
    expect(clipboard.writeText).toHaveBeenCalledWith('some text');
  });

  it('pastes when stdin is empty', async () => {
    const clipboard = stubClipboard();
    clipboard.readText.mockResolvedValue('pasted text');
    const cmd = createClipboardAutoCommand('xsel');
    const result = await cmd.execute([], createMockCtx(''));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('pasted text');
  });

  it('returns error when clipboard is unavailable (copy)', async () => {
    vi.stubGlobal('navigator', {});
    const cmd = createClipboardAutoCommand('xclip');
    const result = await cmd.execute([], createMockCtx('data'));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('xclip: clipboard API is unavailable');
  });

  it('returns error when clipboard is unavailable (paste)', async () => {
    vi.stubGlobal('navigator', {});
    const cmd = createClipboardAutoCommand('xsel');
    const result = await cmd.execute([], createMockCtx(''));
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('xsel: clipboard API is unavailable');
  });
});

describe('pbcopy + pbpaste integration', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('round-trips text through clipboard verbatim', async () => {
    stubClipboard();
    const copy = createPbcopyCommand();
    const paste = createPbpasteCommand();

    await copy.execute([], createMockCtx('round trip'));
    const result = await paste.execute([], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('round trip');
  });
});

describe('xclip/xsel explicit mode flags', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('forces copy mode with -i even with empty stdin', async () => {
    const clipboard = stubClipboard();
    const cmd = createClipboardAutoCommand('xclip');
    const result = await cmd.execute(['-i'], createMockCtx(''));
    expect(result.exitCode).toBe(0);
    expect(clipboard.writeText).toHaveBeenCalledWith('');
  });

  it('forces paste mode with -o even with stdin present', async () => {
    const clipboard = stubClipboard();
    clipboard.readText.mockResolvedValue('from clipboard');
    const cmd = createClipboardAutoCommand('xsel');
    const result = await cmd.execute(['-o'], createMockCtx('ignored stdin'));
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('from clipboard');
  });

  it('errors when both -i and -o are provided', async () => {
    stubClipboard();
    const cmd = createClipboardAutoCommand('xclip');
    const result = await cmd.execute(['-i', '-o'], createMockCtx());
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('cannot use both -i and -o');
  });
});
