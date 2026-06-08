/**
 * `setup-sprinkle-exec.ts` — shared sprinkle `slicc.exec()` handler
 * factory used by both `mainExtension` and `mainStandaloneWorker`.
 *
 * Routes through the `OffscreenClient` transport (kernel-worker
 * `MessageChannel` / extension `chrome.runtime`), so the same factory
 * drives both floats.
 *
 * The `TerminalSessionClient` is opened lazily on the first `exec` and
 * reused. Calls are serialized through a per-session promise queue: the
 * worker `TerminalSessionHost.handleExec` only permits one in-flight
 * exec per session (a concurrent second call exits 130).
 */

import type { OffscreenClient } from '../offscreen-client.js';
import type { SprinkleExecHandler } from '../sprinkle-bridge.js';

export function createSprinkleExecHandler(client: OffscreenClient): SprinkleExecHandler {
  let sessionPromise: ReturnType<typeof openSession> | null = null;
  let execChain: Promise<unknown> = Promise.resolve();
  const openSession = async () => {
    const { TerminalSessionClient } = await import('../../kernel/terminal-session-client.js');
    const session = new TerminalSessionClient({
      client,
      sid: `sprinkle-exec-${Date.now()}`,
    });
    await session.open({ cwd: '/' });
    return session;
  };
  const ensureSession = (): ReturnType<typeof openSession> => {
    if (!sessionPromise) {
      sessionPromise = openSession().catch((err) => {
        sessionPromise = null;
        throw err;
      });
    }
    return sessionPromise;
  };
  return async (cmd: string) => {
    const run = execChain.then(
      () => ensureSession().then((session) => session.exec(cmd)),
      () => ensureSession().then((session) => session.exec(cmd))
    );
    execChain = run.catch(() => undefined);
    return run;
  };
}
