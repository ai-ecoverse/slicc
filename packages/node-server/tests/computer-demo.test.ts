import express from 'express';
import { describe, expect, it } from 'vitest';
import {
  COMPUTER_DEMO_JPEG,
  ComputerDemoState,
  createComputerDemoFrameServer,
  handleComputerDemoUpgrade,
  registerComputerDemoRoutes,
} from '../src/computer-demo.js';

function makeApp(state = new ComputerDemoState()) {
  const app = express();
  app.use(express.json());
  registerComputerDemoRoutes(app, state);
  return { app, state };
}

async function withServer<T>(
  app: express.Express,
  fn: (base: string, port: number) => Promise<T>
): Promise<T> {
  const server = app.listen(0);
  try {
    const addr = server.address();
    if (typeof addr !== 'object' || addr === null) throw new Error('no address');
    return await fn(`http://127.0.0.1:${addr.port}`, addr.port);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe('computer-demo HTTP contract', () => {
  it('serves GET /computer, screenshot, text, and POST /input', async () => {
    const { app, state } = makeApp();
    await withServer(app, async (base) => {
      const desc = (await (await fetch(`${base}/computer`)).json()) as {
        kind: string;
        title: string;
      };
      expect(desc.kind).toBe('url');
      expect(desc.title).toBe('computer-demo');
      const shot = await fetch(`${base}/computer/screenshot?maxWidth=256&format=jpeg`);
      expect(shot.status).toBe(200);
      expect(shot.headers.get('content-type')).toBe('image/jpeg');
      const bytes = new Uint8Array(await shot.arrayBuffer());
      expect([...bytes]).toEqual([...COMPUTER_DEMO_JPEG]);
      expect(await (await fetch(`${base}/computer/text`)).text()).toBe('demo\n');
      const posted = await fetch(`${base}/computer/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify([{ type: 'text', text: 'hi' }]),
      });
      expect(posted.status).toBe(200);
      expect(state.events).toEqual([{ type: 'text', text: 'hi' }]);
      expect(await (await fetch(`${base}/computer/text`)).text()).toBe('text\n');
    });
  });

  it('rejects a non-array input body', async () => {
    const { app } = makeApp();
    await withServer(app, async (base) => {
      const res = await fetch(`${base}/computer/input`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'text', text: 'nope' }),
      });
      expect(res.status).toBe(400);
    });
  });
});

describe('computer-demo WS frames', () => {
  it('pushes JPEG frames on /computer/frames', async () => {
    const { app, state } = makeApp();
    const server = app.listen(0);
    const wss = createComputerDemoFrameServer(state);
    server.on('upgrade', (request, socket, head) => {
      const { pathname } = new URL(request.url ?? '/', `http://${request.headers.host}`);
      if (!handleComputerDemoUpgrade(pathname, request, socket, head, wss)) {
        socket.destroy();
      }
    });
    try {
      const addr = server.address();
      if (typeof addr !== 'object' || addr === null) throw new Error('no address');
      const ws = new WebSocket(`ws://127.0.0.1:${addr.port}/computer/frames?fps=8`);
      const frame = await new Promise<Uint8Array>((resolve, reject) => {
        ws.binaryType = 'arraybuffer';
        ws.addEventListener('message', (event) => {
          if (event.data instanceof ArrayBuffer) resolve(new Uint8Array(event.data));
        });
        ws.addEventListener('error', () => reject(new Error('ws error')));
      });
      expect([...frame]).toEqual([...COMPUTER_DEMO_JPEG]);
      expect(
        handleComputerDemoUpgrade('/cdp', {} as never, {} as never, Buffer.alloc(0), wss)
      ).toBe(false);
      ws.close();
    } finally {
      wss.close();
      server.closeAllConnections?.();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
