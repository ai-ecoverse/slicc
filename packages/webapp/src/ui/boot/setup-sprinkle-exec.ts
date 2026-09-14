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
