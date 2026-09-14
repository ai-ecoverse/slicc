#!/usr/bin/env node

import { mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import {
  frameFilename,
  parseArgv,
  pickPageTarget,
  resolveOptions,
  urlFilterFromOptions,
} from './slicc-screencast-lib.mjs';
import { assembleVideo } from './slicc-screencast-video.mjs';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');

async function findCdpPort(explicit) {
  if (explicit) return String(explicit);
  for (const port of ['9222', '9223']) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, {
        signal: AbortSignal.timeout(500),
      });
      if (r.ok) return port;
    } catch {}
  }
  throw new Error('Cannot find CDP port. Set --port / SLICC_CDP_PORT or start the dev harness.');
}

function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    let id = 1;
    const pending = new Map();
    const handlers = new Map();

    const flushPending = (err) => {
      for (const { rej } of pending.values()) rej(err);
      pending.clear();
    };
    ws.on('open', () =>
      resolve({
        send: (method, params = {}) =>
          new Promise((res, rej) => {
            const mid = id++;
            pending.set(mid, { res, rej });
            ws.send(JSON.stringify({ id: mid, method, params }));
          }),
        on: (method, fn) => handlers.set(method, fn),
        close: () => ws.close(),
      })
    );

    ws.on('error', (err) => {
      const e = err instanceof Error ? err : new Error(String(err));
      reject(e);
      flushPending(e);
    });
    ws.on('close', () => flushPending(new Error('CDP WebSocket closed')));
    ws.on('message', (data) => {
      const msg = JSON.parse(data);
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);

        if (msg.error)
          rej(new Error(`CDP error: ${msg.error.message ?? JSON.stringify(msg.error)}`));
        else res(msg.result);
      } else if (msg.method && handlers.has(msg.method)) {
        handlers.get(msg.method)(msg.params);
      }
    });
  });
}

async function main() {
  const { flags } = parseArgv(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write('See header comment for usage.\n');
    return;
  }
  const opts = resolveOptions(flags);
  const port = await findCdpPort(opts.port);
  const listRes = await fetch(`http://127.0.0.1:${port}/json`, {
    signal: AbortSignal.timeout(2000),
  });
  if (!listRes.ok) throw new Error(`CDP /json returned HTTP ${listRes.status} on port ${port}`);
  const targets = await listRes.json();
  const filter = urlFilterFromOptions(opts);
  const target = pickPageTarget(targets, filter);
  if (!target) {
    throw new Error(
      filter
        ? `No page target matched --url${filter.isRegex ? '-pattern' : ''} "${filter.value}" on CDP port ${port}`
        : `No page target found on CDP port ${port}`
    );
  }
  console.error(`→ recording ${target.url || target.title} (CDP :${port})`);

  await mkdir(opts.out, { recursive: true });
  const conn = await connect(target.webSocketDebuggerUrl);
  await conn.send('Page.enable');
  await conn.send('Page.bringToFront').catch(() => {});

  let seq = 0;
  let writeChain = Promise.resolve();
  const frames = [];
  conn.on('Page.screencastFrame', (p) => {
    seq += 1;
    const name = frameFilename(seq, opts.format);

    writeChain = writeChain.then(async () => {
      try {
        await writeFile(join(opts.out, name), Buffer.from(p.data, 'base64'));
        frames.push({ seq, name, timestamp: p.metadata?.timestamp ?? null });
      } catch {}
    });
    conn.send('Page.screencastFrameAck', { sessionId: p.sessionId }).catch(() => {});
  });

  await conn.send('Page.startScreencast', {
    format: opts.format,
    quality: opts.quality,
    maxWidth: opts.maxWidth,
    maxHeight: opts.maxHeight,
    everyNthFrame: opts.everyNth,
  });

  let stopping = false;
  let durationTimer = null;
  const stop = async () => {
    if (stopping) return;
    stopping = true;
    if (durationTimer) clearTimeout(durationTimer);
    process.off('SIGINT', stop);
    process.off('SIGTERM', stop);
    await conn.send('Page.stopScreencast').catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await writeChain.catch(() => {});
    const manifest = { target: target.url, format: opts.format, count: frames.length, frames };
    await writeFile(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    let video = null;
    if (opts.video) video = await assembleVideo(opts, frames).catch((e) => `failed: ${e.message}`);
    conn.close();
    console.error(`✔ ${frames.length} frames → ${opts.out}${video ? `\n✔ video: ${video}` : ''}`);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (opts.durationMs) durationTimer = setTimeout(stop, opts.durationMs);
}

main().catch((err) => {
  process.stderr.write(`slicc-screencast: ${err?.stack ?? err}\n`);
  process.exit(1);
});
