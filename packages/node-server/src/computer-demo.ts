import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { ComputerDescriptor, ComputerInputEvent } from '@slicc/shared-ts';
import type { Express, Request, Response } from 'express';
import { WebSocketServer } from 'ws';

export const COMPUTER_DEMO_JPEG = Uint8Array.of(
  0xff,
  0xd8,
  0xff,
  0xc0,
  0x00,
  0x0b,
  0x08,
  0x00,
  0x01,
  0x00,
  0x01,
  0x01,
  0x01,
  0x11,
  0x00,
  0xff,
  0xd9
);

export class ComputerDemoState {
  seq = 0;
  readonly events: ComputerInputEvent[] = [];

  descriptor(): ComputerDescriptor {
    return {
      id: 'url:demo',
      kind: 'url',
      title: 'computer-demo',
      size: { width: 1, height: 1 },
      state: 'live',
      capabilities: {
        screenshot: true,
        text: true,
        frames: 'poll',
        keyboard: true,
        mouse: 'absolute',
        scroll: true,
        exec: false,
        inputAllowed: true,
      },
      pid: null,
    };
  }

  screenshot(): { bytes: Uint8Array; mime: string; width: number; height: number; seq: number } {
    this.seq += 1;
    return {
      bytes: COMPUTER_DEMO_JPEG,
      mime: 'image/jpeg',
      width: 1,
      height: 1,
      seq: this.seq,
    };
  }

  text(): string {
    if (this.events.length === 0) return 'demo\n';
    return `${this.events.map((event) => event.type).join('\n')}\n`;
  }

  input(events: ComputerInputEvent[]): void {
    this.events.push(...events);
  }
}

function isInputEvent(value: unknown): value is ComputerInputEvent {
  if (typeof value !== 'object' || value === null) return false;
  if (!('type' in value) || typeof value.type !== 'string') return false;
  return (
    value.type === 'mousemove' ||
    value.type === 'button' ||
    value.type === 'click' ||
    value.type === 'scroll' ||
    value.type === 'drag' ||
    value.type === 'key' ||
    value.type === 'text' ||
    value.type === 'wait'
  );
}

export function registerComputerDemoRoutes(app: Express, state: ComputerDemoState): void {
  app.get('/computer', (_req: Request, res: Response) => {
    res.json(state.descriptor());
  });
  app.get('/computer/screenshot', (_req: Request, res: Response) => {
    const shot = state.screenshot();
    res.set('Content-Type', shot.mime);
    res.set('Cache-Control', 'no-store');
    res.send(Buffer.from(shot.bytes));
  });
  app.get('/computer/text', (_req: Request, res: Response) => {
    res.type('text/plain').send(state.text());
  });
  app.post('/computer/input', (req: Request, res: Response) => {
    if (!Array.isArray(req.body)) {
      res.status(400).json({ error: 'expected ComputerInputEvent[]' });
      return;
    }
    const events: ComputerInputEvent[] = [];
    for (const item of req.body) {
      if (!isInputEvent(item)) {
        res.status(400).json({ error: 'invalid ComputerInputEvent' });
        return;
      }
      events.push(item);
    }
    state.input(events);
    res.json({ ok: true, count: events.length });
  });
}

export function createComputerDemoFrameServer(state: ComputerDemoState): WebSocketServer {
  const wss = new WebSocketServer({ noServer: true });
  wss.on('connection', (ws, request) => {
    const url = new URL(request.url ?? '/', 'http://computer-demo.local');
    const fps = Math.min(8, Math.max(1, Number(url.searchParams.get('fps')) || 4));
    const tick = (): void => {
      if (ws.readyState !== ws.OPEN) return;
      const shot = state.screenshot();
      ws.send(shot.bytes);
    };
    tick();
    const timer = setInterval(tick, Math.round(1000 / fps));
    ws.on('close', () => clearInterval(timer));
  });
  return wss;
}

export function handleComputerDemoUpgrade(
  pathname: string,
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer
): boolean {
  if (pathname !== '/computer/frames') return false;
  wss.handleUpgrade(request, socket, head, (ws) => {
    wss.emit('connection', ws, request);
  });
  return true;
}
