import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { type TLSSocket, connect as tlsConnect } from 'node:tls';
import { expect } from 'vitest';
import { loadTlsEngine, type TlsEngine } from '../../../../src/kernel/wasm-realm/net/tls-engine.js';
import type { LoopbackNet } from '../../../../src/kernel/wasm-realm/socket.js';
import { Client, duplex, text } from './proxy-helpers.js';

export async function tlsTunnel(
  net: LoopbackNet,
  target: string,
  caPem: string,
  opts: {
    servername?: string;
    minVersion?: 'TLSv1.2' | 'TLSv1.3';
    maxVersion?: 'TLSv1.2' | 'TLSv1.3';
    ca?: string;
  } = {}
): Promise<TLSSocket> {
  const c = Client.open(net);
  await c.send(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  const established = await c.incoming.head(1024);
  expect(text(established ?? new Uint8Array())).toBe('HTTP/1.1 200 Connection Established\r\n\r\n');
  const host = target.replace(/:\d+$/, '').replace(/^\[|\]$/g, '');

  const ip = host.includes(':') || /^\d+\.\d+\.\d+\.\d+$/.test(host);
  return new Promise((resolve, reject) => {
    const socket = tlsConnect({
      socket: duplex(c.conn),
      ...(ip && !opts.servername ? { host } : { servername: opts.servername ?? host }),
      ca: opts.ca ?? caPem,
      ALPNProtocols: ['h2', 'http/1.1'],
      minVersion: opts.minVersion,
      maxVersion: opts.maxVersion,
    });
    socket.once('secureConnect', () => resolve(socket));
    socket.once('error', reject);
  });
}

export function exchange(
  socket: TLSSocket,
  request: string,
  done: (s: string) => boolean
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    const check = () => {
      const all = Buffer.concat(chunks);
      if (done(all.toString('latin1'))) {
        socket.off('data', onData);
        resolve(all);
      }
    };
    const onData = (d: Buffer) => {
      chunks.push(d);
      check();
    };
    socket.on('data', onData);
    socket.once('end', () => resolve(Buffer.concat(chunks)));
    socket.once('error', reject);
    socket.write(request);
  });
}

export function nodeTlsEngine(): Promise<TlsEngine> {
  return loadTlsEngine(async () => {
    const { default: create } = await import('@ai-ecoverse/wasm-tls-engine');

    const wasm = resolve('node_modules/@ai-ecoverse/wasm-tls-engine/dist/slicc-tls-engine.wasm');
    return create({ wasmBinary: readFileSync(wasm) });
  });
}
