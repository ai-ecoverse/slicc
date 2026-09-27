import { describe, expect, it, vi } from 'vitest';
import {
  ensureHostedLeaderPage,
  findIdlePageTarget,
  navigatePageToUrl,
  openNewCdpPage,
  runHostedPageWatchdog,
  withCdpOpTimeout,
} from '../src/hosted-page-watchdog.js';
import type { CdpLike, CdpTargetInfo } from '../src/leader-restart.js';

function page(partial: Partial<CdpTargetInfo> & { url: string; id?: string }): CdpTargetInfo {
  return {
    type: 'page',
    attached: true,
    id: 'p1',
    ...partial,
  };
}

describe('findIdlePageTarget', () => {
  it('prefers an attached about:blank over NTP', () => {
    const targets = [
      page({ id: 'ntp', url: 'chrome://newtab/', attached: false }),
      page({ id: 'blank', url: 'about:blank', attached: true }),
    ];
    expect(findIdlePageTarget(targets)?.id).toBe('blank');
  });

  it('returns null when every page is a real site', () => {
    expect(
      findIdlePageTarget([page({ url: 'https://www.sliccy.ai/?runtime=hosted-leader' })])
    ).toBeNull();
  });
});

describe('openNewCdpPage', () => {
  it('PUTs /json/new and falls back to GET when PUT is rejected', async () => {
    const calls: Array<{ url: string; method?: string }> = [];
    const fetchImpl: typeof fetch = async (input, init) => {
      calls.push({ url: String(input), method: init?.method });
      if (init?.method === 'PUT') return new Response(null, { status: 405 });
      return new Response(JSON.stringify({ id: 'new' }), { status: 200 });
    };
    await openNewCdpPage(9222, 'https://www.sliccy.ai/?runtime=hosted-leader', fetchImpl);
    expect(calls).toEqual([
      {
        url: 'http://127.0.0.1:9222/json/new?https%3A%2F%2Fwww.sliccy.ai%2F%3Fruntime%3Dhosted-leader',
        method: 'PUT',
      },
      {
        url: 'http://127.0.0.1:9222/json/new?https%3A%2F%2Fwww.sliccy.ai%2F%3Fruntime%3Dhosted-leader',
        method: undefined,
      },
    ]);
  });

  it('throws when both PUT and GET fail', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 500 });
    await expect(openNewCdpPage(1, 'https://x', fetchImpl)).rejects.toThrow(
      'CDP /json/new failed: HTTP 500'
    );
  });
});

describe('navigatePageToUrl', () => {
  it('attaches and navigates the target', async () => {
    const calls: string[] = [];
    const cdp: CdpLike = {
      send: vi.fn(async (method: string, params?: unknown) => {
        calls.push(method);
        if (method === 'Target.attachToTarget') {
          expect(params).toMatchObject({ targetId: 'blank', flatten: true });
          return { sessionId: 'sess' };
        }
        if (method === 'Page.navigate') {
          expect(params).toEqual({ url: 'https://www.sliccy.ai/?runtime=hosted-leader' });
          return {};
        }
        return {};
      }),
    };
    await navigatePageToUrl(
      cdp,
      page({ id: 'blank', url: 'about:blank' }),
      'https://www.sliccy.ai/?runtime=hosted-leader'
    );
    expect(calls).toEqual(['Target.attachToTarget', 'Page.navigate']);
  });
});

describe('ensureHostedLeaderPage', () => {
  it('no-ops when a SLICC tab is already present', async () => {
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [page({ url: 'https://www.sliccy.ai/?bridge=ws://localhost/cdp' })],
          };
        }
        return {};
      }),
    };
    const openPage = vi.fn();
    await expect(
      ensureHostedLeaderPage({
        cdp,
        cdpPort: 1,
        launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
        pageUrlPrefix: 'https://www.sliccy.ai/',
        openPage,
      })
    ).resolves.toBe('had-slicc');
    expect(openPage).not.toHaveBeenCalled();
  });

  it('navigates an idle tab instead of opening a second one', async () => {
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return { targetInfos: [page({ id: 'blank', url: 'about:blank' })] };
        }
        if (method === 'Target.attachToTarget') return { sessionId: 's' };
        return {};
      }),
    };
    const openPage = vi.fn();
    await expect(
      ensureHostedLeaderPage({
        cdp,
        cdpPort: 1,
        launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
        pageUrlPrefix: 'https://www.sliccy.ai/',
        openPage,
      })
    ).resolves.toBe('navigated');
    expect(openPage).not.toHaveBeenCalled();
    expect(cdp.send).toHaveBeenCalledWith(
      'Page.navigate',
      {
        url: 'https://www.sliccy.ai/?runtime=hosted-leader',
      },
      's'
    );
  });

  it('opens a new tab when Chrome has no pages', async () => {
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      }),
    };
    const openPage = vi.fn(async () => {});
    await expect(
      ensureHostedLeaderPage({
        cdp,
        cdpPort: 9222,
        launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
        pageUrlPrefix: 'https://www.sliccy.ai/',
        openPage,
      })
    ).resolves.toBe('opened');
    expect(openPage).toHaveBeenCalledWith(9222, 'https://www.sliccy.ai/?runtime=hosted-leader');
  });
});

describe('runHostedPageWatchdog', () => {
  it('exits without CDP action when the page connects during grace', async () => {
    let alive = false;
    const openPage = vi.fn();
    const cdp: CdpLike = { send: vi.fn() };
    let t = 0;
    const outcome = runHostedPageWatchdog({
      cdp,
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      openPage,
      sleep: async () => {
        t += 1000;
        if (t >= 3000) alive = true;
      },
      now: () => t,
      graceMs: 12_000,
      pollMs: 1000,
      log: () => {},
    });
    await expect(outcome).resolves.toBe('alive');
    expect(openPage).not.toHaveBeenCalled();
    expect(cdp.send).not.toHaveBeenCalled();
  });

  it('opens the launch URL after grace when /cdp stays quiet', async () => {
    const openPage = vi.fn(async () => {});
    const logs: string[] = [];
    let t = 0;
    let alive = false;
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') return { targetInfos: [] };
        return {};
      }),
    };
    const outcome = runHostedPageWatchdog({
      cdp,
      cdpPort: 9222,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      openPage,
      reload: vi.fn(async () => ({ ok: true })),
      sleep: async () => {
        t += 1000;
        // After the ensure step opens a tab, pretend the page connects.
        if (t >= 14_000) alive = true;
      },
      now: () => t,
      graceMs: 12_000,
      stuckMs: 30_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('alive');
    expect(openPage).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('opened launch URL'))).toBe(true);
  });

  it('reloads a present SLICC tab that never dials /cdp', async () => {
    const reload = vi.fn(async () => ({ ok: true }));
    const logs: string[] = [];
    let t = 0;
    let alive = false;
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [page({ url: 'https://www.sliccy.ai/?runtime=hosted-leader' })],
          };
        }
        return {};
      }),
    };
    const outcome = runHostedPageWatchdog({
      cdp,
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      openPage: vi.fn(),
      reload,
      sleep: async () => {
        t += 5_000;
        if (t >= 50_000) alive = true;
      },
      now: () => t,
      graceMs: 12_000,
      stuckMs: 30_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('alive');
    expect(reload).toHaveBeenCalledOnce();
    expect(logs.some((l) => l.includes('reloaded SLICC tab'))).toBe(true);
  });

  it('logs ensure failures, skipped reloads, reload throws, then gives up', async () => {
    const logs: string[] = [];
    let t = 0;
    const cdp: CdpLike = {
      send: vi.fn(async () => {
        throw new Error('cdp down');
      }),
    };
    const outcome = runHostedPageWatchdog({
      cdp,
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => false,
      openPage: vi.fn(async () => {
        throw new Error('open failed');
      }),
      reload: vi.fn(async () => ({ ok: false, code: 'NO_LEADER_TAB' })),
      sleep: async () => {
        t += 20_000;
      },
      now: () => t,
      graceMs: 10_000,
      stuckMs: 10_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    // First tick: ensure (fails). Second: reload skipped. Third: gave-up.
    // Force a second reload attempt path by resetting — actually after first
    // reload, reloaded=true, next threshold is grace+2*stuck → gave-up.
    await expect(outcome).resolves.toBe('gave-up');
    expect(logs.some((l) => l.includes('ensure failed'))).toBe(true);
    expect(logs.some((l) => l.includes('reload skipped (NO_LEADER_TAB)'))).toBe(true);
    expect(logs.some((l) => l.includes('gave up'))).toBe(true);
  });

  it('reload skipped reports unknown when the result has no code', async () => {
    const logs: string[] = [];
    let t = 0;
    let alive = false;
    const outcome = runHostedPageWatchdog({
      cdp: {
        send: vi.fn(async (method: string) => {
          if (method === 'Target.getTargets') {
            return {
              targetInfos: [page({ url: 'https://www.sliccy.ai/?runtime=hosted-leader' })],
            };
          }
          return {};
        }),
      },
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      openPage: vi.fn(),
      reload: vi.fn(async () => 'nope'),
      sleep: async () => {
        t += 20_000;
        if (t >= 60_000) alive = true;
      },
      now: () => t,
      graceMs: 10_000,
      stuckMs: 10_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('alive');
    expect(logs.some((l) => l.includes('reload skipped (unknown)'))).toBe(true);
  });

  it('stringifies non-Error failures from ensure', async () => {
    const logs: string[] = [];
    let t = 0;
    let alive = false;
    const outcome = runHostedPageWatchdog({
      cdp: {
        send: vi.fn(async () => {
          throw 'bare-string-failure';
        }),
      },
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      sleep: async () => {
        t += 20_000;
        if (t >= 40_000) alive = true;
      },
      now: () => t,
      graceMs: 10_000,
      stuckMs: 60_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('alive');
    expect(logs.some((l) => l.includes('ensure failed: bare-string-failure'))).toBe(true);
  });

  it('times out a hung ensure and still reaches gave-up', async () => {
    const logs: string[] = [];
    let t = 0;
    const never: Promise<never> = new Promise(() => {});
    const outcome = runHostedPageWatchdog({
      cdp: {
        send: vi.fn(() => never),
      },
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => false,
      openPage: vi.fn(() => never),
      reload: vi.fn(() => never),
      sleep: async () => {
        t += 20_000;
      },
      now: () => t,
      graceMs: 10_000,
      stuckMs: 10_000,
      pollMs: 1000,
      cdpOpMs: 20,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('gave-up');
    expect(logs.some((l) => l.includes('ensure failed') && l.includes('timed out'))).toBe(true);
    expect(logs.some((l) => l.includes('reload failed') && l.includes('timed out'))).toBe(true);
    expect(logs.some((l) => l.includes('gave up'))).toBe(true);
  });

  it('logs when reload throws', async () => {
    const logs: string[] = [];
    let t = 0;
    let alive = false;
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return {
            targetInfos: [page({ url: 'https://www.sliccy.ai/?runtime=hosted-leader' })],
          };
        }
        return {};
      }),
    };
    const outcome = runHostedPageWatchdog({
      cdp,
      cdpPort: 1,
      launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
      pageUrlPrefix: 'https://www.sliccy.ai/',
      isAlive: () => alive,
      openPage: vi.fn(),
      reload: vi.fn(async () => {
        throw new Error('reload boom');
      }),
      sleep: async () => {
        t += 20_000;
        if (t >= 60_000) alive = true;
      },
      now: () => t,
      graceMs: 10_000,
      stuckMs: 10_000,
      pollMs: 1000,
      log: (m) => logs.push(m),
    });
    await expect(outcome).resolves.toBe('alive');
    expect(logs.some((l) => l.includes('reload failed: reload boom'))).toBe(true);
  });
});

describe('withCdpOpTimeout', () => {
  it('resolves when the promise settles first', async () => {
    await expect(withCdpOpTimeout(Promise.resolve('ok'), 50, 'probe')).resolves.toBe('ok');
  });

  it('rejects when the promise never settles', async () => {
    await expect(withCdpOpTimeout(new Promise(() => {}), 20, 'probe')).rejects.toThrow(
      'probe timed out after 20ms'
    );
  });
});

describe('ensureHostedLeaderPage — non-idle fallback', () => {
  it('navigates a non-idle page when no blank tab exists', async () => {
    const cdp: CdpLike = {
      send: vi.fn(async (method: string) => {
        if (method === 'Target.getTargets') {
          return { targetInfos: [page({ id: 'other', url: 'https://example.com/' })] };
        }
        if (method === 'Target.attachToTarget') return { sessionId: 's' };
        return {};
      }),
    };
    await expect(
      ensureHostedLeaderPage({
        cdp,
        cdpPort: 1,
        launchUrl: 'https://www.sliccy.ai/?runtime=hosted-leader',
        pageUrlPrefix: 'https://www.sliccy.ai/',
        openPage: vi.fn(),
      })
    ).resolves.toBe('navigated');
  });

  it('rejects navigate when the target has no id', async () => {
    await expect(
      navigatePageToUrl(
        { send: vi.fn() },
        { type: 'page', url: 'about:blank', attached: true },
        'https://x'
      )
    ).rejects.toThrow('target missing id');
  });
});
