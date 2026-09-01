import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsError, FsWatcher, VirtualFS } from '../../src/fs/index.js';
import {
  appendLlmsTxtIgnoreHost,
  discoveryHostname,
  LLMS_TXT_IGNORE_FILE,
  LlmsTxtIgnorePolicy,
  matchesLlmsTxtIgnore,
  parseLlmsTxtIgnore,
  scoopCanBrowse,
} from '../../src/scoops/llms-txt-ignore.js';

async function flush(check: () => boolean, tries = 50): Promise<void> {
  for (let i = 0; i < tries && !check(); i++)
    await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('/etc/llmstxtignore', () => {
  let fs: VirtualFS;
  let watcher: FsWatcher;
  let policy: LlmsTxtIgnorePolicy;
  let dbCounter = 0;

  beforeEach(async () => {
    fs = await VirtualFS.create({ dbName: `llmstxtignore-${dbCounter++}`, wipe: true });
    watcher = new FsWatcher();
    fs.setWatcher(watcher);
    policy = new LlmsTxtIgnorePolicy(fs, watcher);
    await policy.init();
  });

  afterEach(async () => {
    policy.dispose();
    await fs.dispose?.();
  });

  it('parses exact and glob entries while ignoring comments and blanks', () => {
    const entries = parseLlmsTxtIgnore('  # comment\nGitHub.COM # noisy\n\n*.Slack.com\n');
    expect(entries).toEqual(['github.com', '*.slack.com']);
    expect(matchesLlmsTxtIgnore('GITHUB.com', entries)).toBe(true);
    expect(matchesLlmsTxtIgnore('adobe.enterprise.slack.com', entries)).toBe(true);
    expect(matchesLlmsTxtIgnore('slack.com', entries)).toBe(false);
  });

  it('seeds github.com and app.slack.com defaults', async () => {
    const seeded = await fs.readTextFile(LLMS_TXT_IGNORE_FILE);
    expect(parseLlmsTxtIgnore(seeded)).toEqual(['github.com', 'app.slack.com']);
    expect(
      policy.ignores({
        type: 'discovery',
        discoveryOrigin: 'https://github.com',
        discoveryKind: 'llms-txt',
        discoveryUrl: 'https://github.com/llms.txt',
        discoverySource: 'live-navigation',
        timestamp: 't',
        body: {},
      })
    ).toBe(true);
  });

  it('live-reloads hand edits and leaves ai-catalog discovery unaffected', async () => {
    await fs.writeFile(LLMS_TXT_IGNORE_FILE, '*.slack.com\n');
    const llmsEvent = {
      type: 'discovery' as const,
      discoveryOrigin: 'https://adobe.enterprise.slack.com',
      discoveryKind: 'llms-txt' as const,
      discoveryUrl: 'https://adobe.enterprise.slack.com/llms.txt',
      discoverySource: 'live-navigation' as const,
      timestamp: 't',
      body: {},
    };
    await flush(() => policy.ignores(llmsEvent));
    expect(policy.ignores(llmsEvent)).toBe(true);
    expect(policy.ignores({ ...llmsEvent, discoveryKind: 'ai-catalog' })).toBe(false);
  });

  it('appends a normalized host once', async () => {
    expect(await appendLlmsTxtIgnoreHost(fs, 'Example.COM')).toBe(true);
    expect(await appendLlmsTxtIgnoreHost(fs, 'example.com')).toBe(false);
    expect(
      parseLlmsTxtIgnore(await fs.readTextFile(LLMS_TXT_IGNORE_FILE)).filter(
        (entry) => entry === 'example.com'
      )
    ).toHaveLength(1);
  });

  it('starts from empty when the policy file does not exist yet (ENOENT)', async () => {
    let written = '';
    const stub = {
      readFile: async () => {
        throw new FsError('ENOENT', 'no such file', LLMS_TXT_IGNORE_FILE);
      },
      writeFile: async (_path: string, data: string) => {
        written = data;
      },
    } as never;
    expect(await appendLlmsTxtIgnoreHost(stub, 'example.com')).toBe(true);
    expect(written).toBe('example.com\n');
  });

  it('aborts the append instead of clobbering the policy on a transient read fault', async () => {
    // Seed a multi-host policy, then fail the read with a non-ENOENT fault.
    await fs.writeFile(LLMS_TXT_IGNORE_FILE, 'github.com\napp.slack.com\n');
    let wrote = false;
    const stub = {
      readFile: async () => {
        throw new FsError('EIO', 'transient VFS fault', LLMS_TXT_IGNORE_FILE);
      },
      writeFile: async () => {
        wrote = true;
      },
    } as never;
    await expect(appendLlmsTxtIgnoreHost(stub, 'evil.example')).rejects.toBeInstanceOf(FsError);
    expect(wrote).toBe(false);
    // The on-disk policy is untouched — no host was silently dropped.
    expect(parseLlmsTxtIgnore(await fs.readTextFile(LLMS_TXT_IGNORE_FILE))).toEqual([
      'github.com',
      'app.slack.com',
    ]);
  });

  it('propagates a non-FsError read fault rather than treating it as empty', async () => {
    const stub = {
      readFile: async () => {
        throw new TypeError('unexpected');
      },
      writeFile: async () => {
        throw new Error('writeFile must not be reached');
      },
    } as never;
    await expect(appendLlmsTxtIgnoreHost(stub, 'example.com')).rejects.toBeInstanceOf(TypeError);
  });

  it('classifies browser-capable scoops without leaking discovery to restricted ones', () => {
    const scoop = (allowedCommands: string[] | undefined, isCone = false) =>
      ({
        jid: 'j',
        folder: 'f',
        isCone,
        config: allowedCommands ? { allowedCommands } : undefined,
      }) as never;
    expect(scoopCanBrowse(scoop(['curl']))).toBe(true);
    expect(scoopCanBrowse(scoop(['playwright-cli']))).toBe(true);
    expect(scoopCanBrowse(scoop(['git', 'grep']))).toBe(false);
    expect(scoopCanBrowse(scoop(undefined, true))).toBe(true);
  });

  it('extracts the advertising hostname with URL fallback', () => {
    expect(discoveryHostname('https://EXAMPLE.com:8443', undefined)).toBe('example.com');
    expect(discoveryHostname('bad', 'https://fallback.example/llms.txt')).toBe('fallback.example');
    expect(discoveryHostname('bad', 'also bad')).toBeNull();
  });
});
