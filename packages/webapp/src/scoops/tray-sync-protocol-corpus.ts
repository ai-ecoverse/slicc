/**
 * Golden-fixture corpus for the tray sync wire protocol (#1294 P0-2).
 *
 * One representative fixture per message variant, in BOTH directions, plus an
 * explicit iOS-mirror expectation for each. The mapped types below are the
 * enforcement: adding a variant to `LeaderToFollowerMessage` /
 * `FollowerToLeaderMessage` fails typecheck here until the variant gets a
 * fixture AND an explicit iOS decision — the exact drift that shipped
 * `theme.apply` silently dropped on iOS.
 *
 * The checked-in JSON derived from this module lives at
 * `packages/ios-app/SliccFollower/Tests/SliccFollowerTests/Fixtures/tray-sync-corpus.json`
 * and is decoded by BOTH test suites:
 *  - TS: `packages/webapp/tests/scoops/tray-sync-corpus.test.ts` asserts the
 *    JSON file matches this module (regenerate with
 *    `npx tsx packages/dev-tools/tools/generate-tray-sync-corpus.ts`).
 *  - Swift: `SyncProtocolCorpusTests.swift` decodes every entry and asserts
 *    the `ios` expectation against the real `SyncProtocol.swift` decoder.
 *
 * IMPORTANT: keep this module data-only (type-only imports) — the corpus
 * generator executes it under plain tsx, outside the Vite define environment.
 */

import type { FollowerToLeaderMessage, LeaderToFollowerMessage } from './tray-sync-protocol.js';

/**
 * What the iOS mirror must do with a leader→follower variant:
 * - `decoded`: `SyncProtocol.swift` decodes it to a real case (not `.unknown`).
 * - `unknown`: TS-only variant — iOS deliberately decodes it to `.unknown`.
 */
export type IosLeaderDecodeExpectation = 'decoded' | 'unknown';

/**
 * What the iOS mirror must do with a follower→leader variant:
 * - `decoded`: `SyncProtocol.swift` decodes it (iOS can also encode it).
 * - `undecodable`: TS-only variant iOS never originates — its decoder throws.
 */
export type IosFollowerDecodeExpectation = 'decoded' | 'undecodable';

type LeaderCorpus = {
  [K in LeaderToFollowerMessage['type']]: {
    ios: IosLeaderDecodeExpectation;
    message: Extract<LeaderToFollowerMessage, { type: K }>;
  };
};

type FollowerCorpus = {
  [K in FollowerToLeaderMessage['type']]: {
    ios: IosFollowerDecodeExpectation;
    message: Extract<FollowerToLeaderMessage, { type: K }>;
  };
};

export const LEADER_TO_FOLLOWER_CORPUS: LeaderCorpus = {
  snapshot: {
    ios: 'decoded',
    message: {
      type: 'snapshot',
      messages: [
        { id: 'm1', role: 'user', content: 'hello', timestamp: 1750000000000 },
        {
          id: 'm2',
          role: 'assistant',
          content: 'hi there',
          timestamp: 1750000001000,
          source: 'cone',
        },
      ],
      scoopJid: 'cone',
    },
  },
  snapshot_chunk: {
    ios: 'decoded',
    message: {
      type: 'snapshot_chunk',
      chunkData: '{"messages":[],"scoopJi',
      chunkIndex: 0,
      totalChunks: 2,
      scoopJid: 'cone',
    },
  },
  agent_event: {
    ios: 'decoded',
    message: {
      type: 'agent_event',
      event: { type: 'content_delta', messageId: 'm2', text: 'partial' },
      scoopJid: 'cone',
    },
  },
  user_message_echo: {
    ios: 'decoded',
    message: {
      type: 'user_message_echo',
      text: 'echoed',
      messageId: 'm3',
      scoopJid: 'cone',
      attachments: [
        {
          id: 'a1',
          name: 'notes.txt',
          mimeType: 'text/plain',
          size: 5,
          kind: 'text',
          text: 'notes',
        },
      ],
    },
  },
  status: { ios: 'decoded', message: { type: 'status', scoopStatus: 'processing' } },
  error: { ios: 'decoded', message: { type: 'error', error: 'boom' } },
  'scoops.list': {
    ios: 'decoded',
    message: {
      type: 'scoops.list',
      scoops: [
        {
          jid: 'cone',
          name: 'sliccy',
          folder: '/workspace',
          isCone: true,
          assistantLabel: 'Sliccy',
        },
      ],
      activeScoopJid: 'cone',
    },
  },
  'sprinkles.list': {
    ios: 'decoded',
    message: {
      type: 'sprinkles.list',
      sprinkles: [
        {
          name: 'todo',
          title: 'Todo',
          path: '/workspace/sprinkles/todo.shtml',
          open: true,
          autoOpen: false,
        },
      ],
    },
  },
  'sprinkle.content': {
    ios: 'decoded',
    message: {
      type: 'sprinkle.content',
      requestId: 'req-1',
      sprinkleName: 'todo',
      content: '<div>todo</div>',
      chunkIndex: 0,
      totalChunks: 1,
    },
  },
  'sprinkle.update': {
    ios: 'decoded',
    message: { type: 'sprinkle.update', sprinkleName: 'todo', data: { counter: 1 } },
  },
  'sprinkle.reloaded': {
    ios: 'decoded',
    message: { type: 'sprinkle.reloaded', sprinkleName: 'todo' },
  },
  'targets.registry': {
    ios: 'decoded',
    message: {
      type: 'targets.registry',
      targets: [
        {
          targetId: 'leader:tab1',
          localTargetId: 'tab1',
          runtimeId: 'leader',
          title: 'Example',
          url: 'https://example.com',
          isLocal: false,
          kind: 'browser',
        },
      ],
    },
  },
  'cdp.request': {
    ios: 'decoded',
    message: {
      type: 'cdp.request',
      requestId: 'cdp-1',
      localTargetId: 'tab1',
      method: 'Page.navigate',
      params: { url: 'https://example.com' },
      sessionId: 'sess-1',
    },
  },
  // Reply path for follower-originated CDP — iOS never originates, so its
  // mirror deliberately decodes these to `.unknown`.
  'cdp.response': {
    ios: 'unknown',
    message: { type: 'cdp.response', requestId: 'cdp-2', result: { ok: true } },
  },
  'cdp.event': {
    ios: 'unknown',
    message: { type: 'cdp.event', method: 'Page.frameNavigated', params: { frame: { id: 'f1' } } },
  },
  'tab.open': {
    ios: 'decoded',
    message: { type: 'tab.open', requestId: 'tab-1', url: 'https://example.com' },
  },
  'tab.opened': {
    ios: 'unknown',
    message: { type: 'tab.opened', requestId: 'tab-2', targetId: 'tab9' },
  },
  'tab.open.error': {
    ios: 'unknown',
    message: { type: 'tab.open.error', requestId: 'tab-3', error: 'blocked' },
  },
  'preview.open': {
    ios: 'decoded',
    message: { type: 'preview.open', requestId: 'prev-1', url: 'https://x.sliccy.now/' },
  },
  // Federated FS is TS-only (no VFS on iOS).
  'fs.request': {
    ios: 'unknown',
    message: {
      type: 'fs.request',
      requestId: 'fs-1',
      request: { op: 'readFile', path: '/workspace/notes.md', encoding: 'utf-8' },
    },
  },
  'fs.response': {
    ios: 'unknown',
    message: {
      type: 'fs.response',
      requestId: 'fs-2',
      response: { ok: true, data: { type: 'void' } },
    },
  },
  'cherry.slicc_event': {
    ios: 'decoded',
    message: {
      type: 'cherry.slicc_event',
      targetId: 'cherry-1',
      name: 'open-url',
      detail: { url: 'https://example.com' },
    },
  },
  'theme.apply': {
    ios: 'decoded',
    message: { type: 'theme.apply', themeJson: '{"accent":"#ff0066"}' },
  },
  hello: {
    ios: 'decoded',
    message: { type: 'hello', protocolVersion: 1, runtime: 'slicc-standalone' },
  },
  ping: { ios: 'decoded', message: { type: 'ping' } },
  pong: { ios: 'decoded', message: { type: 'pong' } },
};

export const FOLLOWER_TO_LEADER_CORPUS: FollowerCorpus = {
  user_message: {
    ios: 'decoded',
    message: { type: 'user_message', text: 'hello from follower', messageId: 'f-1' },
  },
  abort: { ios: 'decoded', message: { type: 'abort' } },
  request_snapshot: {
    ios: 'decoded',
    message: { type: 'request_snapshot', scoopJid: 'cone' },
  },
  'scoops.select': { ios: 'decoded', message: { type: 'scoops.select', scoopJid: 'cone' } },
  'sprinkles.refresh': { ios: 'decoded', message: { type: 'sprinkles.refresh' } },
  'sprinkle.fetch': {
    ios: 'decoded',
    message: { type: 'sprinkle.fetch', requestId: 'req-2', sprinkleName: 'todo' },
  },
  'sprinkle.lick': {
    ios: 'decoded',
    message: {
      type: 'sprinkle.lick',
      sprinkleName: 'todo',
      body: { clicked: true },
      targetScoop: 'cone',
    },
  },
  // TS-only: iOS has no lick sources; its decoder throws on these.
  lick: {
    ios: 'undecodable',
    message: {
      type: 'lick',
      event: {
        type: 'navigate',
        navigateUrl: 'https://www.sliccy.ai/handoff?handoff=x',
        timestamp: '2026-07-06T00:00:00Z',
        body: {},
      },
    },
  },
  'targets.advertise': {
    ios: 'decoded',
    message: {
      type: 'targets.advertise',
      targets: [
        {
          targetId: 'wk1',
          title: 'Hosted tab',
          url: 'https://example.com',
          kind: 'browser',
        },
      ],
      runtimeId: 'slicc-ios',
    },
  },
  // Follower-originated CDP / tab.open / FS are TS-only (iOS only responds).
  'cdp.request': {
    ios: 'undecodable',
    message: {
      type: 'cdp.request',
      requestId: 'cdp-3',
      targetRuntimeId: 'leader',
      localTargetId: 'tab1',
      method: 'Page.captureScreenshot',
    },
  },
  'cdp.response': {
    ios: 'decoded',
    message: { type: 'cdp.response', requestId: 'cdp-1', result: { frameId: 'f1' } },
  },
  'cdp.event': {
    ios: 'decoded',
    message: {
      type: 'cdp.event',
      method: 'Page.loadEventFired',
      params: { timestamp: 1 },
      sessionId: 'sess-1',
    },
  },
  'tab.open': {
    ios: 'undecodable',
    message: {
      type: 'tab.open',
      requestId: 'tab-4',
      targetRuntimeId: 'leader',
      url: 'https://example.com',
    },
  },
  'tab.opened': {
    ios: 'decoded',
    message: { type: 'tab.opened', requestId: 'tab-1', targetId: 'wk2' },
  },
  'tab.open.error': {
    ios: 'decoded',
    message: { type: 'tab.open.error', requestId: 'tab-1', error: 'load failed' },
  },
  'fs.request': {
    ios: 'undecodable',
    message: {
      type: 'fs.request',
      requestId: 'fs-3',
      targetRuntimeId: 'leader',
      request: { op: 'exists', path: '/workspace' },
    },
  },
  'fs.response': {
    ios: 'undecodable',
    message: {
      type: 'fs.response',
      requestId: 'fs-4',
      response: { ok: false, error: 'ENOENT', code: 'ENOENT' },
    },
  },
  'cherry.host_event': {
    ios: 'undecodable',
    message: {
      type: 'cherry.host_event',
      targetId: 'cherry-1',
      name: 'form-submitted',
      detail: { fields: 2 },
    },
  },
  hello: {
    ios: 'decoded',
    message: { type: 'hello', protocolVersion: 1, runtime: 'slicc-ios' },
  },
  ping: { ios: 'decoded', message: { type: 'ping' } },
  pong: { ios: 'decoded', message: { type: 'pong' } },
};

/** Stable JSON document shared with the Swift test suite. */
export function buildCorpusDocument(): {
  traySyncProtocolVersion: number;
  leaderToFollower: Array<{ type: string; ios: string; message: unknown }>;
  followerToLeader: Array<{ type: string; ios: string; message: unknown }>;
} {
  const flatten = (corpus: Record<string, { ios: string; message: { type: string } }>) =>
    Object.values(corpus)
      .map(({ ios, message }) => ({ type: message.type, ios, message: message as unknown }))
      .sort((a, b) => a.type.localeCompare(b.type));
  return {
    traySyncProtocolVersion: 1,
    leaderToFollower: flatten(LEADER_TO_FOLLOWER_CORPUS),
    followerToLeader: flatten(FOLLOWER_TO_LEADER_CORPUS),
  };
}
