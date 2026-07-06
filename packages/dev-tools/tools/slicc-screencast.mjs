#!/usr/bin/env node
/**
 * slicc-screencast.mjs — record a CDP screencast of a running SLICC UI.
 *
 * Connects to a Chrome remote-debugging port (the dev harness's Chrome on
 * :9222), attaches to the leader UI page target, and streams
 * `Page.startScreencast` frames to disk as individual JPEG/PNG files plus a
 * `manifest.json`. Drive the UI however you like (slicc-debug chat/shell,
 * playwright-cli, or by hand) while it records, then stop it. Review the
 * frames directly, or pass `--video` to assemble a webm (best-effort; needs
 * ffmpeg on PATH or Playwright's bundled ffmpeg).
 *
 * Usage:
 *   node packages/dev-tools/tools/slicc-screencast.mjs [options]
 *
 * Options (see slicc-screencast-lib.mjs for defaults):
 *   --out <dir>          Frame output directory
 *   --port <n>           Chrome CDP port (default: SLICC_CDP_PORT, else 9222/9223)
 *   --url <substr>       Pick page target whose URL contains <substr>
 *   --url-pattern <re>   …whose URL matches this regex
 *                        (an explicit filter that matches nothing is an error;
 *                         with no filter, prefer the SLICC leader origin
 *                         localhost:8787 / :57xx, else the first http page)
 *   --duration <sec>     Record N seconds then stop (default: until SIGINT)
 *   --format jpeg|png    Frame image format (default: jpeg)
 *   --quality <0-100>    JPEG quality (default: 80)
 *   --max-width <px>     Max frame width  (default: 1280)
 *   --max-height <px>    Max frame height (default: 800)
 *   --every-nth <n>      Capture every Nth frame (default: 1)
 *   --video              Assemble frames into <out>/screencast.webm (best-effort;
 *                        mp4/gif only on a full ffmpeg build)
 *   --fps <n>            Assembly frame rate (default: 10)
 *
 * Environment:
 *   SLICC_CDP_PORT   Override CDP port
 *   SLICC_TARGET_URL Default page-target URL substring
 */

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
    // Reject every in-flight send() so a WebSocket close/error can't leave a
    // caller (or the shutdown path) awaiting a response that never arrives.
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
    // Before `open` this rejects connect(); after, connect() has resolved so
    // the reject is a no-op and only the pending-send flush matters.
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
        // Chrome reports protocol failures as `{error}`; reject so a failed
        // Page.enable / Page.startScreencast can't look like success.
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
    // Serialize frame writes and keep the tail promise so stop() can await the
    // last write before writing the manifest — otherwise the final frame can be
    // truncated when the process exits mid-write. A single failed write drops
    // that frame without breaking the chain.
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

  const stop = async () => {
    await conn.send('Page.stopScreencast').catch(() => {});
    await new Promise((r) => setTimeout(r, 150));
    await writeChain.catch(() => {});
    const manifest = { target: target.url, format: opts.format, count: frames.length, frames };
    await writeFile(join(opts.out, 'manifest.json'), JSON.stringify(manifest, null, 2));
    let video = null;
    if (opts.video) video = await assembleVideo(opts, frames).catch((e) => `failed: ${e.message}`);
    conn.close();
    console.error(`✔ ${frames.length} frames → ${opts.out}${video ? `\n✔ video: ${video}` : ''}`);
    process.exit(0);
  };

  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  if (opts.durationMs) setTimeout(stop, opts.durationMs);
}

main().catch((err) => {
  process.stderr.write(`slicc-screencast: ${err?.stack ?? err}\n`);
  process.exit(1);
});
