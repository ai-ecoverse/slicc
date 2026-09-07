/**
 * Local HTTP test site with controllable behaviour:
 *   /page/<name>?delay=<ms>&items=<n>&subdelay=<ms>  — title "<name>", n list
 *                                                      items; `subdelay` adds a
 *                                                      slow <img> so `load`
 *                                                      fires long after commit
 *   /reloader?every=<ms>  — page that reloads itself every <ms>
 *   /hang                 — never responds (navigation never fires load)
 *   /console?n=<k>        — page that logs k console lines then keeps logging
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface SiteHandle {
  url: string;
  server: Server;
  close: () => void;
  hits: Map<string, number>;
}

const TRANSPARENT_GIF = 'R0lGODlhAQABAAAAACwAAAAAAQABAAA=';

export async function startSite(): Promise<SiteHandle> {
  const hits = new Map<string, number>();
  const server = createServer((req, res) => {
    const u = new URL(req.url ?? '/', 'http://x');
    hits.set(u.pathname, (hits.get(u.pathname) ?? 0) + 1);
    const delay = Number(u.searchParams.get('delay') ?? 0);
    const send = (html: string) => {
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
      });
      res.end(html);
    };
    if (u.pathname === '/hang') return; // never respond
    if (u.pathname === '/slow-asset') {
      setTimeout(() => {
        res.writeHead(200, { 'content-type': 'image/gif' });
        res.end(Buffer.from(TRANSPARENT_GIF, 'base64'));
      }, delay);
      return;
    }
    if (u.pathname === '/reloader') {
      const every = Number(u.searchParams.get('every') ?? 300);
      send(
        `<!doctype html><title>reloader</title><h1>reloader</h1>` +
          `<script>setTimeout(()=>location.reload(), ${every})</script>`
      );
      return;
    }
    if (u.pathname === '/console') {
      const n = Number(u.searchParams.get('n') ?? 3);
      send(
        `<!doctype html><title>console</title><script>` +
          `for(let i=0;i<${n};i++)console.log('line-'+i);` +
          `setInterval(()=>console.log('tick'),200)</script>`
      );
      return;
    }
    if (u.pathname.startsWith('/page/')) {
      const name = u.pathname.slice('/page/'.length);
      const items = Number(u.searchParams.get('items') ?? 50);
      const body = Array.from(
        { length: items },
        (_, i) => `<li><a href="#${i}">${name} item ${i}</a> <button>b${i}</button></li>`
      ).join('');
      const sub = Number(u.searchParams.get('subdelay') ?? 0);
      const img = sub > 0 ? `<img src="/slow-asset?delay=${sub}&r=${Math.random()}">` : '';
      const html =
        `<!doctype html><html><head><title>${name}</title></head><body>${img}` +
        `<h1 id="h">${name}</h1><input id="q" placeholder="search"><ul>${body}</ul>` +
        `<div id="marker">${name}</div></body></html>`;
      if (delay > 0) setTimeout(() => send(html), delay);
      else send(html);
      return;
    }
    res.writeHead(404);
    res.end('nope');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${port}`, server, close: () => server.close(), hits };
}
