import { describe, expect, it } from 'vitest';
import type { CreateOpts, SandboxHandle, SandboxSubstrate, SubstrateId } from '../src/index.js';
import { startCone } from '../src/operations/start.js';
import { MemRegistry, makeFakeHandle } from './fixtures/index.js';

describe('startCone with coneConfigJson', () => {
  it('injects coneConfigJson as SLICC_CONE_CONFIG_B64 env and writes /slicc/cone-config.json', async () => {
    const writes: Array<{ path: string; contents: string | Uint8Array }> = [];
    let capturedCreateOpts: CreateOpts | undefined;
    const updatedAt = new Date().toISOString();

    const substrate: SandboxSubstrate = {
      id: 'e2b' as SubstrateId,
      async create(opts: CreateOpts): Promise<SandboxHandle> {
        capturedCreateOpts = opts;
        const sandboxId = 'sbx-fake';
        const handle = makeFakeHandle({ sandboxId });

        return {
          sandboxId: handle.sandboxId,
          substrate: handle.substrate,
          pause: handle.pause,
          kill: handle.kill,
          getInfo: handle.getInfo,
          writeFile: async (path: string, contents: string | Uint8Array) => {
            writes.push({ path, contents });
          },
          readFile: async (path: string) => {
            if (path === '/tmp/slicc-join.json') {
              return JSON.stringify({
                joinUrl: 'https://w/join/x',
                trayId: 't-1',
                updatedAt,
              });
            }
            throw new Error(`ENOENT ${path}`);
          },
          run: handle.run,
        };
      },
      async connect() {
        throw new Error('not used');
      },
      async list() {
        return [];
      },
      async extendTimeout() {},
    };

    const registry = new MemRegistry();
    await startCone(
      { substrate, registry },
      {
        envContents: 'GITHUB_TOKEN=gt\nGITHUB_TOKEN_DOMAINS=github.com\n',
        coneConfigJson: '{"model":"anthropic:claude-opus-4-6","accounts":[]}',
        workerBaseUrl: 'https://w',
        sliccVersion: 'web-test',
      }
    );

    // Assert: create opts include both SLICC_SECRETS_ENV_B64 and SLICC_CONE_CONFIG_B64
    expect(capturedCreateOpts).toBeDefined();
    expect(capturedCreateOpts!.envVars?.SLICC_SECRETS_ENV_B64).toBeTruthy();
    expect(capturedCreateOpts!.envVars?.SLICC_CONE_CONFIG_B64).toBeTruthy();

    // Assert: both files were written
    const secretsWrite = writes.find((w) => w.path === '/slicc/secrets.env');
    const configWrite = writes.find((w) => w.path === '/slicc/cone-config.json');

    expect(secretsWrite).toBeDefined();
    expect(secretsWrite!.contents).toContain('GITHUB_TOKEN=gt');

    expect(configWrite).toBeDefined();
    const configJson = JSON.parse(configWrite!.contents as string);
    expect(configJson.model).toBe('anthropic:claude-opus-4-6');
  });
});
