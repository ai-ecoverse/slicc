import { WebAccess } from '@zenfs/dom';
import { afterEach, describe, expect, it } from 'vitest';
import { createMutableDirectoryHandle } from './fsa-test-helpers.js';

interface CallSiteLike {
  isAsync(): boolean;
  getFunctionName(): string | null;
  getFileName(): string | null;
  getLineNumber(): number | null;
  getColumnNumber(): number | null;
}

type PrepareStackTrace = (error: Error, frames: CallSiteLike[]) => string;
const ErrorWithPrepare = Error as unknown as { prepareStackTrace?: PrepareStackTrace };
const v8Format = ErrorWithPrepare.prepareStackTrace;

function useJavaScriptCoreStacks(): void {
  ErrorWithPrepare.prepareStackTrace = (_error, frames) =>
    frames
      .map((frame) => {
        const raw = frame.getFunctionName() ?? '';
        const name = raw.startsWith('<') ? '' : raw;
        return `${frame.isAsync() ? 'async ' : ''}${name}@${frame.getFileName()}:${frame.getLineNumber()}:${frame.getColumnNumber()}`;
      })
      .join('\n');
}

function useFirefoxReleaseStacks(): void {
  ErrorWithPrepare.prepareStackTrace = (_error, frames) => {
    const sync = frames.slice(
      0,
      Math.max(
        1,
        frames.findIndex((frame) => frame.isAsync())
      )
    );
    return sync
      .map(
        (frame) =>
          `${frame.getFunctionName() ?? ''}@${frame.getFileName()}:${frame.getLineNumber()}:${frame.getColumnNumber()}`
      )
      .join('\n');
  };
}

function useNoStacks(): void {
  ErrorWithPrepare.prepareStackTrace = () => '';
}

function useV8Stacks(): void {
  ErrorWithPrepare.prepareStackTrace = undefined;
}

afterEach(() => {
  ErrorWithPrepare.prepareStackTrace = v8Format;
});

async function makeBackend() {
  const backend = await WebAccess.create({
    handle: createMutableDirectoryHandle({ seed: 'data' }).handle,
  });
  await backend.ready();
  return backend;
}

const text = (s: string) => new TextEncoder().encode(s);
const mode = { mode: 0o100644, uid: 0, gid: 0 };

async function readBoth(
  backend: Awaited<ReturnType<typeof makeBackend>>,
  path: string,
  size: number
) {
  const async = new Uint8Array(size);
  await backend.read(path, async, 0, size);
  const sync = new Uint8Array(size);
  backend.readSync(path, sync, 0, size);
  return [new TextDecoder().decode(async), new TextDecoder().decode(sync)];
}

describe.each([
  ['JavaScriptCore', useJavaScriptCoreStacks],
  ['V8', useV8Stacks],
  ['release-Firefox (no async frames)', useFirefoxReleaseStacks],
  ['no', useNoStacks],
])('ZenFS Async mirror with %s stack traces', (_engine, useStacks) => {
  it('renames a file, in the backend and in the sync mirror', async () => {
    useStacks();
    const backend = await makeBackend();
    await backend.createFile('/config.lock', mode);
    await backend.write('/config.lock', text('[core]'), 0);

    await backend.rename('/config.lock', '/config');

    expect(await readBoth(backend, '/config', 6)).toEqual(['[core]', '[core]']);
    expect(() => backend.statSync('/config.lock')).toThrow(/no such file/);
    await expect(backend.stat('/config.lock')).rejects.toThrow();
  });

  it('renames a file onto an existing one', async () => {
    useStacks();
    const backend = await makeBackend();
    await backend.createFile('/index', mode);
    await backend.write('/index', text('old'), 0);
    await backend.createFile('/index.lock', mode);
    await backend.write('/index.lock', text('new'), 0);

    await backend.rename('/index.lock', '/index');

    expect(await readBoth(backend, '/index', 3)).toEqual(['new', 'new']);
  });

  it('renames a directory with a file in it', async () => {
    useStacks();
    const backend = await makeBackend();
    await backend.mkdir('/d', { mode: 0o40755, uid: 0, gid: 0 });
    await backend.createFile('/d/f', mode);
    await backend.write('/d/f', text('z'), 0);

    await backend.rename('/d', '/e');

    expect(await readBoth(backend, '/e/f', 1)).toEqual(['z', 'z']);
    expect(() => backend.statSync('/d')).toThrow(/no such file/);
  });

  it('mirrors a sync rename once, when the queued async rename replays it', async () => {
    useStacks();
    const backend = await makeBackend();
    const mirror = (backend as unknown as { _sync: { renameSync: (...args: unknown[]) => void } })
      ._sync;
    const renameSync = mirror.renameSync.bind(mirror);
    const mirrored: unknown[][] = [];
    mirror.renameSync = (...args) => {
      mirrored.push(args);
      renameSync(...args);
    };
    backend.createFileSync('/a', mode);
    backend.writeSync('/a', text('sync'), 0);
    backend.renameSync('/a', '/b');

    await expect(
      (backend as unknown as { _promise: Promise<unknown> })._promise
    ).resolves.not.toThrow();
    await backend.sync();

    expect(mirrored).toEqual([['/a', '/b']]);
    expect(await readBoth(backend, '/b', 4)).toEqual(['sync', 'sync']);
    expect(() => backend.statSync('/a')).toThrow(/no such file/);
  });

  it('throws a top-level mirror failure even while another mirrored call is in flight', async () => {
    useStacks();
    const backend = await makeBackend();
    await backend.createFile('/a.lock', mode);
    await backend.write('/a.lock', text('a'), 0);
    await backend.createFile('/other', mode);
    const mirror = (backend as unknown as { _sync: { writeSync: (...args: unknown[]) => void } })
      ._sync;
    const writeSync = mirror.writeSync.bind(mirror);
    mirror.writeSync = (...args) => {
      if (args[0] === '/other') throw new Error('mirror rejected the write');
      writeSync(...args);
    };
    try {
      const rename = backend.rename('/a.lock', '/a');
      const write = backend.write('/other', text('x'), 0);
      await expect(write).rejects.toThrow(/Out of sync/);
      await expect(rename).resolves.toBeUndefined();
    } finally {
      mirror.writeSync = writeSync;
    }
    expect(await readBoth(backend, '/a', 1)).toEqual(['a', 'a']);
  });

  it('throws a mirror failure that no outer call will repair (out of sync)', async () => {
    useStacks();
    const backend = await makeBackend();
    await backend.createFile('/f', mode);
    const mirror = (backend as unknown as { _sync: { writeSync: (...args: unknown[]) => void } })
      ._sync;
    const writeSync = mirror.writeSync.bind(mirror);
    mirror.writeSync = () => {
      throw new Error('mirror rejected the write');
    };
    try {
      await expect(backend.write('/f', text('x'), 0)).rejects.toThrow(/Out of sync/);
    } finally {
      mirror.writeSync = writeSync;
    }
  });
});
