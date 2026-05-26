// TEMPORARY — Plan C spike. Removed when Plan D's /api/cloud/* handlers ship.
// Do NOT import from here in real route handlers.

import { createSubstrate, type SandboxSubstrate } from '@slicc/cloud-core';

interface SpikeEnv {
  E2B_API_KEY?: string;
  SPIKE_ENABLED?: string;
}

interface PauseRequest {
  sandboxId: string;
}

/**
 * Spike via @slicc/cloud-core's createSubstrate — same code path Plan D's
 * handlers use. If the adapter has Workers-incompatible bits (process.env
 * mutation, missing apiKey on connect/list), this spike surfaces them.
 *
 * Strictly gated by env.SPIKE_ENABLED — production deploys must NOT set this.
 */
export async function handleSpike(request: Request, env: SpikeEnv): Promise<Response> {
  if (env.SPIKE_ENABLED !== '1') {
    return new Response('spike disabled', { status: 404 });
  }
  if (!env.E2B_API_KEY) {
    return new Response('E2B_API_KEY missing', { status: 500 });
  }

  const url = new URL(request.url);
  const op = url.pathname.replace(/^\/spike\//, '');
  const substrate = createSubstrate('e2b', { apiKey: env.E2B_API_KEY });

  try {
    switch (op) {
      case 'create':
        return await runCreate(substrate);
      case 'pause':
        return await runPause(substrate, request);
      case 'resume':
        return await runResume(substrate, request);
      case 'kill':
        return await runKill(substrate, request);
      case 'list':
        return await runList(substrate);
      default:
        return new Response(`unknown spike op: ${op}`, { status: 404 });
    }
  } catch (err) {
    // Surface the error message but never echo env.E2B_API_KEY.
    const msg = err instanceof Error ? err.message : String(err);
    const safe = env.E2B_API_KEY ? msg.split(env.E2B_API_KEY).join('[REDACTED]') : msg;
    return new Response(`spike error: ${safe}`, { status: 500 });
  }
}

async function runCreate(substrate: SandboxSubstrate): Promise<Response> {
  const t0 = Date.now();
  const handle = await substrate.create({
    template: 'slicc',
    autoPauseOnCap: false,
    metadata: { source: 'plan-c-spike' },
    envVars: { ADOBE_IMS_TOKEN: 'spike-fake-token' },
  });
  const createdMs = Date.now() - t0;
  await handle.writeFile('/tmp/spike.txt', 'hello from worker via cloud-core');
  const result = await handle.run('cat /tmp/spike.txt');
  return Response.json({
    sandboxId: handle.sandboxId,
    createdMs,
    fileRoundtripStdout: result.stdout,
    exitCode: result.exitCode,
  });
}

async function runPause(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as PauseRequest;
  const handle = await substrate.connect(sandboxId);
  const t0 = Date.now();
  await handle.pause();
  return Response.json({ ok: true, pausedMs: Date.now() - t0 });
}

async function runResume(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as PauseRequest;
  const t0 = Date.now();
  const handle = await substrate.connect(sandboxId);
  const result = await handle.run('echo resumed');
  return Response.json({
    ok: true,
    resumedMs: Date.now() - t0,
    stdout: result.stdout,
  });
}

async function runKill(substrate: SandboxSubstrate, request: Request): Promise<Response> {
  const { sandboxId } = (await request.json()) as PauseRequest;
  const handle = await substrate.connect(sandboxId);
  await handle.kill();
  return Response.json({ ok: true });
}

async function runList(substrate: SandboxSubstrate): Promise<Response> {
  const items = await substrate.list();
  return Response.json({ count: items.length, items });
}
