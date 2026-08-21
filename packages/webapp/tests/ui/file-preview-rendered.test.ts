// @vitest-environment jsdom
/**
 * Tests for the rendered half of a file preview.
 *
 * Markdown and HTML are the two types with a second form worth showing, and the
 * split between them is a security boundary, not a styling choice: markdown is
 * converted here (through the transcript's sanitizing renderer) and mounted
 * inline, while HTML is never sanitized and must only ever reach a sandboxed
 * iframe.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';

interface OpenedPreview {
  path: string;
  mimeType: string;
  rendered?: { mount: 'inline' | 'sandbox'; html: string };
}

const opened: OpenedPreview[] = [];

vi.mock('@slicc/webcomponents', () => ({
  SliccOverflowMenu: { show: () => {} },
  SliccQuickLook: {
    open: (opts: OpenedPreview) => {
      opened.push(opts);
    },
    close: () => {},
  },
}));

const { openFilePreview } = await import('../../src/ui/wc/file-actions.js');

/** A VFS serving one file's bytes and admitting to no git repository. */
function fsWith(contents: string): LocalVfsClient {
  return {
    readDir: () => Promise.resolve([]),
    readFile: () => Promise.resolve(new TextEncoder().encode(contents)),
    stat: () => Promise.reject(new Error('ENOENT')),
  } as unknown as LocalVfsClient;
}

describe('openFilePreview rendered views', () => {
  beforeEach(() => {
    opened.length = 0;
  });

  it('renders markdown inline, through the sanitizing transcript renderer', async () => {
    await openFilePreview(fsWith('# Title\n\nSome *prose*.\n'), '/workspace/report.md');

    const rendered = opened[0]?.rendered;
    expect(rendered?.mount).toBe('inline');
    expect(rendered?.html).toContain('<h1');
    expect(rendered?.html).toContain('<em>prose</em>');
  });

  it('strips script out of markdown before it can be mounted inline', async () => {
    await openFilePreview(
      fsWith('Hello\n\n<script>alert(1)</script>\n'),
      '/workspace/notes.markdown'
    );

    expect(opened[0]?.rendered?.html).not.toContain('<script');
  });

  it('hands raw HTML to the sandbox, unconverted', async () => {
    const source = '<h1>Report</h1><script>alert(1)</script>';
    await openFilePreview(fsWith(source), '/workspace/report.html');

    expect(opened[0]?.rendered).toEqual({ mount: 'sandbox', html: source });
  });

  it('offers no rendered view for an ordinary source file', async () => {
    await openFilePreview(fsWith('const a = 1;\n'), '/workspace/app.ts');
    expect(opened[0]?.rendered).toBeUndefined();
  });

  it('skips the rendered view for a document too large to convert on the main thread', async () => {
    const huge = `# Big\n\n${'word '.repeat(200_000)}`;
    await openFilePreview(fsWith(huge), '/workspace/huge.md');

    // Still previews — just as source.
    expect(opened[0]?.path).toBe('/workspace/huge.md');
    expect(opened[0]?.rendered).toBeUndefined();
  });
});
