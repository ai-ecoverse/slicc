import { describe, expect, it } from 'vitest';
import { createHostCommand, formatFollowerOutput } from './host-command.js';

describe('host command', () => {
  it('has the correct name', () => {
    expect(createHostCommand().name).toBe('host');
  });

  it('shows help with --help', async () => {
    const result = await createHostCommand().execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('display the current tray host status');
  });

  it('prints the leader launch URL, join URL, and tray details', async () => {
    const cmd = createHostCommand({
      getStatus: () => ({
        state: 'leader',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: null,
      }),
      getLocationHref: () => 'http://localhost:3000/?scoop=cone',
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: leader');
    expect(result.stdout).toContain('launch_url: https://tray.example.com/base/tray/tray-123');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-123');
    expect(result.stdout).toContain('worker_base_url: https://tray.example.com/base');
    expect(result.stdout).toContain('tray_id: tray-123');
  });

  it('keeps the local canonical launch URL for non-leader sessions', async () => {
    const result = await createHostCommand({
      getStatus: () => ({
        state: 'error',
        session: {
          workerBaseUrl: 'https://tray.example.com/base',
          trayId: 'tray-123',
          createdAt: '2026-03-12T00:00:00.000Z',
          controllerId: 'controller-1',
          controllerUrl: 'https://tray.example.com/controller/controller-1',
          joinUrl: 'https://tray.example.com/join/tray-123',
          webhookUrl: 'https://tray.example.com/webhooks/tray-123',
          leaderKey: 'leader-key',
          leaderWebSocketUrl: 'wss://tray.example.com/ws',
          runtime: 'slicc-standalone',
        },
        error: 'boom',
      }),
      getLocationHref: () => 'http://localhost:3000/?scoop=cone',
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: error');
    expect(result.stdout).toContain('launch_url: http://localhost:3000/?scoop=cone&tray=https%3A%2F%2Ftray.example.com%2Fbase%2Ftray%2Ftray-123');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-123');
    expect(result.stdout).toContain('error: boom');
  });

  it('prints error details when leader startup failed', async () => {
    const result = await createHostCommand({
      getStatus: () => ({ state: 'error', session: null, error: 'boom' }),
      getLocationHref: () => 'http://localhost:3000/',
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('status: error\nlaunch_url: unavailable\njoin_url: unavailable\nerror: boom\n');
  });

  it('rejects unsupported arguments', async () => {
    const result = await createHostCommand().execute(['nope'], {} as never);
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('host: unsupported arguments\n');
  });

  it('shows follower status when follower is connected', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
        error: null,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connected)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).toContain('tray_id: tray-456');
  });

  it('shows follower connecting status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: null,
        error: null,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id:');
  });

  it('shows follower error status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'error',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: null,
        error: 'WebRTC failed',
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (error)');
    expect(result.stdout).toContain('error: WebRTC failed');
  });

  it('falls back to leader status when follower is inactive', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'inactive',
        joinUrl: null,
        trayId: null,
        error: null,
      }),
      getStatus: () => ({ state: 'inactive', session: null, error: null }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: inactive');
    expect(result.stdout).not.toContain('follower');
  });
});

describe('formatFollowerOutput', () => {
  it('formats connected follower with all fields', () => {
    const output = formatFollowerOutput({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      error: null,
    });
    expect(output).toBe('status: follower (connected)\njoin_url: https://tray.example.com/join/token\ntray_id: tray-789\n');
  });

  it('omits tray_id when null', () => {
    const output = formatFollowerOutput({
      state: 'connecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: null,
      error: null,
    });
    expect(output).not.toContain('tray_id');
  });

  it('includes error when present', () => {
    const output = formatFollowerOutput({
      state: 'error',
      joinUrl: null,
      trayId: null,
      error: 'something broke',
    });
    expect(output).toContain('error: something broke');
  });
});
