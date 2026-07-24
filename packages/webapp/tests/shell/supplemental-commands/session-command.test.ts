import { TranscriptExportError } from '@slicc/shared-ts';
import { sha256 } from 'js-sha256';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createSessionCommand } from '../../../src/shell/supplemental-commands/session-command.js';
import { registerTranscriptExportService } from '../../../src/transcript/export-provider.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

// Reset the provider between tests
let teardown: (() => void) | null = null;

beforeEach(() => {
  teardown?.();
  teardown = null;
});

function makeChunks(bytes: Uint8Array): () => AsyncIterable<Uint8Array> {
  return async function* () {
    yield bytes;
  };
}

function makeService(zipBytes: Uint8Array) {
  const chunks = makeChunks(zipBytes);
  return {
    export: vi.fn(async () => ({
      filename: 'bundle.zip',
      chunks: chunks(),
      completion: Promise.resolve({
        byteLength: zipBytes.byteLength,
        sha256: sha256(zipBytes),
      }),
    })),
    captureFrozen: vi.fn(async () => undefined),
  };
}

describe('session command', () => {
  it('has the correct name', () => {
    expect(createSessionCommand().name).toBe('session');
  });

  describe('export subcommand — happy path', () => {
    it('exports the active session to the requested VFS path', async () => {
      const zipBytes = Uint8Array.from([1, 2, 3]);
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/session.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result).toEqual({
        stdout: 'exported /workspace/session.zip\n',
        stderr: '',
        exitCode: 0,
      });
      expect(writeFile).toHaveBeenCalledWith('/workspace/session.zip', expect.any(Uint8Array));
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const written = (writeFile.mock.calls[0] as any)[1] as Uint8Array;
      expect(written).toEqual(zipBytes);
    });

    it('uses default output path from service filename when --output is omitted', async () => {
      const zipBytes = Uint8Array.from([4, 5, 6]);
      // makeService returns filename 'bundle.zip', so default output should be /workspace/bundle.zip
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('exported /workspace/bundle.zip\n');
      expect(writeFile).toHaveBeenCalledOnce();
    });

    it('passes a frozen selector when --id is provided', async () => {
      const zipBytes = Uint8Array.from([7, 8, 9]);
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export', '--id', 'abc-session-id', '--output', '/workspace/frozen.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(0);
      expect(service.export).toHaveBeenCalledWith(
        { kind: 'frozen', sessionId: 'abc-session-id' },
        expect.anything()
      );
    });

    it('uses active selector when no --id is given', async () => {
      const zipBytes = Uint8Array.from([10, 11]);
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(service.export).toHaveBeenCalledWith({ kind: 'active' }, expect.anything());
    });
  });

  describe('export subcommand — error cases', () => {
    it('returns exit 1 with session export: prefix on redaction-unavailable', async () => {
      const service = {
        export: vi.fn(async () => {
          throw new TranscriptExportError('redaction-unavailable');
        }),
        captureFrozen: vi.fn(),
      };
      teardown = registerTranscriptExportService(service);

      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile: vi.fn() } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('redaction-unavailable');
    });

    it('returns exit 1 when no service is registered (session-not-found)', async () => {
      // No service registered
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile: vi.fn() } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
    });

    it('returns exit 1 with session export: prefix when write fails', async () => {
      const zipBytes = Uint8Array.from([1, 2, 3]);
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device');
      });
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
    });

    it('returns exit 1 when --output flag is provided without a value', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--output'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('--output');
    });

    it('returns exit 1 when --id flag is provided without a value', async () => {
      const result = await createSessionCommand().execute(['export', '--id'], mockCommandContext());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('--id');
    });

    it('returns exit 1 with usage hint for unknown subcommand', async () => {
      const result = await createSessionCommand().execute(['badcmd'], mockCommandContext());
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
    });

    it('handles abort signal gracefully (transfer-aborted)', async () => {
      const service = {
        export: vi.fn(async () => {
          throw new TranscriptExportError('transfer-aborted');
        }),
        captureFrozen: vi.fn(),
      };
      teardown = registerTranscriptExportService(service);

      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile: vi.fn() } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
    });

    it('verifies byteLength against completion before writing', async () => {
      // Service returns mismatched byteLength to trigger transfer-corrupt
      const zipBytes = Uint8Array.from([1, 2, 3]);
      const service: any = {
        export: vi.fn(async () => ({
          filename: 'bundle.zip',
          chunks: (async function* () {
            yield zipBytes;
          })(),
          completion: Promise.resolve({
            byteLength: 999, // wrong!
            sha256: sha256(zipBytes),
          }),
        })),
        captureFrozen: vi.fn(),
      };
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      // writeFile must NOT have been called with corrupt data
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('rejects transfer with correct length but wrong SHA-256 digest', async () => {
      // Simulate same-length but different content: byteLength matches, sha256 does not
      const zipBytes = Uint8Array.from([1, 2, 3]);
      const wrongDigest = sha256(Uint8Array.from([4, 5, 6])); // different content, same length
      const service: any = {
        export: vi.fn(async () => ({
          filename: 'bundle.zip',
          chunks: (async function* () {
            yield zipBytes;
          })(),
          completion: Promise.resolve({ byteLength: 3, sha256: wrongDigest }),
        })),
        captureFrozen: vi.fn(),
      };
      teardown = registerTranscriptExportService(service);

      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/out.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      // VFS write must NOT be called when digest mismatches
      expect(writeFile).not.toHaveBeenCalled();
    });

    it('returns exit 1 for unknown flag', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--force'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('unknown flag');
      expect(result.stderr).toContain('--force');
    });

    it('returns exit 1 for unexpected positional argument', async () => {
      const result = await createSessionCommand().execute(
        ['export', 'extra-arg'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('unexpected argument');
    });

    it('returns exit 1 for duplicate --id flag', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--id', 'abc', '--id', 'xyz'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('duplicate');
    });

    it('returns exit 1 for duplicate --output flag', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--output', '/a.zip', '--output', '/b.zip'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('duplicate');
    });
  });

  describe('export subcommand — --output path validation (M-4)', () => {
    it('rejects --output path containing NUL byte', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/foo\x00bar.zip'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('NUL');
    });

    it('rejects --output path containing backslash', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/foo\\bar.zip'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('backslash');
    });

    it('rejects --output path containing .. traversal segment', async () => {
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/../secret.zip'],
        mockCommandContext()
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('session export:');
      expect(result.stderr).toContain('..');
    });

    it('accepts a normal absolute VFS path', async () => {
      const zipBytes = Uint8Array.from([1, 2, 3]);
      const service = makeService(zipBytes);
      teardown = registerTranscriptExportService(service);
      const writeFile = vi.fn(async () => undefined);
      const result = await createSessionCommand().execute(
        ['export', '--output', '/workspace/my-export.zip'],
        mockCommandContext({ fs: { writeFile } })
      );
      expect(result.exitCode).toBe(0);
      expect(writeFile).toHaveBeenCalledWith('/workspace/my-export.zip', expect.any(Uint8Array));
    });
  });
});
