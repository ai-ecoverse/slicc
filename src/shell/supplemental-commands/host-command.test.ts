import { describe, expect, it } from 'vitest';
import { createHostCommand, formatFollowerOutput, formatLeaderOutput } from './host-command.js';

describe('host command', () => {
  it('has the correct name', () => {
    expect(createHostCommand().name).toBe('host');
  });

  it('shows help with --help', async () => {
    const result = await createHostCommand().execute(['--help'], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('display the current tray host status');
  });

  it('prints the leader status and join URL', async () => {
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
      getFollowers: () => [],
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: leader');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/tray-123');
    expect(result.stdout).not.toContain('launch_url');
    expect(result.stdout).not.toContain('webhook_url');
    expect(result.stdout).not.toContain('worker_base_url');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows followers when connected', async () => {
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
      getFollowers: () => [
        { runtimeId: 'follower-abc123' },
        { runtimeId: 'follower-def456' },
      ],
    });

    const result = await cmd.execute([], {} as never);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('followers:');
    expect(result.stdout).toContain('  - follower-abc123');
    expect(result.stdout).toContain('  - follower-def456');
  });

  it('prints error details when leader startup failed', async () => {
    const result = await createHostCommand({
      getStatus: () => ({ state: 'error', session: null, error: 'boom' }),
      getFollowers: () => [],
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe('status: error\njoin_url: unavailable\nerror: boom\n');
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
        lastPingTime: null,
        reconnectAttempts: 0,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connected)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower connecting status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: null,
        error: null,
        lastPingTime: null,
        reconnectAttempts: 0,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower error status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'error',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: null,
        error: 'WebRTC failed',
        lastPingTime: null,
        reconnectAttempts: 0,
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
        lastPingTime: null,
        reconnectAttempts: 0,
      }),
      getStatus: () => ({ state: 'inactive', session: null, error: null }),
      getFollowers: () => [],
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: inactive');
    expect(result.stdout).not.toContain('follower');
  });

  it('shows last_ping when follower is connected with lastPingTime', async () => {
    const now = Date.now();
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
        error: null,
        lastPingTime: now - 5000,
        reconnectAttempts: 0,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('last_ping:');
    expect(result.stdout).toContain('s ago');
  });

  it('shows reconnect_attempts when follower is reconnecting', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => ({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
        error: null,
        lastPingTime: Date.now() - 30000,
        reconnectAttempts: 3,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (reconnecting)');
    expect(result.stdout).toContain('reconnect_attempts: 3');
  });
});

describe('formatLeaderOutput', () => {
  it('formats leader with session and no followers', () => {
    const output = formatLeaderOutput(
      {
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
      },
      [],
    );
    expect(output).toBe('status: leader\njoin_url: https://tray.example.com/join/tray-123\n');
  });

  it('formats leader with followers', () => {
    const output = formatLeaderOutput(
      {
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
      },
      [{ runtimeId: 'follower-abc' }],
    );
    expect(output).toContain('followers:');
    expect(output).toContain('  - follower-abc');
  });

  it('formats leader with error and no session', () => {
    const output = formatLeaderOutput(
      { state: 'error', session: null, error: 'boom' },
      [],
    );
    expect(output).toBe('status: error\njoin_url: unavailable\nerror: boom\n');
  });
});

describe('formatFollowerOutput', () => {
  it('formats connected follower without tray_id', () => {
    const output = formatFollowerOutput({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    expect(output).toBe('status: follower (connected)\njoin_url: https://tray.example.com/join/token\n');
    expect(output).not.toContain('tray_id');
  });

  it('omits join_url when null', () => {
    const output = formatFollowerOutput({
      state: 'connecting',
      joinUrl: null,
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    expect(output).toBe('status: follower (connecting)\n');
  });

  it('includes error when present', () => {
    const output = formatFollowerOutput({
      state: 'error',
      joinUrl: null,
      trayId: null,
      error: 'something broke',
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    expect(output).toContain('error: something broke');
  });

  it('shows last_ping for connected follower with lastPingTime', () => {
    const now = Date.now();
    const output = formatFollowerOutput({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      error: null,
      lastPingTime: now - 10000,
      reconnectAttempts: 0,
    });
    expect(output).toContain('last_ping: 10s ago');
  });

  it('omits last_ping when lastPingTime is null', () => {
    const output = formatFollowerOutput({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    expect(output).not.toContain('last_ping');
  });

  it('shows reconnect_attempts for reconnecting follower', () => {
    const output = formatFollowerOutput({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      error: null,
      lastPingTime: Date.now() - 30000,
      reconnectAttempts: 5,
    });
    expect(output).toContain('status: follower (reconnecting)');
    expect(output).toContain('reconnect_attempts: 5');
    expect(output).not.toContain('last_ping');
  });

  it('omits reconnect_attempts when 0', () => {
    const output = formatFollowerOutput({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: null,
      error: null,
      lastPingTime: null,
      reconnectAttempts: 0,
    });
    expect(output).not.toContain('reconnect_attempts');
  });
});
