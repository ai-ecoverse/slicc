import { afterEach, describe, expect, it, vi } from 'vitest';
import 'fake-indexeddb/auto';
import { MountCommands } from '../../src/fs/mount-commands.js';
import type { VirtualFS } from '../../src/fs/virtual-fs.js';
import {
  popToolExecutionContext,
  pushToolExecutionContext,
  type ToolExecutionContext,
  toolUIRegistry,
} from '../../src/tools/tool-ui.js';

function makeMockMountIndex() {
  return {
    getState: vi.fn(() => undefined),
    isReady: vi.fn(() => false),
  };
}

function makeFs(overrides: Partial<VirtualFS> = {}): VirtualFS {
  return {
    listMounts: vi.fn(() => []),
    unmount: vi.fn(),
    mount: vi.fn(),
    getMountIndex: vi.fn(() => makeMockMountIndex()),
    ...overrides,
  } as unknown as VirtualFS;
}

describe('MountCommands', () => {
  describe('no arguments', () => {
    it('returns exitCode 1', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.exitCode).toBe(1);
    });

    it('includes "mount point required" in stderr', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toContain('mount: mount point required');
    });

    it('includes usage hint in stderr', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toContain('mount point required');
    });

    it('stderr ends with a newline', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute([], '/workspace');
      expect(result.stderr).toMatch(/\n$/);
    });
  });

  describe('list subcommand', () => {
    it('returns exitCode 0 with no mounts', async () => {
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => []) }) });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('No active mounts\n');
    });

    it('lists active mounts', async () => {
      const mounts = ['/workspace/myapp', '/workspace/other'];
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => mounts) }) });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('/workspace/myapp');
      expect(result.stdout).toContain('/workspace/other');
    });

    it('-l alias works', async () => {
      const cmd = new MountCommands({ fs: makeFs({ listMounts: vi.fn(() => []) }) });
      const result = await cmd.execute(['-l'], '/workspace');
      expect(result.exitCode).toBe(0);
    });

    async function runListWithErrorState(
      mountPath: string,
      state: Record<string, unknown>
    ): Promise<string> {
      const mountIndex = {
        getState: vi.fn(() => ({ status: 'error' as const, indexed: 0, ...state })),
        isReady: vi.fn(() => false),
      };
      const cmd = new MountCommands({
        fs: makeFs({
          listMounts: vi.fn(() => [mountPath]),
          getMountIndex: vi.fn(() => mountIndex) as unknown as VirtualFS['getMountIndex'],
        }),
      });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
      return result.stdout;
    }

    it('renders a depth-exceeded index skip with the depth env var hint', async () => {
      const stdout = await runListWithErrorState('/mnt/deep', {
        error: 'mount indexing aborted: directory nesting exceeded 400 levels',
        abortCause: 'depth-exceeded',
      });
      expect(stdout).toContain('/mnt/deep');
      expect(stdout).toContain('index skipped');
      expect(stdout.toLowerCase()).toContain('depth');
      expect(stdout).toContain('SLICC_MOUNT_INDEX_MAX_DEPTH');
      expect(stdout).toContain('mount unmount /mnt/deep');
      expect(stdout.toLowerCase()).not.toContain('cycl');
    });

    it('renders an entries-exceeded index skip as a too-large tree, not a cycle', async () => {
      const stdout = await runListWithErrorState('/mnt/huge', {
        error: 'mount indexing aborted: entry budget of 2000000 exceeded',
        abortCause: 'entries-exceeded',
      });
      expect(stdout).toContain('/mnt/huge');
      expect(stdout).toContain('index skipped');
      expect(stdout.toLowerCase()).toContain('too large');
      expect(stdout).toContain('SLICC_MOUNT_INDEX_MAX_ENTRIES');
      expect(stdout).toContain('mount unmount /mnt/huge');
      expect(stdout.toLowerCase()).not.toContain('cycl');
    });

    it('renders a cycle-detected index skip with an actionable unmount hint', async () => {
      const stdout = await runListWithErrorState('/mnt/cyclic', {
        error: 'mount indexing aborted: self-referential mount cycle detected',
        abortCause: 'cycle-detected',
      });
      expect(stdout).toContain('/mnt/cyclic');
      expect(stdout).toContain('index skipped');
      expect(stdout.toLowerCase()).toContain('cycle');
      expect(stdout).toContain('mount unmount /mnt/cyclic');
    });

    it('renders the raw message for a generic indexing-error', async () => {
      const stdout = await runListWithErrorState('/mnt/broken', {
        error: 'backend unavailable',
        abortCause: 'indexing-error',
      });
      expect(stdout).toContain('index error: backend unavailable');
      expect(stdout).not.toContain('mount unmount');
      expect(stdout).not.toContain('index skipped');
    });
  });

  describe('unmount subcommand', () => {
    it('returns error when path is missing', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['unmount'], '/workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('path required');
    });

    it('calls fs.unmount with absolute path', async () => {
      const unmount = vi.fn();
      const cmd = new MountCommands({ fs: makeFs({ unmount }) });
      const result = await cmd.execute(['unmount', '/workspace/myapp'], '/workspace');
      expect(result.exitCode).toBe(0);
      expect(unmount).toHaveBeenCalledWith('/workspace/myapp');
    });

    it('resolves relative path against cwd', async () => {
      const unmount = vi.fn();
      const cmd = new MountCommands({ fs: makeFs({ unmount }) });
      await cmd.execute(['unmount', 'myapp'], '/workspace');
      expect(unmount).toHaveBeenCalledWith('/workspace/myapp');
    });
  });

  describe('scoop (non-interactive) context', () => {
    it('fails fast with exitCode 1 when invoked from a scoop', async () => {
      const cmd = new MountCommands({ fs: makeFs(), isScoop: () => true });
      const result = await cmd.execute(['/workspace/myapp'], '/workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('cannot mount local directories from a scoop');
    });

    it('does not invoke the directory picker or fs.mount in scoop context', async () => {
      const mount = vi.fn();
      const showDirectoryPicker = vi.fn();
      vi.stubGlobal('window', { showDirectoryPicker });
      try {
        const cmd = new MountCommands({ fs: makeFs({ mount }), isScoop: () => true });
        const result = await cmd.execute(['/workspace/myapp'], '/workspace');
        expect(result.exitCode).toBe(1);
        expect(showDirectoryPicker).not.toHaveBeenCalled();
        expect(mount).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it('still allows list/unmount/refresh subcommands inside a scoop', async () => {
      const cmd = new MountCommands({
        fs: makeFs({ listMounts: vi.fn(() => []) }),
        isScoop: () => true,
      });
      const result = await cmd.execute(['list'], '/workspace');
      expect(result.exitCode).toBe(0);
    });
  });

  describe('cone (interactive) timeout', () => {
    let pushedCtx: ToolExecutionContext | null = null;

    afterEach(() => {
      if (pushedCtx) {
        popToolExecutionContext(pushedCtx);
        pushedCtx = null;
      }
      vi.unstubAllGlobals();
      vi.useRealTimers();
    });

    it('times out after 5 minutes, cancels the pending UI, and exits 1', async () => {
      vi.useFakeTimers();
      // mount only enters the timeout branch when window.showDirectoryPicker
      // exists; never resolved by the test, so the user-action path stays
      // pending and the timeout fires.
      vi.stubGlobal('window', { showDirectoryPicker: vi.fn() });

      const onUpdate = vi.fn();
      pushedCtx = pushToolExecutionContext({
        onUpdate,
        toolName: 'bash',
        toolCallId: 'tc-mount-timeout',
      });

      const cmd = new MountCommands({ fs: makeFs() });
      const pendingBefore = toolUIRegistry.getPendingIds().length;

      const promise = cmd.execute(['/workspace/myapp'], '/workspace');

      // Let the synchronous showToolUI register before advancing timers.
      await Promise.resolve();
      expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore + 1);

      // Simulate the chat panel mounting the dip: without this ack the
      // fast-fail detector (5s) would fire FIRST and the assertion below
      // would see "panel did not render" instead of the 5-minute timeout
      // path we want to cover here.
      const newRequestId = toolUIRegistry.getPendingIds()[pendingBefore];
      toolUIRegistry.markMounted(newRequestId);

      // Trigger the 5-minute timeout deterministically.
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      const result = await promise;

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain('timed out');

      // Registry was cleaned up so a late click cannot re-trigger the
      // picker callback after the command exited.
      expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore);

      // tool_ui_done was emitted via onUpdate so the panel can clear the
      // approval prompt.
      const blocks = onUpdate.mock.calls.flatMap(
        (call) => (call[0]?.content ?? []) as Array<{ type?: string }>
      );
      expect(blocks.some((b) => b.type === 'tool_ui_done')).toBe(true);
    });
  });

  describe('--help', () => {
    it('returns exitCode 0', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['--help'], '/workspace');
      expect(result.exitCode).toBe(0);
    });

    it('shows required <target-path> in usage', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['--help'], '/workspace');
      expect(result.stdout).toContain('Usage: mount [OPTIONS] <target-path>');
    });
  });

  // ---------------------------------------------------------------------------
  // Dispatcher coverage. The dispatcher rewrite added --source /
  // --profile / --no-probe / --max-body-mb / --clear-cache / --bodies and URL
  // scheme dispatch (s3:// / da://); these tests lock down that surface.
  // The cross-check pass found `--clear-cache` was a no-op because no test
  // exercised the end-to-end behavior — the explicit clearMount test below
  // is the regression guard for that bug.
  // ---------------------------------------------------------------------------

  describe('--source URL scheme dispatch', () => {
    it('rejects an unknown scheme with an actionable error', async () => {
      const cmd = new MountCommands({ fs: makeFs() });
      const result = await cmd.execute(['--source', 'unknown://foo', '/mnt/x'], '/workspace');
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/invalid source/);
      expect(result.stderr).toMatch(/s3:\/\/.*da:\/\//);
    });

    it('s3:// surfaces probe failure with the actionable secret-set hint', async () => {
      // Profile resolution moved server-side; the actionable hint surfaces
      // when the probe (or first request) returns the server's
      // ProfileNotConfiguredError. Inject a signedFetch that mimics that
      // server-side response by throwing FsError(EACCES).
      const { FsError } = await import('../../src/fs/types.js');
      const cmd = new MountCommands({
        fs: makeFs(),
        signedFetchS3: async () => {
          throw new FsError(
            'EACCES',
            "profile 'r2' missing required field 'access_key_id'. " +
              'Set it via: secret set s3.r2.access_key_id <value>'
          );
        },
      });
      const result = await cmd.execute(
        ['--source', 's3://my-bucket/prefix', '--profile', 'r2', '/mnt/r2'],
        '/workspace'
      );
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/profile 'r2'/);
      expect(result.stderr).toMatch(/access_key_id/);
      expect(result.stderr).toMatch(/secret set s3\.r2\.access_key_id/);
    });

    it('s3:// with --no-probe constructs an S3 backend and calls fs.mount', async () => {
      const fs = makeFs();
      const cmd = new MountCommands({
        fs,
        signedFetchS3: async () => new Response('', { status: 200 }),
      });
      const result = await cmd.execute(
        ['--source', 's3://my-bucket/prefix', '--no-probe', '/mnt/s3'],
        '/workspace'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('Mounted');
      expect(result.stdout).toContain('(profile: default)');
      const mountFn = fs.mount as ReturnType<typeof vi.fn>;
      expect(mountFn).toHaveBeenCalledTimes(1);
      const [, backend] = mountFn.mock.calls[0] as [string, { kind: string; source: string }];
      expect(backend.kind).toBe('s3');
      expect(backend.source).toBe('s3://my-bucket/prefix');
    });

    it('da:// with --no-probe constructs a DA backend and calls fs.mount', async () => {
      const fs = makeFs();
      const cmd = new MountCommands({
        fs,
        signedFetchDa: async () => new Response('[]', { status: 200 }),
      });
      const result = await cmd.execute(
        ['--source', 'da://my-org/my-repo', '--no-probe', '/mnt/da'],
        '/workspace'
      );
      expect(result.exitCode).toBe(0);
      const mountFn = fs.mount as ReturnType<typeof vi.fn>;
      expect(mountFn).toHaveBeenCalledTimes(1);
      const [, backend] = mountFn.mock.calls[0] as [string, { kind: string; source: string }];
      expect(backend.kind).toBe('da');
      expect(backend.source).toBe('da://my-org/my-repo');
    });

    // Lock-down for the new contract (PR #603): remote mounts mount directly
    // even when called from a cone-style ToolExecutionContext. A regression
    // that re-introduces an Approve/Deny dip would register a `tool_ui`
    // entry on toolUIRegistry and emit a `tool_ui` content block on
    // ctx.onUpdate; both must stay zero for s3:// and da://.
    it('s3:// in cone (tool) context mounts directly without registering a tool_ui', async () => {
      const fs = makeFs();
      const onUpdate = vi.fn();
      const ctx: ToolExecutionContext = pushToolExecutionContext({
        onUpdate,
        toolName: 'bash',
        toolCallId: 'tc-mount-s3-no-consent',
      });
      try {
        const cmd = new MountCommands({
          fs,
          signedFetchS3: async () => new Response('', { status: 200 }),
        });
        const pendingBefore = toolUIRegistry.getPendingIds().length;
        const result = await cmd.execute(
          ['--source', 's3://b/p', '--no-probe', '/mnt/r2'],
          '/workspace'
        );

        expect(result.exitCode).toBe(0);
        expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore);
        const blocks = onUpdate.mock.calls.flatMap(
          (call) => (call[0]?.content ?? []) as Array<{ type?: string }>
        );
        expect(blocks.some((b) => b.type === 'tool_ui')).toBe(false);
        expect(fs.mount as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      } finally {
        popToolExecutionContext(ctx);
      }
    });

    it('da:// in cone (tool) context mounts directly without registering a tool_ui', async () => {
      const fs = makeFs();
      const onUpdate = vi.fn();
      const ctx: ToolExecutionContext = pushToolExecutionContext({
        onUpdate,
        toolName: 'bash',
        toolCallId: 'tc-mount-da-no-consent',
      });
      try {
        const cmd = new MountCommands({
          fs,
          signedFetchDa: async () => new Response('[]', { status: 200 }),
        });
        const pendingBefore = toolUIRegistry.getPendingIds().length;
        const result = await cmd.execute(
          ['--source', 'da://my-org/my-repo', '--no-probe', '/mnt/da'],
          '/workspace'
        );

        expect(result.exitCode).toBe(0);
        expect(toolUIRegistry.getPendingIds().length).toBe(pendingBefore);
        const blocks = onUpdate.mock.calls.flatMap(
          (call) => (call[0]?.content ?? []) as Array<{ type?: string }>
        );
        expect(blocks.some((b) => b.type === 'tool_ui')).toBe(false);
        expect(fs.mount as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
      } finally {
        popToolExecutionContext(ctx);
      }
    });
  });

  describe('mount refresh outputs RefreshReport summary', () => {
    it('renders +/-/~ counts plus unchanged/errors', async () => {
      const fs = makeFs({
        refreshMount: vi.fn(async () => ({
          added: ['a.html', 'b.html'],
          removed: ['old.html'],
          changed: ['index.html'],
          unchanged: 5,
          errors: [],
        })),
      } as Partial<VirtualFS>);
      const cmd = new MountCommands({ fs });
      const result = await cmd.execute(['refresh', '/mnt/s3'], '/workspace');
      expect(result.exitCode).toBe(0);
      // Format: "Refreshed <path>: +<added> -<removed> ~<changed> (<unchanged> unchanged, <errors> errors)"
      expect(result.stdout).toMatch(/Refreshed \/mnt\/s3:\s*\+2\s*-1\s*~1.*5 unchanged.*0 errors/);
    });

    it('threads the just-bash env through to fs.refreshMount', async () => {
      // A `mount refresh` after a new `export SLICC_MOUNT_INDEX_MAX_*` must
      // forward that env so the re-walk picks up the changed bounds.
      const refreshMount = vi.fn(async () => ({
        added: [],
        removed: [],
        changed: [],
        unchanged: 0,
        errors: [],
      }));
      const fs = makeFs({ refreshMount } as Partial<VirtualFS>);
      const cmd = new MountCommands({ fs });
      const env = new Map([['SLICC_MOUNT_INDEX_MAX_ENTRIES', '7']]);

      await cmd.execute(['refresh', '/mnt/s3'], '/workspace', env);

      expect(refreshMount).toHaveBeenCalledTimes(1);
      const [path, opts] = refreshMount.mock.calls[0] as unknown as [string, { env?: unknown }];
      expect(path).toBe('/mnt/s3');
      expect(opts.env).toBe(env);
    });

    it('surfaces refresh errors on stderr', async () => {
      const fs = makeFs({
        refreshMount: vi.fn(async () => ({
          added: [],
          removed: [],
          changed: [],
          unchanged: 0,
          errors: [{ path: 'foo.html', message: 'EIO: 503' }],
        })),
      } as Partial<VirtualFS>);
      const cmd = new MountCommands({ fs });
      const result = await cmd.execute(['refresh', '/mnt/s3'], '/workspace');
      expect(result.exitCode).not.toBe(0);
      expect(result.stderr).toContain('foo.html');
      expect(result.stderr).toContain('EIO: 503');
    });
  });

  describe('mount unmount --clear-cache', () => {
    // This is the regression guard for the cross-check finding: the flag
    // was previously parsed but the cache-clear was a TODO no-op. This
    // test exercises the end-to-end path so any future regression that
    // reverts the wiring will fail loudly.

    it('clears the RemoteMountCache for s3 mounts', async () => {
      // Need real fake-indexeddb here so the cache can persist + clear.
      // Statically typed side-effect import is at the file top in other suites;
      // the dynamic .mjs subpath resolves without types — ignore, side effect only.
      // @ts-expect-error fake-indexeddb/auto has no types for the .mjs subpath
      await import('fake-indexeddb/auto');
      const { RemoteMountCache } = await import('../../src/fs/mount/remote-cache.js');
      const { saveMountEntry } = await import('../../src/fs/mount-table-store.js');

      const mountId = 'unmount-test-' + Math.random().toString(36).slice(2);
      const cacheDbName = 'slicc-mount-cache'; // matches RemoteMountCache default

      // Pre-populate the cache so we can verify it's cleared.
      const cache = new RemoteMountCache({ mountId, ttlMs: 30_000, dbName: cacheDbName });
      await cache.putBody('foo.txt', new Uint8Array([1, 2, 3]), '"e1"');
      expect(await cache.getBody('foo.txt')).not.toBeNull();

      // Pre-populate the mount table so the dispatcher can look up the descriptor.
      await saveMountEntry({
        targetPath: '/mnt/s3-test',
        descriptor: { kind: 's3', mountId, source: 's3://b/p', profile: 'default' },
        createdAt: Date.now(),
      });

      const fs = makeFs();
      const cmd = new MountCommands({ fs });
      const result = await cmd.execute(['unmount', '--clear-cache', '/mnt/s3-test'], '/workspace');

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('cache cleared');
      // Cache entry must actually be gone — verify against a fresh instance.
      const verifier = new RemoteMountCache({ mountId, ttlMs: 30_000, dbName: cacheDbName });
      expect(await verifier.getBody('foo.txt')).toBeNull();
    });

    it('reports "no remote cache to clear" for local mounts', async () => {
      // Statically typed side-effect import is at the file top in other suites;
      // the dynamic .mjs subpath resolves without types — ignore, side effect only.
      // @ts-expect-error fake-indexeddb/auto has no types for the .mjs subpath
      await import('fake-indexeddb/auto');
      const { saveMountEntry } = await import('../../src/fs/mount-table-store.js');
      await saveMountEntry({
        targetPath: '/mnt/local-test',
        descriptor: {
          kind: 'local',
          mountId: 'local-' + Math.random().toString(36).slice(2),
          idbHandleKey: '/mnt/local-test',
        },
        createdAt: Date.now(),
      });

      const fs = makeFs();
      const cmd = new MountCommands({ fs });
      const result = await cmd.execute(
        ['unmount', '--clear-cache', '/mnt/local-test'],
        '/workspace'
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toMatch(/no remote cache to clear/);
    });
  });
});
