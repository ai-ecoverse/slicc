// @vitest-environment jsdom

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

    const bubble = document.createElement('slicc-agent-message');
    bubble.innerHTML = '<div class="body"><p>see bb.jsh</p></div>';
    thread.appendChild(bubble);

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(thread.querySelector('a')).toBeNull();
  });

  it('does not touch the VFS for a message with no file names', async () => {
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

    thread.appendChild(bubbleWith('<p>see foo.md for the result</p>'));
    thread.appendChild(toolRow(['/home/lars/foo.md']));

    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(thread.querySelector('a')).toBeNull();
  });
});
