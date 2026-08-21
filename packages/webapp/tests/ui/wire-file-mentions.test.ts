// @vitest-environment jsdom
/**
 * Tests for the file-mention wiring's lifecycle.
 *
 * The load-bearing property is containment. This runs partway through
 * `wc-live`'s boot, ahead of the wiring that lazy-mounts tool panels, so a
 * throw here would take the terminal down with it — a convenience feature
 * breaking the shell. Everything below is about that not happening.
 */

import { describe, expect, it, vi } from 'vitest';
import { formatPathHints, TOOL_PATH_HINTS_ATTR } from '../../src/core/tool-call-paths.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import { wireFileMentions } from '../../src/ui/wc/wire-file-mentions.js';

const silentLog = { error: () => {} };

function fakeFs(): LocalVfsClient {
  return {
    readDir: () => Promise.resolve([]),
    readFile: () => Promise.resolve(''),
    stat: () => Promise.reject(new Error('ENOENT')),
  };
}

/** A VFS whose only real file is `existing`, and which indexes nothing. */
function fsWith(existing: string): LocalVfsClient {
  return {
    readDir: () => Promise.resolve([]),
    readFile: () => Promise.resolve(''),
    stat: (path: string) =>
      path === existing
        ? Promise.resolve({ type: 'file' as const, size: 1, mtime: 0, ctime: 0 })
        : Promise.reject(new Error('ENOENT')),
  } as unknown as LocalVfsClient;
}

/** A rendered tool row carrying the paths its call named. */
function toolRow(paths: string[]): HTMLElement {
  const row = document.createElement('slicc-action-row');
  const hints = formatPathHints(paths);
  if (hints) row.setAttribute(TOOL_PATH_HINTS_ATTR, hints);
  return row;
}

function bubbleWith(html: string): HTMLElement {
  const bubble = document.createElement('slicc-agent-message');
  bubble.innerHTML = `<div class="body">${html}</div>`;
  return bubble;
}

describe('wireFileMentions', () => {
  it('returns a teardown for a normal thread', () => {
    const thread = document.createElement('div');
    document.body.appendChild(thread);

    const teardown = wireFileMentions({
      thread,
      openFs: () => Promise.resolve(fakeFs()),
      log: silentLog,
    });

    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
  });

  it('does not throw when the shell has no thread element', () => {
    // A shell variant that renders no thread is not an error — there is simply
    // nothing to linkify — and must not abort the boot sequence.
    const log = { error: vi.fn() };
    const teardown = wireFileMentions({
      thread: undefined as unknown as HTMLElement,
      openFs: () => Promise.resolve(fakeFs()),
      log,
    });

    expect(typeof teardown).toBe('function');
    expect(() => teardown()).not.toThrow();
  });

  it('reports and swallows an unexpected failure instead of propagating it', () => {
    const log = { error: vi.fn() };
    const hostile = document.createElement('div');
    // Force the observer setup to blow up the way a hostile/foreign node would.
    Object.defineProperty(hostile, 'querySelectorAll', {
      value: () => {
        throw new Error('boom');
      },
    });

    const teardown = wireFileMentions({
      thread: hostile,
      openFs: () => Promise.resolve(fakeFs()),
      log,
    });

    expect(typeof teardown).toBe('function');
    expect(log.error).toHaveBeenCalled();
  });

  it('does not reject when the VFS cannot be opened', async () => {
    const thread = document.createElement('div');
    document.body.appendChild(thread);
    const log = { error: vi.fn() };

    wireFileMentions({
      thread,
      openFs: () => Promise.reject(new Error('vfs unavailable')),
      log,
    });

    // A message arriving while the VFS is down must not produce an unhandled
    // rejection; the mention simply stays plain text.
    const bubble = document.createElement('slicc-agent-message');
    bubble.innerHTML = '<div class="body"><p>see bb.jsh</p></div>';
    thread.appendChild(bubble);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thread.querySelector('a')).toBeNull();
  });

  it('does not touch the VFS for a message with no file names', async () => {
    // This is what broke CI: the cone's welcome message renders during boot,
    // the observer fired, and opening the page-side VFS client put filesystem
    // work on the critical path while the kernel worker was still starting and
    // the terminal was trying to lazy-mount. Most messages mention no files, so
    // the cheap regex must gate the expensive open.
    const thread = document.createElement('div');
    document.body.appendChild(thread);
    const openFs = vi.fn(() => Promise.resolve(fakeFs()));

    wireFileMentions({ thread, openFs, log: silentLog });

    const bubble = document.createElement('slicc-agent-message');
    bubble.innerHTML = '<div class="body"><p>Welcome to SLICC</p></div>';
    thread.appendChild(bubble);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openFs).not.toHaveBeenCalled();
  });

  it('does open the VFS once a message actually names a file', async () => {
    const thread = document.createElement('div');
    document.body.appendChild(thread);
    const openFs = vi.fn(() => Promise.resolve(fakeFs()));

    wireFileMentions({ thread, openFs, log: silentLog });

    const bubble = document.createElement('slicc-agent-message');
    bubble.innerHTML = '<div class="body"><p>I rewrote bb.jsh</p></div>';
    thread.appendChild(bubble);

    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(openFs).toHaveBeenCalled();
  });

  it('stops processing after teardown', async () => {
    const thread = document.createElement('div');
    document.body.appendChild(thread);
    const openFs = vi.fn(() => Promise.resolve(fakeFs()));

    const teardown = wireFileMentions({ thread, openFs, log: silentLog });
    teardown();

    const bubble = document.createElement('slicc-agent-message');
    bubble.innerHTML = '<div class="body"><p>see bb.jsh</p></div>';
    thread.appendChild(bubble);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openFs).not.toHaveBeenCalled();
  });

  it('links a bare mention using a path an earlier tool call named', async () => {
    // `echo "test" > /home/lars/foo.md` ran, then the agent wrote "see foo.md".
    // Nothing in the indexed roots is called foo.md, so only the hint can
    // resolve it.
    const thread = document.createElement('div');
    document.body.appendChild(thread);

    wireFileMentions({
      thread,
      openFs: () => Promise.resolve(fsWith('/home/lars/foo.md')),
      log: silentLog,
    });

    thread.appendChild(toolRow(['/home/lars/foo.md']));
    thread.appendChild(bubbleWith('<p>see foo.md for the result</p>'));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(thread.querySelector('a')?.getAttribute('data-path')).toBe('/home/lars/foo.md');
  });

  it('ignores tool calls that had not run yet when the text was written', async () => {
    const thread = document.createElement('div');
    document.body.appendChild(thread);

    wireFileMentions({
      thread,
      openFs: () => Promise.resolve(fsWith('/home/lars/foo.md')),
      log: silentLog,
    });

    // The row FOLLOWS the bubble in the transcript, so its path was not known
    // when the sentence was written.
    thread.appendChild(bubbleWith('<p>see foo.md for the result</p>'));
    thread.appendChild(toolRow(['/home/lars/foo.md']));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(thread.querySelector('a')).toBeNull();
  });
});
