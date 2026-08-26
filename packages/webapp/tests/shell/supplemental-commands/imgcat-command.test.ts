import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createImgcatCommand,
  type MediaPreviewItem,
} from '../../../src/shell/supplemental-commands/imgcat-command.js';
import { mockCommandContext } from '../helpers/mock-command-context.js';

const fsStat = (isFile: boolean) => ({
  isFile,
  isDirectory: !isFile,
  isSymbolicLink: false,
  mode: 0o644,
  size: 3,
  mtime: new Date(0),
});

const createMockCtx = (
  overrides: { isFile?: boolean; readFileBuffer?: (path: string) => Promise<Uint8Array> } = {}
) =>
  mockCommandContext({
    fs: {
      stat: () => Promise.resolve(fsStat(overrides.isFile ?? true)),
      readFileBuffer:
        overrides.readFileBuffer ?? (() => Promise.resolve(new Uint8Array([1, 2, 3]))),
    },
  });

describe('imgcat command', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('has correct name', () => {
    const cmd = createImgcatCommand();
    expect(cmd.name).toBe('imgcat');
  });

  it('shows help with --help', async () => {
    const cmd = createImgcatCommand();
    const result = await cmd.execute(['--help'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('imgcat - preview image and video files');
    expect(result.stderr).toBe('');
  });

  it('shows help with -h and when no args provided', async () => {
    const cmd = createImgcatCommand();
    for (const args of [['-h'], [] as string[]]) {
      const result = await cmd.execute(args, createMockCtx());
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Usage: imgcat');
    }
  });

  it('errors when browser APIs are unavailable', async () => {
    vi.stubGlobal('window', undefined);
    vi.stubGlobal('document', undefined);

    const cmd = createImgcatCommand({ onMediaPreview: vi.fn() });
    const result = await cmd.execute(['/img.png'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('browser APIs are unavailable');
  });

  it('errors when no preview handler is wired', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const cmd = createImgcatCommand();
    const result = await cmd.execute(['/img.png'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('terminal preview is unavailable');
  });

  it('errors when target is not a file', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const cmd = createImgcatCommand({ onMediaPreview: vi.fn() });
    const result = await cmd.execute(['/dir'], createMockCtx({ isFile: false }));

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('imgcat: not a file: /dir\n');
  });

  it('rejects non-previewable media types (via base mime-type helpers)', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const cmd = createImgcatCommand({ onMediaPreview: vi.fn() });
    const result = await cmd.execute(['/notes.txt'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('imgcat: unsupported media type: /notes.txt\n');
  });

  it('forwards previewable image and video items to the handler', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const captured: MediaPreviewItem[] = [];
    const onMediaPreview = vi.fn(async (items: MediaPreviewItem[]) => {
      captured.push(...items);
    });

    const cmd = createImgcatCommand({ onMediaPreview });
    const result = await cmd.execute(['/pic.png', '/clip.mp4'], createMockCtx());

    expect(result.exitCode).toBe(0);
    expect(result.stderr).toBe('');
    expect(onMediaPreview).toHaveBeenCalledTimes(1);
    expect(captured.map((i) => i.mimeType)).toEqual(['image/png', 'video/mp4']);
    expect(captured.map((i) => i.path)).toEqual(['/pic.png', '/clip.mp4']);
    expect(captured[0].bytes).toBeInstanceOf(Uint8Array);
  });

  it('surfaces a handler failure as a non-zero exit', async () => {
    vi.stubGlobal('window', {});
    vi.stubGlobal('document', {});

    const cmd = createImgcatCommand({
      onMediaPreview: () => Promise.reject(new Error('preview tab closed')),
    });
    const result = await cmd.execute(['/pic.png'], createMockCtx());

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('imgcat: preview tab closed\n');
  });
});
