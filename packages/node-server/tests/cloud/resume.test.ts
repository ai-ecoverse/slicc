import { describe, expect, it, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { runResume } from '../../src/cloud/resume.js';
import { CloudSessionRegistry } from '../../src/cloud/registry.js';
import { FakeSubstrate } from './fake-substrate.js';

let dir: string;
let registryPath: string;

const oldJoin = JSON.stringify({
  joinUrl: 'https://w/join/old',
  trayId: 'tray-old',
  runtime: 'slicc-hosted-leader',
  sliccVersion: '3.2.2',
  updatedAt: '2026-05-22T00:00:00Z',
});

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'slicc-resume-'));
  registryPath = path.join(dir, 'cloud-sessions.json');
});

describe('slicc --cloud resume', () => {
  it('connects, kicks leader-restart, and returns the refreshed joinUrl', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    await h.pause();
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, (cmd) => {
      if (cmd.includes('leader-restart')) {
        sub.seedFile(
          h.sandboxId,
          '/tmp/slicc-join.json',
          JSON.stringify({
            joinUrl: 'https://w/join/new',
            trayId: 'tray-old',
            runtime: 'slicc-hosted-leader',
            sliccVersion: '3.2.2',
            updatedAt: '2026-05-22T01:00:00Z',
          })
        );
      }
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });

    expect(result.joinUrl).toBe('https://w/join/new');
    expect(result.trayRebuilt).toBe(false);
    const updated = (await reg.list())[0];
    expect(updated.state).toBe('running');
    expect(updated.joinUrl).toBe('https://w/join/new');
    expect(updated.trayId).toBe('tray-old');
    expect(updated.lastJoinUpdatedAt).toBe('2026-05-22T01:00:00Z');
  });

  it('detects tray rebuild when trayId changes', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, () => {
      sub.seedFile(
        h.sandboxId,
        '/tmp/slicc-join.json',
        JSON.stringify({
          joinUrl: 'https://w/join/rebuilt',
          trayId: 'tray-new',
          runtime: 'slicc-hosted-leader',
          sliccVersion: '3.2.2',
          updatedAt: '2026-05-22T01:00:00Z',
        })
      );
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });
    expect(result.joinUrl).toBe('https://w/join/rebuilt');
    expect(result.trayRebuilt).toBe(true);
  });

  it('returns a versionMismatch warning when the running version differs from local', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.0' },
      autoPauseOnCap: true,
    });
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, () => {
      sub.seedFile(
        h.sandboxId,
        '/tmp/slicc-join.json',
        JSON.stringify({
          joinUrl: 'https://w/join/new',
          trayId: 'tray-old',
          runtime: 'slicc-hosted-leader',
          sliccVersion: '3.2.0',
          updatedAt: '2026-05-22T01:00:00Z',
        })
      );
      return { stdout: '200', stderr: '', exitCode: 0 };
    });

    const result = await runResume({
      substrate: sub,
      registryPath,
      query: 'task-1',
      localSliccVersion: '3.2.2',
      pollIntervalMs: 5,
      pollTimeoutMs: 1000,
    });
    expect(result.versionMismatch).toEqual({ running: '3.2.0', local: '3.2.2' });
  });

  it('times out if the kick returns 200 but updatedAt never advances', async () => {
    const sub = new FakeSubstrate();
    const h = await sub.create({
      template: 'slicc',
      envVars: {},
      metadata: { sliccVersion: '3.2.2' },
      autoPauseOnCap: true,
    });
    sub.seedFile(h.sandboxId, '/tmp/slicc-join.json', oldJoin);

    const reg = new CloudSessionRegistry(registryPath);
    await reg.append({
      substrate: 'e2b',
      sandboxId: h.sandboxId,
      name: 'task-1',
      createdAt: '2026-05-22T00:00:00Z',
      joinUrl: 'https://w/join/old',
      lastSeen: '2026-05-22T00:00:00Z',
      state: 'paused',
      trayId: 'tray-old',
      lastJoinUpdatedAt: '2026-05-22T00:00:00Z',
    });

    sub.queueRun(h.sandboxId, () => ({ stdout: '200', stderr: '', exitCode: 0 }));

    await expect(
      runResume({
        substrate: sub,
        registryPath,
        query: 'task-1',
        localSliccVersion: '3.2.2',
        pollIntervalMs: 5,
        pollTimeoutMs: 100,
      })
    ).rejects.toThrow(/cloud-status did not refresh/);
  });
});
