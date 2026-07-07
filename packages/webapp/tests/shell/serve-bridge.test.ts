import type { CommandContext } from 'just-bash';
import { unsafeBytesFromLatin1 } from 'just-bash';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebhookEntry } from '../../src/scoops/lick-manager.js';

// Mock dependencies
vi.mock('../../src/shell/supplemental-commands/lick-surface.js', () => {
  let createdWebhooks: Array<{ name: string; id: string }> = [];
  let deletedWebhooks: string[] = [];

  return {
    getLickManagerSurface: vi.fn(async () => ({
      createWebhook: vi.fn(async (name: string) => {
        // The serve command reads a mint-time `url` alongside the persisted
        // WebhookEntry fields; model that as an intersection.
        const entry: WebhookEntry & { url: string } = {
          id: `wh${createdWebhooks.length + 1}`,
          name,
          createdAt: new Date().toISOString(),
          scoop: undefined,
          filter: undefined,
          url: `https://example.com/webhook/wh${createdWebhooks.length + 1}`,
        };
        createdWebhooks.push({ name, id: entry.id });
        return entry;
      }),
      deleteWebhook: vi.fn(async (id: string) => {
        deletedWebhooks.push(id);
        return true;
      }),
      listWebhooks: vi.fn(async () => []),
    })),
    __getCreatedWebhooks: () => createdWebhooks,
    __getDeletedWebhooks: () => deletedWebhooks,
    __resetMocks: () => {
      createdWebhooks = [];
      deletedWebhooks = [];
    },
  };
});

vi.mock('../../src/kernel/panel-rpc.js', () => {
  let mintArgs: any = null;
  const mintedStates = new Map<string, { webhookId?: string }>();

  return {
    getPanelRpcClient: vi.fn(() => ({
      call: vi.fn((op: string, payload: any) => {
        if (op === 'tray-open-preview') {
          mintArgs = payload;
          const previewToken = 'token123';
          if (payload.webhookId) {
            mintedStates.set(previewToken, { webhookId: payload.webhookId });
          }
          return Promise.resolve({
            url: 'https://preview.sliccy.dev/token123',
            pushed: 0,
            previewToken,
          });
        }
        if (op === 'tray-revoke-preview') {
          const state = mintedStates.get(payload.previewToken) ?? {};
          return Promise.resolve({ revoked: true, webhookId: state.webhookId });
        }
        return Promise.reject(new Error(`Unknown op: ${op}`));
      }),
    })),
    __getMintArgs: () => mintArgs,
    __resetMintArgs: () => {
      mintArgs = null;
      mintedStates.clear();
    },
    __setMintedState: (token: string, state: { webhookId?: string }) => {
      mintedStates.set(token, state);
    },
  };
});

vi.mock('../../src/scoops/preview-minter.js', () => ({
  getPreviewMinter: vi.fn(() => null),
  getPreviewOp: vi.fn(() => null),
}));

async function runServe(
  argv: string[],
  opts?: { cherryFollower?: boolean; minted?: { token: string; webhookId: string } }
) {
  // The vi.mock factories above attach test-only __ helpers that the real
  // modules do not export — cast the mocked module namespaces to reach them.
  const { __getCreatedWebhooks, __getDeletedWebhooks, __resetMocks } = (await import(
    '../../src/shell/supplemental-commands/lick-surface.js'
  )) as unknown as {
    __getCreatedWebhooks: () => Array<{ name: string; id: string }>;
    __getDeletedWebhooks: () => string[];
    __resetMocks: () => void;
  };
  const { __getMintArgs, __resetMintArgs, __setMintedState } = (await import(
    '../../src/kernel/panel-rpc.js'
  )) as unknown as {
    __getMintArgs: () => { bridge?: boolean; webhookId?: string } & Record<string, unknown>;
    __resetMintArgs: () => void;
    __setMintedState: (token: string, state: { webhookId: string }) => void;
  };

  __resetMocks();
  __resetMintArgs();

  // Set up minted state if provided
  if (opts?.minted) {
    __setMintedState(opts.minted.token, { webhookId: opts.minted.webhookId });
  }

  const { createServeCommand } = await import(
    '../../src/shell/supplemental-commands/serve-command.js'
  );

  const ctx: CommandContext = {
    cwd: '/workspace',
    env: new Map<string, string>(),
    stdin: unsafeBytesFromLatin1(''),
    fs: {
      resolvePath: (base: string, rel: string) => {
        if (rel.startsWith('/')) return rel;
        return `${base}/${rel}`.replace(/\/+/g, '/');
      },
      stat: async (p: string) => {
        if (p === '/workspace/dist') {
          return { isDirectory: true, isFile: false };
        }
        if (p === '/workspace/dist/index.html') {
          return { isDirectory: false, isFile: true };
        }
        throw new Error('ENOENT');
      },
    } as any,
    exec: {} as any,
  };

  const cmd = createServeCommand();
  const result = (await cmd.execute(argv, ctx)) as {
    stdout: string;
    stderr: string;
    exitCode: number;
  };

  const mintArgs = __getMintArgs();
  const createdWebhooks = __getCreatedWebhooks();
  const deletedWebhooks = __getDeletedWebhooks();

  return { mintArgs, createdWebhooks, deletedWebhooks, result };
}

describe('serve --bridge', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('serve --bridge provisions a webhook and marks the mint bridged', async () => {
    const { mintArgs, createdWebhooks } = await runServe(['--bridge', '/workspace/dist']);
    expect(mintArgs.bridge).toBe(true);
    expect(mintArgs.webhookId).toBeTruthy();
    expect(createdWebhooks.length).toBe(1);
  });

  it('plain serve is not bridged and creates no webhook', async () => {
    const { mintArgs, createdWebhooks } = await runServe(['/workspace/dist']);
    expect(mintArgs.bridge).toBe(false);
    expect(createdWebhooks.length).toBe(0);
  });

  it('--no-bridge beats a connected cherry follower', async () => {
    const { mintArgs } = await runServe(['--no-bridge', '/workspace/dist'], {
      cherryFollower: true,
    });
    expect(mintArgs.bridge).toBe(false);
  });

  it('serve --stop deletes the auto-provisioned webhook', async () => {
    const { deletedWebhooks } = await runServe(['--stop', 'token123'], {
      minted: { token: 'token123', webhookId: 'wh1' },
    });
    expect(deletedWebhooks).toContain('wh1');
  });

  it('serve --stop warns (never silently succeeds) when the lick manager is unavailable', async () => {
    const { getLickManagerSurface } = await import(
      '../../src/shell/supplemental-commands/lick-surface.js'
    );
    // Revoke succeeds worker-side but the webhook can't be cleaned up.
    (getLickManagerSurface as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce(null);
    const { result, deletedWebhooks } = await runServe(['--stop', 'token123'], {
      minted: { token: 'token123', webhookId: 'wh1' },
    });
    expect(deletedWebhooks).not.toContain('wh1');
    expect(result.exitCode).toBe(0);
    expect(result.stderr).toContain('webhook delete wh1');
  });
});
