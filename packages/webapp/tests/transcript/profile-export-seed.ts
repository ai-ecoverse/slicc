import 'fake-indexeddb/auto';
import type { AgentMessage } from '@earendil-works/pi-agent-core';
import { VirtualFS } from '../../src/fs/index.js';
import type { LocalVfsClient } from '../../src/kernel/local-vfs-client.js';
import type { ChatMessage } from '../../src/scoops/chat-types.js';
import { DefaultTranscriptExportService } from '../../src/transcript/export-service.js';
import type { ProfileExportDeps, ProfileUnit } from '../../src/transcript/profile-export.js';
import type { KnownSecretBatchRedactor } from '../../src/transcript/redact.js';
import type { SanitizedTranscriptSnapshot } from '../../src/transcript/snapshot-store.js';
import { makeTranscriptDocument } from './fixtures.js';

export const SECRETS = {
  anthropic: 'zzfake-anthropic-key-0123456789abcdef',
  openai: 'zzfake-openai-key-fedcba9876543210',
  mcpToken: 'zzfake-mcp-access-token-5555',
  mcpHeader: 'zzfake-mcp-header-secret-7777',
  github: 'zzfake-github-token-31415926',
  knownSecret: 'zzfake-secrets-env-value-2718',
} as const;

export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
export const ENV_FILE = 'API_KEY=local-dev-value\nDEBUG=1\n';
export const PEM_FILE = '-----BEGIN CERTIFICATE-----\nMIIBfake\n-----END CERTIFICATE-----\n';
export const BUNDLED_SKILL = '---\nname: browser\ndescription: bundled\n---\nBundled skill.\n';

export const UNITS: ProfileUnit[] = [
  { jid: 'cone_1', name: 'Sliccy', folder: 'cone', parentJid: null },
  { jid: 'scoop_research_1', name: 'research', folder: 'research-scoop', parentJid: 'cone_1' },
  { jid: 'cone_2', name: 'Side project', folder: 'side-project', parentJid: null },
];

function agentMessages(text: string): AgentMessage[] {
  return [
    { role: 'user', content: text, timestamp: 1_000 },
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'Noted.' }],
      api: 'anthropic-messages',
      provider: 'anthropic',
      model: 'claude-sonnet-4-5',
      usage: {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: 'stop',
      timestamp: 2_000,
    } as AgentMessage,
  ];
}

const MESSAGES: { [jid: string]: AgentMessage[] } = {
  cone_1: agentMessages(`my key is ${SECRETS.anthropic} and the token ${SECRETS.github}`),
  scoop_research_1: agentMessages('research the topic'),
  cone_2: agentMessages(`side work with ${SECRETS.knownSecret}`),
};

const UI_ATTACHMENT_MESSAGE: ChatMessage = {
  id: 'ui-1',
  role: 'user',
  content: `my key is ${SECRETS.anthropic} and the token ${SECRETS.github}`,
  timestamp: 1_000,
  attachments: [
    {
      id: 'att-ui-1',
      name: 'photo.png',
      mimeType: 'image/png',
      size: PNG.length,
      kind: 'file',
      data: btoa(String.fromCharCode(...PNG)),
    },
  ],
};

export const knownSecretsRedactor: KnownSecretBatchRedactor = {
  redact: async (texts) =>
    texts.map((t) => t.split(SECRETS.knownSecret).join('⟦REDACTED:secret:SECRETS_ENV⟧')),
};

interface ZipEntry {
  name: string;
  data: Uint8Array;
}

export function readStoredZip(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: ZipEntry[] = [];
  let offset = 0;
  while (view.getUint32(offset, true) === 0x04034b50) {
    if (view.getUint16(offset + 8, true) !== 0) throw new Error('not a stored entry');
    const size = view.getUint32(offset + 18, true);
    const nameLen = view.getUint16(offset + 26, true);
    const extraLen = view.getUint16(offset + 28, true);
    const name = new TextDecoder().decode(bytes.subarray(offset + 30, offset + 30 + nameLen));
    const start = offset + 30 + nameLen + extraLen;
    out.push({ name, data: bytes.subarray(start, start + size) });
    offset = start + size;
  }
  if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('no central directory');
  return out;
}

let dbCounter = 0;

export interface SeededProfile {
  fs: VirtualFS;
  deps: ProfileExportDeps;
}

async function write(fs: VirtualFS, path: string, content: string | Uint8Array): Promise<void> {
  await fs.mkdir(path.slice(0, path.lastIndexOf('/')) || '/', { recursive: true });
  await fs.writeFile(path, content);
}

export async function seedProfile(
  overrides: Partial<ProfileExportDeps> = {}
): Promise<SeededProfile> {
  const fs = await VirtualFS.create({ dbName: `profile-export-${dbCounter++}`, wipe: true });
  const files: [string, string | Uint8Array][] = [
    ['/workspace/notes.md', `# Notes\nprovider key: ${SECRETS.anthropic}\nplain text\n`],
    ['/workspace/.env', ENV_FILE],
    ['/workspace/certs/server.pem', PEM_FILE],
    ['/workspace/image.bin', new Uint8Array([0, 1, 2, 3, 0, 255])],
    ['/workspace/node_modules/left-pad/index.js', 'module.exports = 1;\n'],
    ['/workspace/repo/.git/hooks/pre-commit', '#!/bin/sh\nexit 0\n'],
    ['/workspace/repo/.git/HEAD', 'ref: refs/heads/main\n'],
    ['/workspace/CLAUDE.md', `# Cone memory\nRemember ${SECRETS.openai}.\n`],
    [
      '/workspace/skills/my-skill/SKILL.md',
      '---\nname: my-skill\ndescription: mine\n---\nDo it.\n',
    ],
    ['/workspace/skills/browser/SKILL.md', BUNDLED_SKILL],
    ['/workspace/.slicc/oauth/xai.json', '{"access":"opaque-oauth-state"}\n'],
    ['/shared/CLAUDE.md', '# Global memory\nPrefers tabs.\n'],
    ['/shared/sprinkles/dash/dash.shtml', '<title>Dash</title><div>dash</div>\n'],
    ['/cones/side-project/workspace/app.ts', 'export const app = 1;\n'],
    ['/cones/side-project/workspace/.npmrc', '//registry.npmjs.org/:_authToken=npm-local\n'],
    ['/cones/side-project/CLAUDE.md', '# Side memory\n'],
    ['/scoops/research-scoop/workspace/findings.md', 'findings\n'],
    ['/home/user/todo.txt', `todo: rotate ${SECRETS.mcpHeader}\n`],
    ['/mnt/project/README.md', 'mounted, never exported\n'],
    [
      '/sessions/index.json',
      JSON.stringify([
        {
          filename: '2026-10-01T10-00-00Z-old-chat.json',
          title: 'Old chat',
          frozenAt: '2026-10-01T10:00:00.000Z',
          messageCount: 2,
          sessionId: 'frozen-1',
        },
      ]),
    ],
  ];
  for (const [path, content] of files) await write(fs, path, content);

  const frozenDoc = makeTranscriptDocument();
  frozenDoc.session = { ...frozenDoc.session, id: 'frozen-1', title: 'Old chat', state: 'frozen' };
  const frozenSnapshot: SanitizedTranscriptSnapshot = {
    document: frozenDoc,
    attachments: new Map(),
  };

  const vfs = fs as unknown as LocalVfsClient;
  const bundled = new Map<string, Uint8Array>([
    ['/workspace/skills/browser/SKILL.md', new TextEncoder().encode(BUNDLED_SKILL)],
  ]);

  const deps: ProfileExportDeps = {
    vfs,
    listUnits: () => UNITS,
    createTranscriptSource: (knownSecrets) =>
      new DefaultTranscriptExportService({
        collection: {
          listScoops: () => UNITS as never,
          isProcessing: () => false,
          getAgentMessages: (jid) => MESSAGES[jid] ?? null,
          loadPersistedSessions: async () => [],
          loadUiChatSessions: async () => [
            { id: 'session-cone', messages: [UI_ATTACHMENT_MESSAGE], createdAt: 0, updatedAt: 0 },
          ],
          wait: async () => undefined,
        },
        knownSecrets,
        snapshotStore: {
          read: async (id) => (id === 'frozen-1' ? frozenSnapshot : null),
          write: async () => undefined,
        },
        vfs,
        getActiveSessionInfo: () => ({ id: 'cone_1', title: 'Sliccy' }),
        version: '6.0.0-test',
      }),
    knownSecrets: knownSecretsRedactor,
    accounts: () => [
      { providerId: 'anthropic', apiKey: SECRETS.anthropic },
      { providerId: 'openai', apiKey: SECRETS.openai },
      { providerId: 'mcp:linear', apiKey: '', accessToken: SECRETS.mcpToken },
    ],
    licks: async () => ({
      crontasks: [
        {
          id: 'cron-1',
          name: 'daily',
          cron: '0 9 * * *',
          scoop: 'research',
          nextRun: null,
          lastRun: null,
          status: 'active',
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      tasks: [
        {
          id: 'task-1',
          groupFolder: 'cone',
          prompt: 'check the build',
          scheduleType: 'interval',
          scheduleValue: '3600000',
          status: 'active',
          nextRun: null,
          lastRun: null,
          createdAt: '2026-10-01T00:00:00.000Z',
        },
      ],
      webhooks: [{ id: 'wh-1', name: 'deploys', createdAt: '2026-10-01T00:00:00.000Z' }],
    }),
    mcpServers: async () => ({
      servers: {
        linear: {
          url: 'https://mcp.linear.app/mcp',
          headers: { 'x-api-key': SECRETS.mcpHeader },
          auth: { providerId: 'mcp:linear' },
        },
      },
    }),
    mounts: async () => ['/mnt/project'],
    storedSecretKinds: async () => ['secrets-env'],
    githubToken: async () => SECRETS.github,
    gitconfig: async () =>
      `[user]\n\tname = Ada\n\temail = ada@example.com\n[github]\n\ttoken = ${SECRETS.github}\n`,
    bundledFile: async (path) => bundled.get(path) ?? null,
    version: '6.0.0-test',
    origin: 'https://www.sliccy.ai',
    now: () => new Date('2026-10-18T12:00:00.000Z'),
    randomUUID: () => '0b9d6c1e-3f4a-4b5c-8d6e-7f8091a2b3c4',
    ...overrides,
  };
  return { fs, deps };
}
