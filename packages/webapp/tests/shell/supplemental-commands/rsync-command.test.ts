import { describe, it, expect, beforeEach } from 'vitest';
import 'fake-indexeddb/auto';
import { parseRsyncArgs, createRsyncCommand, type SendFsRequestFn } from '../../../src/shell/supplemental-commands/rsync-command.js';
import { VirtualFS } from '../../../src/fs/virtual-fs.js';
import type { TrayFsRequest, TrayFsResponse } from '../../../src/scoops/tray-sync-protocol.js';

// ---------------------------------------------------------------------------
// parseRsyncArgs
// ---------------------------------------------------------------------------

describe('parseRsyncArgs', () => {
  it('parses a push command (local → remote)', () => {
    const result = parseRsyncArgs(['/workspace', 'follower-abc:/remote']);
    expect(result).toEqual({
      direction: 'push',
      localPath: '/workspace',
      remotePath: '/remote',
      runtimeId: 'follower-abc',
      dryRun: false,
      delete: false,
      verbose: false,
    });
  });

  it('parses a pull command (remote → local)', () => {
    const result = parseRsyncArgs(['leader:/shared', '/local']);
    expect(result).toEqual({
      direction: 'pull',
      localPath: '/local',
      remotePath: '/shared',
      runtimeId: 'leader',
      dryRun: false,
      delete: false,
      verbose: false,
    });
  });

  it('parses flags', () => {
    const result = parseRsyncArgs(['--dry-run', '--delete', '--verbose', '/a', 'r:/b']);
    expect(result).toEqual(
      expect.objectContaining({
        dryRun: true,
        delete: true,
        verbose: true,
      })
    );
  });

  it('parses short flags', () => {
    const result = parseRsyncArgs(['-n', '-v', '/a', 'r:/b']);
    expect(result).toEqual(
      expect.objectContaining({
        dryRun: true,
        verbose: true,
      })
    );
  });

  it('rejects two remote paths', () => {
    const result = parseRsyncArgs(['a:/foo', 'b:/bar']);
    expect(result).toEqual({
      error: 'Cannot sync between two remote paths — one side must be local',
    });
  });

  it('rejects two local paths', () => {
    const result = parseRsyncArgs(['/foo', '/bar']);
    expect(result).toEqual({ error: 'One argument must be a remote path (runtime-id:/path)' });
  });

  it('rejects wrong number of positional args', () => {
    const result = parseRsyncArgs(['/foo']);
    expect(result).toEqual({ error: 'Expected exactly 2 arguments: <source> <dest>' });
  });

  it('rejects unknown flags', () => {
    const result = parseRsyncArgs(['--unknown', '/a', 'r:/b']);
    expect(result).toEqual({ error: 'Unknown flag: --unknown' });
  });

  it('returns help marker for --help', () => {
    const result = parseRsyncArgs(['--help']);
    expect(result).toEqual({ error: '__help__' });
  });

  it('does not treat relative path with colon as remote', () => {
    // "foo" before colon followed by non-absolute path should be local
    const result = parseRsyncArgs(['foo:bar', '/local']);
    expect(result).toEqual({ error: 'One argument must be a remote path (runtime-id:/path)' });
  });
});

// ---------------------------------------------------------------------------
// createRsyncCommand — integration with mock fs
// ---------------------------------------------------------------------------

let dbCounter = 0;

describe('createRsyncCommand', () => {
  let vfs: VirtualFS;
  let mockSendFsRequest: SendFsRequestFn;
  let sendCalls: Array<{ runtimeId: string; request: TrayFsRequest }>;

  beforeEach(async () => {
    vfs = await VirtualFS.create({ dbName: `rsync-test-${dbCounter++}`, wipe: true });
    await vfs.mkdir('/workspace', { recursive: true });

    sendCalls = [];

    // Set up a simple mock remote filesystem state
    const remoteFiles: Record<string, { content: string; size: number; mtime: number }> = {};

    mockSendFsRequest = async (
      runtimeId: string,
      request: TrayFsRequest
    ): Promise<TrayFsResponse[]> => {
      sendCalls.push({ runtimeId, request });

      switch (request.op) {
        case 'walk': {
          const paths = Object.keys(remoteFiles)
            .filter((p) => p.startsWith(request.path))
            .sort();
          return [{ ok: true, data: { type: 'paths', paths } }];
        }
        case 'stat': {
          const f = remoteFiles[request.path];
          if (!f) return [{ ok: false, error: 'ENOENT', code: 'ENOENT' }];
          return [
            {
              ok: true,
              data: {
                type: 'stat',
                stat: { type: 'file', size: f.size, mtime: f.mtime, ctime: f.mtime },
              },
            },
          ];
        }
        case 'readFile': {
          const f = remoteFiles[request.path];
          if (!f) return [{ ok: false, error: 'ENOENT', code: 'ENOENT' }];
          // Return base64
          const b64 = btoa(f.content);
          return [{ ok: true, data: { type: 'file', content: b64, encoding: 'base64' } }];
        }
        case 'writeFile': {
          const content = request.encoding === 'base64' ? atob(request.content) : request.content;
          remoteFiles[request.path] = { content, size: content.length, mtime: Date.now() };
          return [{ ok: true, data: { type: 'void' } }];
        }
        case 'mkdir': {
          return [{ ok: true, data: { type: 'void' } }];
        }
        case 'rm': {
          delete remoteFiles[request.path];
          return [{ ok: true, data: { type: 'void' } }];
        }
        case 'exists': {
          return [{ ok: true, data: { type: 'exists', exists: request.path in remoteFiles } }];
        }
        default:
          return [{ ok: false, error: 'Unknown op' }];
      }
    };
  });

  function createCmd() {
    return createRsyncCommand({
      fs: vfs,
      getSendFsRequest: () => mockSendFsRequest,
    });
  }

  const ctx = {} as any;

  it('shows help with no args', async () => {
    const cmd = createCmd();
    const result = await cmd.execute([], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('rsync');
    expect(result.stdout).toContain('Usage');
  });

  it('shows help with --help', async () => {
    const cmd = createCmd();
    const result = await cmd.execute(['--help'], ctx);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('Usage');
  });

  it('errors when not connected to tray', async () => {
    const cmd = createRsyncCommand({
      fs: vfs,
      getSendFsRequest: () => null,
    });
    const result = await cmd.execute(['/a', 'r:/b'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('not connected to a tray');
  });

  it('errors without filesystem', async () => {
    const cmd = createRsyncCommand({
      getSendFsRequest: () => mockSendFsRequest,
    });
    const result = await cmd.execute(['/a', 'r:/b'], ctx);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('no filesystem available');
  });

  it('push: transfers local files to empty remote', async () => {
    await vfs.writeFile('/workspace/hello.txt', 'hello');
    await vfs.writeFile('/workspace/sub/deep.txt', 'deep');

    const cmd = createCmd();
    const result = await cmd.execute(['/workspace', 'remote:/dest'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('2 file(s) transferred');

    // Verify writeFile calls were made
    const writes = sendCalls.filter((c) => c.request.op === 'writeFile');
    expect(writes.length).toBe(2);
  });

  it('push --dry-run: does not actually transfer', async () => {
    await vfs.writeFile('/workspace/file.txt', 'data');

    const cmd = createCmd();
    const result = await cmd.execute(['--dry-run', '/workspace', 'remote:/dest'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('(dry run)');
    expect(result.stdout).toContain('1 file(s) would be transferred');

    // No writeFile calls
    const writes = sendCalls.filter((c) => c.request.op === 'writeFile');
    expect(writes.length).toBe(0);
  });

  it('push --verbose: shows per-file detail', async () => {
    await vfs.writeFile('/workspace/a.txt', 'aaa');

    const cmd = createCmd();
    const result = await cmd.execute(['--verbose', '/workspace', 'remote:/dest'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('+ a.txt');
  });

  it('pull: transfers remote files to empty local dir', async () => {
    // We need a remote that has files — set up via mockSendFsRequest override
    const remoteState: Record<string, { content: string; size: number; mtime: number }> = {
      '/remote/file.txt': { content: 'remote content', size: 14, mtime: 5000 },
    };

    const sendFn: SendFsRequestFn = async (_rid, req) => {
      if (req.op === 'walk') {
        const paths = Object.keys(remoteState).filter((p) => p.startsWith(req.path));
        return [{ ok: true, data: { type: 'paths', paths } }];
      }
      if (req.op === 'stat') {
        const f = remoteState[req.path];
        if (!f) return [{ ok: false, error: 'ENOENT', code: 'ENOENT' }];
        return [
          {
            ok: true,
            data: {
              type: 'stat',
              stat: { type: 'file', size: f.size, mtime: f.mtime, ctime: f.mtime },
            },
          },
        ];
      }
      if (req.op === 'readFile') {
        const f = remoteState[req.path];
        if (!f) return [{ ok: false, error: 'ENOENT', code: 'ENOENT' }];
        const b64 = btoa(f.content);
        return [{ ok: true, data: { type: 'file', content: b64, encoding: 'base64' } }];
      }
      return [{ ok: true, data: { type: 'void' } }];
    };

    const cmd = createRsyncCommand({ fs: vfs, getSendFsRequest: () => sendFn });
    const result = await cmd.execute(['remote:/remote', '/local'], ctx);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('1 file(s) transferred');

    // Verify local file was created
    const content = (await vfs.readFile('/local/file.txt', { encoding: 'utf-8' })) as string;
    expect(content).toBe('remote content');
  });
});
