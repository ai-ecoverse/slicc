import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { type WebSocket, WebSocketServer } from 'ws';

export interface SiteHandle {
  url: string;
  server: Server;
  close: () => void;
  hits: Map<string, number>;
}

const TRANSPARENT_GIF = 'R0lGODlhAQABAAAAACwAAAAAAQABAAA=';

function reloaderHtml(u: URL): string {
  const every = Number(u.searchParams.get('every') ?? 300);
  return (
    `<!doctype html><title>reloader</title><h1>reloader</h1>` +
    `<script>setTimeout(()=>location.reload(), ${every})</script>`
  );
}

function leaderHtml(u: URL): string {
  const every = Number(u.searchParams.get('every') ?? 50);
  const burst = Number(u.searchParams.get('burst') ?? 2);
  const goto = u.searchParams.get('goto');
  const after = Number(u.searchParams.get('after') ?? 500);
  const leave = goto ? `setTimeout(()=>{location.href=${JSON.stringify(goto)}},${after});` : '';
  return (
    `<!doctype html><title>slicc-leader</title><h1>leader</h1><script>` +
    `const ws=new WebSocket(location.origin.replace(/^http/,'ws')+'/ws');` +
    `ws.onopen=()=>setInterval(()=>{` +
    `for(let i=0;i<${burst};i++)ws.send('{"id":'+i+',"method":"Runtime.evaluate"}')` +
    `},${every});${leave}</script>`
  );
}

function consoleHtml(u: URL): string {
  const n = Number(u.searchParams.get('n') ?? 3);
  return (
    `<!doctype html><title>console</title><script>` +
    `for(let i=0;i<${n};i++)console.log('line-'+i);` +
    `setInterval(()=>console.log('tick'),200)</script>`
  );
}

function contentPageHtml(u: URL): string {
  const name = u.pathname.slice('/page/'.length);
  const items = Number(u.searchParams.get('items') ?? 50);
  const body = Array.from(
    { length: items },
    (_, i) => `<li><a href="#${i}">${name} item ${i}</a> <button>b${i}</button></li>`
  ).join('');
  const sub = Number(u.searchParams.get('subdelay') ?? 0);
  const img = sub > 0 ? `<img src="/slow-asset?delay=${sub}&r=${Math.random()}">` : '';
  return (
    `<!doctype html><html><head><title>${name}</title></head><body>${img}` +
    `<h1 id="h">${name}</h1><input id="q" placeholder="search"><ul>${body}</ul>` +
    `<div id="marker">${name}</div></body></html>`
  );
}

const HTML_ROUTES = new Map<string, (u: URL) => string>([
  ['/reloader', reloaderHtml],
  ['/leader', leaderHtml],
  ['/console', consoleHtml],
]);

export async function startSite(): Promise<SiteHandle> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
    const delay = Number(u.searchParams.get('delay') ?? 0);

    const link = u.searchParams.get('link');
    const send = (html: string) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        ...(link ? { link } : {}),
      });
      res.end(html);
    };
    if (u.pathname === '/hang') return;
    if (u.pathname === '/slow-asset') {
      const timer = setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from(TRANSPARENT_GIF, 'base64'));
      }, delay);
      timer.unref?.();
      return;
    }
    const html = HTML_ROUTES.get(u.pathname);
    if (html) {
      send(html(u));
      return;
    }
    if (u.pathname.startsWith('/page/')) {
      const page = contentPageHtml(u);
      if (delay > 0) setTimeout(() => send(page), delay);
      else send(page);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  const wss = new WebSocketServer({ server, path: '/ws' });
  const sockets = new Set<WebSocket>();
  wss.on('connection', (ws) => {
    sockets.add(ws);
    ws.on('message', (data) => ws.send(data.toString()));
    ws.on('close', () => sockets.delete(ws));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    server,
    close: () => {
      for (const ws of sockets) ws.terminate();
      wss.close();

      server.closeAllConnections();
      server.close();
    },
    hits,
  };
}
