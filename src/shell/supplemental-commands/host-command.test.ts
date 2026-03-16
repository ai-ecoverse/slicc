import { describe, expect, it } from 'vitest';
import { createHostCommand, formatFollowerOutput, formatLeaderOutput, formatDuration } from './host-command.js';
import type { FollowerTrayRuntimeStatus } from '../../scoops/tray-follower-status.js';

/** Helper to build a FollowerTrayRuntimeStatus with sensible defaults for the new diagnostic fields. */
function followerStatus(overrides: Partial<FollowerTrayRuntimeStatus> & Pick<FollowerTrayRuntimeStatus, 'state'>): FollowerTrayRuntimeStatus {
  return {
    joinUrl: null,
    trayId: null,
    error: null,
    lastPingTime: null,
    reconnectAttempts: 0,
    attachAttempts: 0,
    lastAttachCode: null,
    connectingSince: null,
    lastError: null,
    ...overrides,
  };
}

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
      getFollowerStatus: () => followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connected)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower connecting status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('join_url: https://tray.example.com/join/token');
    expect(result.stdout).not.toContain('tray_id');
  });

  it('shows follower connecting diagnostics', async () => {
    const now = Date.now();
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({
        state: 'connecting',
        joinUrl: 'https://tray.example.com/join/token',
        connectingSince: now - 15000,
        attachAttempts: 7,
        lastAttachCode: 'LEADER_NOT_CONNECTED',
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (connecting)');
    expect(result.stdout).toContain('connecting_for: 15s');
    expect(result.stdout).toContain('attach_attempts: 7');
    expect(result.stdout).toContain('last_code: LEADER_NOT_CONNECTED');
  });

  it('shows follower error status', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({
        state: 'error',
        joinUrl: 'https://tray.example.com/join/token',
        error: 'WebRTC failed',
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('status: follower (error)');
    expect(result.stdout).toContain('error: WebRTC failed');
  });

  it('falls back to leader status when follower is inactive', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({ state: 'inactive' }),
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
      getFollowerStatus: () => followerStatus({
        state: 'connected',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
        lastPingTime: now - 5000,
      }),
    }).execute([], {} as never);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('last_ping:');
    expect(result.stdout).toContain('s ago');
  });

  it('shows reconnect_attempts when follower is reconnecting', async () => {
    const result = await createHostCommand({
      getFollowerStatus: () => followerStatus({
        state: 'reconnecting',
        joinUrl: 'https://tray.example.com/join/token',
        trayId: 'tray-456',
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

  it('formats leader with follower metadata (runtime + connectedAt)', () => {
    const connectedAt = new Date(Date.now() - 125_000).toISOString(); // 2m 5s ago
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
      [{ runtimeId: 'follower-abc', runtime: 'slicc-electron', connectedAt }],
    );
    expect(output).toContain('followers:');
    expect(output).toContain('  - follower-abc (slicc-electron) connected 2m ago');
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
    const output = formatFollowerOutput(followerStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
    }));
    expect(output).toBe('status: follower (connected)\njoin_url: https://tray.example.com/join/token\n');
    expect(output).not.toContain('tray_id');
  });

  it('omits join_url when null', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'connecting',
    }));
    expect(output).toBe('status: follower (connecting)\n');
  });

  it('includes error when present', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'error',
      error: 'something broke',
    }));
    expect(output).toContain('error: something broke');
  });

  it('shows last_ping for connected follower with lastPingTime', () => {
    const now = Date.now();
    const output = formatFollowerOutput(followerStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      lastPingTime: now - 10000,
    }));
    expect(output).toContain('last_ping: 10s ago');
  });

  it('omits last_ping when lastPingTime is null', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
    }));
    expect(output).not.toContain('last_ping');
  });

  it('shows reconnect_attempts for reconnecting follower', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
      trayId: 'tray-789',
      lastPingTime: Date.now() - 30000,
      reconnectAttempts: 5,
    }));
    expect(output).toContain('status: follower (reconnecting)');
    expect(output).toContain('reconnect_attempts: 5');
    expect(output).not.toContain('last_ping');
  });

  it('omits reconnect_attempts when 0', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'reconnecting',
      joinUrl: 'https://tray.example.com/join/token',
    }));
    expect(output).not.toContain('reconnect_attempts');
  });

  it('shows connecting diagnostics when available', () => {
    const now = Date.now();
    const output = formatFollowerOutput(followerStatus({
      state: 'connecting',
      joinUrl: 'https://tray.example.com/join/token',
      connectingSince: now - 30000,
      attachAttempts: 15,
      lastAttachCode: 'LEADER_NOT_ELECTED',
    }));
    expect(output).toContain('status: follower (connecting)');
    expect(output).toContain('connecting_for: 30s');
    expect(output).toContain('attach_attempts: 15');
    expect(output).toContain('last_code: LEADER_NOT_ELECTED');
  });

  it('shows last_error when present', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'connecting',
      joinUrl: 'https://tray.example.com/join/token',
      lastError: 'Tray follower attach returned an invalid response (502): Bad Gateway',
    }));
    expect(output).toContain('last_error: Tray follower attach returned an invalid response (502): Bad Gateway');
  });

  it('omits connecting diagnostics when not in connecting state', () => {
    const output = formatFollowerOutput(followerStatus({
      state: 'connected',
      joinUrl: 'https://tray.example.com/join/token',
      attachAttempts: 5,
      lastAttachCode: 'LEADER_CONNECTED',
      connectingSince: Date.now() - 10000,
    }));
    expect(output).not.toContain('attach_attempts');
    expect(output).not.toContain('last_code');
    expect(output).not.toContain('connecting_for');
  });
});

describe('formatDuration', () => {
  it('formats seconds', () => {
    expect(formatDuration(30)).toBe('30s ago');
  });

  it('formats minutes', () => {
    expect(formatDuration(120)).toBe('2m ago');
    expect(formatDuration(90)).toBe('1m ago');
  });

  it('formats hours', () => {
    expect(formatDuration(3600)).toBe('1h ago');
    expect(formatDuration(7200)).toBe('2h ago');
  });

  it('formats hours and minutes', () => {
    expect(formatDuration(3660)).toBe('1h 1m ago');
    expect(formatDuration(5400)).toBe('1h 30m ago');
  });

  it('formats zero seconds', () => {
    expect(formatDuration(0)).toBe('0s ago');
  });
});
