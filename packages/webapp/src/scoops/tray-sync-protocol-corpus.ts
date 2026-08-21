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

import type {
  AgentEvent,
  ChatMessage,
  FollowerToLeaderMessage,
  LeaderToFollowerMessage,
  MessageAttachment,
  RemoteTargetInfo,
  ScoopSummary,
  SprinkleSummary,
  ToolCall,
  TrayFsRequest,
  TrayFsResponse,
  TrayTargetEntry,
} from '@slicc/shared-ts';
import { SLICC_HOSTED_ORIGIN, TRAY_SYNC_PROTOCOL_VERSION } from '@slicc/shared-ts';

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

/**
 * What the iOS mirror must do with an `AgentEvent` variant. The envelope
 * (`agent_event`) has a single fixture above, which only ever proved that ONE
 * event type decodes; this is the per-variant enforcement.
 * - `decoded`: `AgentEvent` in `SyncProtocol.swift` has a real case for it.
 * - `unknown`: no Swift case — it falls to `.unknown(type:)` and the payload
 *   is dropped. Asserted so the gap stays inventoried rather than silent.
 */
export type IosAgentEventExpectation = 'decoded' | 'unknown';

/**
 * What the iOS mirror must do with ONE field of a nested payload type.
 * - `mirrored`: the Swift struct has the property and a decode→encode
 *   round-trip preserves it.
 * - `dropped`: the Swift struct has no property for it, so the value is lost
 *   on arrival. Asserted (the round-trip must NOT produce it) so every known
 *   data-loss field is inventoried here instead of discovered in the field.
 * - `local`: never crosses the wire at all — transient UI/bridge state that
 *   the TS side strips before send. Excluded from the fixture.
 */
export type IosFieldExpectation = 'mirrored' | 'dropped' | 'local';

/**
 * Whether iOS mirrors a nested payload type at all.
 * - `mirrored`: a Swift struct exists; the Swift suite round-trips the sample.
 * - `absent`: no Swift type exists, so there is nothing to round-trip. A Swift
 *   test cannot assert the non-existence of a Swift type, so `absent` is held
 *   honest from the TS side instead — see `carriedBy`.
 */
export type IosPayloadExpectation = 'mirrored' | 'absent';

/**
 * Forces an explicit per-field iOS decision. `-?` strips optionality so an
 * OPTIONAL field added to `ChatMessage` (etc.) fails typecheck here until it
 * is classified — the field-level analogue of the variant maps below.
 */
type FieldExpectations<T> = { [K in keyof T]-?: IosFieldExpectation };

type NestedPayloadEntry<T> = {
  ios: IosPayloadExpectation;
  fields: FieldExpectations<T>;
  /** Must populate every non-`local` field; asserted by the vitest guard. */
  sample: T;
  /**
   * Required when `ios` is `absent`: every `Type.field` site that carries this
   * payload. Each must stay classified `dropped` while no Swift mirror exists.
   * This is what actually forces `absent` to be revisited — the moment Swift
   * learns to keep `ChatMessage.attachments`, that field is promoted to
   * `mirrored` and this cross-check fails until the payload is promoted too.
   */
  carriedBy?: string[];
};

/**
 * Per-variant `AgentEvent` entry. `fields` pushes the same field-level
 * enforcement one level BELOW the discriminator: without it, `content_done`
 * could carry `model` and `usage` (it does) while the variant still reads as
 * cleanly `decoded`, because Swift's `.contentDone(messageId:)` throws both
 * away and the discriminator check cannot see it.
 */
type AgentEventCorpus = {
  [K in AgentEvent['type']]: {
    ios: IosAgentEventExpectation;
    fields: FieldExpectations<Extract<AgentEvent, { type: K }>>;
    event: Extract<AgentEvent, { type: K }>;
  };
};

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
  // Transcript export response variants (leader → follower)
  // iOS decodes these to `.unknown` — it never requests exports
  'transcript.export.pending': {
    ios: 'unknown',
    message: { type: 'transcript.export.pending', requestId: 'te-1' },
  },
  'transcript.export.denied': {
    ios: 'unknown',
    message: { type: 'transcript.export.denied', requestId: 'te-1' },
  },
  'transcript.export.start': {
    ios: 'unknown',
    message: {
      type: 'transcript.export.start',
      requestId: 'te-1',
      filename: 'slicc-transcript.zip',
      estimatedBytes: 1024,
    },
  },
  'transcript.export.chunk': {
    ios: 'unknown',
    message: { type: 'transcript.export.chunk', requestId: 'te-1', index: 0, data: 'AQID' },
  },
  'transcript.export.complete': {
    ios: 'unknown',
    message: {
      type: 'transcript.export.complete',
      requestId: 'te-1',
      chunks: 1,
      byteLength: 3,
      sha256: 'a'.repeat(64),
    },
  },
  'transcript.export.error': {
    ios: 'unknown',
    message: { type: 'transcript.export.error', requestId: 'te-1', code: 'session-not-found' },
  },
  // Delegated sudo prompt (#2062): iOS renders it behind Face ID.
  'sudo.approve.request': {
    ios: 'decoded',
    message: {
      type: 'sudo.approve.request',
      requestId: 'sudo-1',
      kind: 'command',
      detail: 'git push origin main',
      suggestedPattern: 'git push *',
      scoopName: 'Researcher',
      expiresAt: 1750000300000,
    },
  },
  'sudo.approve.cancel': {
    ios: 'decoded',
    message: { type: 'sudo.approve.cancel', requestId: 'sudo-1' },
  },
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
  status: {
    ios: 'decoded',
    message: { type: 'status', scoopStatus: 'processing', scoopJid: 'cone' },
  },
  error: { ios: 'decoded', message: { type: 'error', error: 'boom' } },
  'scoops.list': {
    ios: 'decoded',
    message: {
      type: 'scoops.list',
      scoops: [
        // The cone deliberately keeps `state` ABSENT: that is what a leader
        // older than the lifecycle fields sends, and it must stay decodable.
        {
          jid: 'cone',
          name: 'sliccy',
          folder: '/workspace',
          isCone: true,
          parentId: null,
          assistantLabel: 'Sliccy',
        },
        // One scoop per state/activity pair the wire can carry, so a follower
        // that drops one fails here instead of rendering a quietly wrong face.
        // `state` stays the four legacy values every shipped follower already
        // switches on; `activity` is the refinement they ignore.
        {
          jid: 'thinker',
          name: 'thinker',
          folder: '/scoops/thinker',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Thinker',
          state: 'working',
          activity: 'thinking',
          fill: 48,
        },
        {
          jid: 'tooler',
          name: 'tooler',
          folder: '/scoops/tooler',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Tooler',
          state: 'working',
          activity: 'tool',
          fill: 61,
        },
        {
          jid: 'waiter',
          name: 'waiter',
          folder: '/scoops/waiter',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Waiter',
          state: 'idle',
          activity: 'awaiting',
          fill: 12,
        },
        {
          jid: 'resting',
          name: 'resting',
          folder: '/scoops/resting',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Resting',
          state: 'idle',
          fill: 5,
        },
        {
          jid: 'tester',
          name: 'tester',
          folder: '/scoops/tester',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Tester',
          state: 'broken',
          fill: 84,
        },
        {
          jid: 'booting',
          name: 'booting',
          folder: '/scoops/booting',
          isCone: false,
          parentId: 'cone',
          assistantLabel: 'Booting',
          state: 'initializing',
        },
      ],
      activeScoopJid: 'cone',
    },
  },
  'models.list': {
    ios: 'decoded',
    message: {
      type: 'models.list',
      models: [
        {
          providerName: 'Example Provider',
          modelId: 'example:reasoner',
          modelName: 'Reasoner',
          reasoning: true,
        },
      ],
    },
  },
  'model.state': {
    ios: 'decoded',
    message: {
      type: 'model.state',
      state: {
        activeModelId: 'example:reasoner',
        scoopJid: 'cone',
        thinkingLevel: 'xhigh',
        effortOverride: 'max',
      },
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
          icon: 'rocket',
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
    ios: 'decoded',
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
  // TS-only delegation (#1915): iOS has no permissions surface and no popup
  // model, so it never advertises `capabilities.oauthPopup` and a leader will
  // not route a login to it. Same pattern as transcript.export.approve.request.
  'oauth.popup.request': {
    ios: 'unknown',
    message: {
      type: 'oauth.popup.request',
      requestId: 'oauth-popup-1',
      url: 'https://github.com/login/oauth/authorize?client_id=abc&state=xyz',
    },
  },
  // iOS is an fs *requester*: it asks the leader's VFS for content. It serves
  // no filesystem of its own, so a leader-originated `fs.request` decodes only
  // so `AppState` can answer it with an error (the leader has no timeout).
  'fs.request': {
    ios: 'decoded',
    message: {
      type: 'fs.request',
      requestId: 'fs-1',
      request: { op: 'readFile', path: '/workspace/notes.md', encoding: 'utf-8' },
    },
  },
  'fs.response': {
    ios: 'decoded',
    message: {
      type: 'fs.response',
      requestId: 'fs-2',
      response: { ok: true, data: { type: 'void' } },
    },
  },
  // iOS mirrors the full exec wire surface for its leader-backed terminal and
  // accepts leader requests for its restricted, non-shell `open` verb.
  'exec.request': {
    ios: 'decoded',
    message: {
      type: 'exec.request',
      requestId: 'exec-1',
      command: 'echo hello',
      cwd: '/workspace',
    },
  },
  'exec.chunk': {
    ios: 'decoded',
    message: { type: 'exec.chunk', requestId: 'exec-1', stream: 'stdout', data: 'aGVsbG8K' },
  },
  'exec.response': {
    ios: 'decoded',
    message: { type: 'exec.response', requestId: 'exec-1', exitCode: 0 },
  },
  'exec.signal': {
    ios: 'decoded',
    message: { type: 'exec.signal', requestId: 'exec-1', signal: 'SIGINT' },
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
    message: {
      type: 'hello',
      protocolVersion: 1,
      runtime: 'slicc-standalone',
      capabilities: { exec: true },
      motd: 'macOS 15 via node-server',
    },
  },
  ping: { ios: 'decoded', message: { type: 'ping' } },
  pong: { ios: 'decoded', message: { type: 'pong' } },
};

export const FOLLOWER_TO_LEADER_CORPUS: FollowerCorpus = {
  // Transcript export request variants (follower → leader)
  // iOS never originates these — its decoder throws
  'transcript.export.request': {
    ios: 'undecodable',
    message: {
      type: 'transcript.export.request',
      requestId: 'te-2',
      selector: { kind: 'active' },
    },
  },
  'transcript.export.cancel': {
    ios: 'undecodable',
    message: { type: 'transcript.export.cancel', requestId: 'te-2' },
  },
  // TS-only: iOS never originates exports so it never sends acks.
  'transcript.export.ack': {
    ios: 'undecodable',
    message: { type: 'transcript.export.ack', requestId: 'te-2', index: 0 },
  },
  // iOS answers delegated sudo prompts after a Face ID / passcode gate (#2062).
  'sudo.approve.response': {
    ios: 'decoded',
    message: {
      type: 'sudo.approve.response',
      requestId: 'sudo-1',
      decision: 'always',
      pattern: 'git push *',
      attestation: 'biometric',
    },
  },
  // iOS registers its APNs token on every connect so the hub can wake it.
  'push.register': {
    ios: 'decoded',
    message: {
      type: 'push.register',
      platform: 'ios',
      token: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      environment: 'sandbox',
    },
  },
  user_message: {
    ios: 'decoded',
    message: {
      type: 'user_message',
      text: 'hello from follower',
      messageId: 'f-1',
      steer: true,
      attachments: [
        {
          id: 'p1',
          name: 'photo.jpg',
          mimeType: 'image/jpeg',
          size: 4,
          kind: 'image',
          data: 'aGk=',
        },
      ],
    },
  },
  abort: { ios: 'decoded', message: { type: 'abort' } },
  new_session: {
    ios: 'decoded',
    message: { type: 'new_session', action: 'save' },
  },
  request_snapshot: {
    ios: 'decoded',
    message: { type: 'request_snapshot', scoopJid: 'cone' },
  },
  'scoops.select': { ios: 'decoded', message: { type: 'scoops.select', scoopJid: 'cone' } },
  'models.request': { ios: 'decoded', message: { type: 'models.request' } },
  'model.select': {
    ios: 'decoded',
    message: { type: 'model.select', modelId: 'example:reasoner' },
  },
  'thinking.set': {
    ios: 'decoded',
    message: {
      type: 'thinking.set',
      scoopJid: 'cone',
      thinkingLevel: 'xhigh',
      effortOverride: 'max',
    },
  },
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
  // The iOS follower renders sprinkles but does not report its instances yet,
  // so its decoder has no case for this variant. `sprinkle list` therefore
  // under-reports iOS documents rather than inventing them.
  'sprinkle.instances': {
    ios: 'undecodable',
    message: { type: 'sprinkle.instances', sprinkles: ['todo', 'loose-ends'] },
  },
  // iOS sends navigate licks for handoffs advertised by pages in its hosted
  // CDP targets. Only the `FORWARDABLE_TO_LEADER` types (`navigate`,
  // `discovery`) are modelled — the leader rejects the rest.
  lick: {
    ios: 'decoded',
    message: {
      type: 'lick',
      event: {
        type: 'navigate',
        navigateUrl: `${SLICC_HOSTED_ORIGIN}/handoff?handoff=x`,
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
    ios: 'decoded',
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
  // iOS originates this from its tab carousel; its Network domain is real
  // (WKHTTPCookieStore), so a teleport there actually carries cookies.
  'tab.teleport.request': {
    ios: 'decoded',
    message: { type: 'tab.teleport.request', requestId: 'tp-1', targetId: 'leader:tab1' },
  },
  // The reply half of the delegated login. Carries the callback URL only —
  // access/refresh tokens never cross the tray.
  'oauth.popup.response': {
    ios: 'undecodable',
    message: {
      type: 'oauth.popup.response',
      requestId: 'oauth-popup-1',
      redirectUrl: `${SLICC_HOSTED_ORIGIN}/auth/callback?code=abc123&nonce=n1`,
    },
  },
  'fs.request': {
    ios: 'decoded',
    message: {
      type: 'fs.request',
      requestId: 'fs-3',
      targetRuntimeId: 'leader',
      request: { op: 'exists', path: '/workspace' },
    },
  },
  'fs.response': {
    ios: 'decoded',
    message: {
      type: 'fs.response',
      requestId: 'fs-4',
      response: { ok: false, error: 'ENOENT', code: 'ENOENT' },
    },
  },
  // iOS originates requests/signals for the leader-backed terminal and mirrors
  // chunks/responses for protocol symmetry and corpus round-trip enforcement.
  'exec.request': {
    ios: 'decoded',
    message: { type: 'exec.request', requestId: 'exec-2', command: 'ls -la' },
  },
  'exec.chunk': {
    ios: 'decoded',
    message: { type: 'exec.chunk', requestId: 'exec-2', stream: 'stderr', data: 'ZXJyb3IK' },
  },
  'exec.response': {
    ios: 'decoded',
    message: { type: 'exec.response', requestId: 'exec-2', exitCode: 1, error: 'boom' },
  },
  'exec.signal': {
    ios: 'decoded',
    message: { type: 'exec.signal', requestId: 'exec-2', signal: 'SIGKILL' },
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
    message: {
      type: 'hello',
      protocolVersion: 1,
      runtime: 'slicc-ios',
      capabilities: { exec: true, browser: true, sudoApproval: true, biometric: true },
      motd: 'SLICC iOS follower on iPhone (iOS 26.0) — only supported command: open',
    },
  },
  ping: { ios: 'decoded', message: { type: 'ping' } },
  pong: { ios: 'decoded', message: { type: 'pong' } },
};

/**
 * One fixture per `AgentEvent` variant. The mapped type is the enforcement:
 * adding a variant to `AgentEvent` fails typecheck here until it has a fixture
 * AND an explicit iOS decision.
 *
 * `broadcast.ts` forwards every agent event to followers unconditionally, so
 * "the leader never sends this one" is not an available excuse for any entry.
 */
export const AGENT_EVENT_CORPUS: AgentEventCorpus = {
  message_start: {
    ios: 'decoded',
    fields: { type: 'mirrored', messageId: 'mirrored' },
    event: { type: 'message_start', messageId: 'm2' },
  },
  content_delta: {
    ios: 'decoded',
    fields: { type: 'mirrored', messageId: 'mirrored', text: 'mirrored' },
    event: { type: 'content_delta', messageId: 'm2', text: 'partial' },
  },
  content_done: {
    ios: 'decoded',
    fields: {
      type: 'mirrored',
      messageId: 'mirrored',
      model: 'mirrored',
      usage: 'mirrored',
    },
    event: {
      type: 'content_done',
      messageId: 'm2',
      model: 'claude-opus-4-6',
      usage: {
        input: 1200,
        output: 340,
        cacheRead: 900,
        cacheWrite: 100,
        cost: {
          input: 0.0036,
          output: 0.0051,
          cacheRead: 0.00027,
          cacheWrite: 0.000375,
          total: 0.009345,
        },
      },
    },
  },
  tool_use_start: {
    ios: 'decoded',
    fields: {
      type: 'mirrored',
      messageId: 'mirrored',
      toolName: 'mirrored',
      toolInput: 'mirrored',
    },
    event: {
      type: 'tool_use_start',
      messageId: 'm2',
      toolName: 'read_file',
      toolInput: { path: '/workspace/notes.md' },
    },
  },
  tool_result: {
    ios: 'decoded',
    fields: {
      type: 'mirrored',
      messageId: 'mirrored',
      toolName: 'mirrored',
      result: 'mirrored',
      isError: 'mirrored',
    },
    event: {
      type: 'tool_result',
      messageId: 'm2',
      toolName: 'read_file',
      result: 'file contents',
      isError: false,
    },
  },
  // Tool-UI cards render as interactive HTML on the leader. A follower has no
  // permissions surface, so the browser follower shows a read-only "waiting on
  // the leader" placeholder; iOS decodes the payload but does not render it yet.
  tool_ui: {
    ios: 'decoded',
    fields: {
      type: 'mirrored',
      messageId: 'mirrored',
      toolName: 'mirrored',
      requestId: 'mirrored',
      html: 'mirrored',
    },
    event: {
      type: 'tool_ui',
      messageId: 'm2',
      toolName: 'ask_user',
      requestId: 'ui-1',
      html: '<div>approve?</div>',
    },
  },
  tool_ui_done: {
    ios: 'decoded',
    fields: { type: 'mirrored', messageId: 'mirrored', requestId: 'mirrored' },
    event: { type: 'tool_ui_done', messageId: 'm2', requestId: 'ui-1' },
  },
  turn_end: {
    ios: 'decoded',
    fields: { type: 'mirrored', messageId: 'mirrored' },
    event: { type: 'turn_end', messageId: 'm2' },
  },
  error: {
    ios: 'decoded',
    fields: { type: 'mirrored', error: 'mirrored' },
    event: { type: 'error', error: 'boom' },
  },
  // Both are deliberate render no-ops on every follower — the webapp chat
  // thread names them explicitly for exactly this reason. They still have to
  // DECODE, so that deleting a case is a compile error rather than a silent
  // regression, which is why the fields are `mirrored` and not `dropped`.
  screenshot: {
    ios: 'decoded',
    fields: { type: 'mirrored', base64: 'mirrored', url: 'mirrored' },
    event: { type: 'screenshot', base64: 'iVBORw0KGgo=', url: 'https://example.com' },
  },
  terminal_output: {
    ios: 'decoded',
    fields: { type: 'mirrored', text: 'mirrored' },
    event: { type: 'terminal_output', text: '$ ls\nnotes.md\n' },
  },
};

const CHAT_MESSAGE: NestedPayloadEntry<ChatMessage> = {
  ios: 'mirrored',
  fields: {
    id: 'mirrored',
    role: 'mirrored',
    content: 'mirrored',
    timestamp: 'mirrored',
    attachments: 'mirrored',
    toolCalls: 'mirrored',
    isStreaming: 'mirrored',
    model: 'mirrored',
    usage: 'mirrored',
    source: 'mirrored',
    channel: 'mirrored',
    lickCount: 'mirrored',
    lickParts: 'mirrored',
    lickId: 'mirrored',
    lickState: 'mirrored',
    queued: 'mirrored',
    error: 'mirrored',
  },
  sample: {
    id: 'm-full',
    role: 'assistant',
    content: 'every field populated',
    timestamp: 1750000002000,
    attachments: [
      { id: 'a1', name: 'notes.txt', mimeType: 'text/plain', size: 5, kind: 'text', text: 'notes' },
    ],
    toolCalls: [
      {
        id: 't1',
        name: 'read_file',
        input: { path: '/workspace/notes.md' },
        result: 'ok',
        isError: false,
      },
    ],
    isStreaming: false,
    model: 'claude-opus-4-6',
    usage: {
      input: 1200,
      output: 340,
      cacheRead: 900,
      cacheWrite: 100,
      cost: {
        input: 0.0036,
        output: 0.0051,
        cacheRead: 0.00027,
        cacheWrite: 0.000375,
        total: 0.009345,
      },
    },
    source: 'cone',
    channel: 'webhook',
    lickCount: 3,
    lickParts: ['first', 'second', 'third'],
    lickId: 'lick-1',
    lickState: 'pending',
    queued: false,
    error: false,
  },
};

const TOOL_CALL: NestedPayloadEntry<ToolCall> = {
  ios: 'mirrored',
  fields: {
    id: 'mirrored',
    name: 'mirrored',
    input: 'mirrored',
    result: 'mirrored',
    isError: 'mirrored',
    // Underscore-prefixed fields are stripped before persistence and before
    // send; they exist only inside one runtime's own UI pass.
    _screenshotDataUrl: 'local',
    _toolUIRequestId: 'local',
  },
  sample: {
    id: 't1',
    name: 'read_file',
    input: { path: '/workspace/notes.md' },
    result: 'file contents',
    isError: false,
  },
};

const MESSAGE_ATTACHMENT: NestedPayloadEntry<MessageAttachment> = {
  ios: 'mirrored',
  fields: {
    id: 'mirrored',
    name: 'mirrored',
    mimeType: 'mirrored',
    size: 'mirrored',
    kind: 'mirrored',
    data: 'mirrored',
    text: 'mirrored',
    path: 'mirrored',
    error: 'mirrored',
  },
  sample: {
    id: 'a1',
    name: 'shot.png',
    mimeType: 'image/png',
    size: 12,
    kind: 'image',
    data: 'iVBORw0KGgo=',
    text: 'alt text',
    path: '/tmp/attachment-a1.png',
    error: 'too large to inline',
  },
};

const SCOOP_SUMMARY: NestedPayloadEntry<ScoopSummary> = {
  ios: 'mirrored',
  fields: {
    jid: 'mirrored',
    name: 'mirrored',
    folder: 'mirrored',
    isCone: 'mirrored',
    parentId: 'mirrored',
    assistantLabel: 'mirrored',
    trigger: 'mirrored',
    state: 'mirrored',
    activity: 'mirrored',
    fill: 'mirrored',
  },
  sample: {
    jid: 'reviewer',
    name: 'reviewer',
    folder: '/scoops/reviewer',
    isCone: false,
    parentId: 'cone',
    assistantLabel: 'Reviewer',
    trigger: 'on-push',
    // A legacy state plus the refinement older builds never sent, so the
    // round trip proves both survive.
    state: 'idle',
    activity: 'awaiting',
    fill: 82,
  },
};

const SPRINKLE_SUMMARY: NestedPayloadEntry<SprinkleSummary> = {
  ios: 'mirrored',
  fields: {
    name: 'mirrored',
    title: 'mirrored',
    path: 'mirrored',
    open: 'mirrored',
    autoOpen: 'mirrored',
    icon: 'mirrored',
  },
  sample: {
    name: 'todo',
    title: 'Todo',
    path: '/workspace/sprinkles/todo.shtml',
    open: true,
    autoOpen: true,
    icon: 'rocket',
  },
};

const REMOTE_TARGET_INFO: NestedPayloadEntry<RemoteTargetInfo> = {
  ios: 'mirrored',
  fields: {
    targetId: 'mirrored',
    title: 'mirrored',
    url: 'mirrored',
    kind: 'mirrored',
    capabilities: 'mirrored',
  },
  sample: {
    targetId: 'wk1',
    title: 'Hosted tab',
    url: 'https://example.com',
    kind: 'cherry',
    capabilities: { navigate: true, network: false, screenshot: true },
  },
};

// The write variant is the richest arm of the request union, so it is the one
// that proves `content`/`encoding` survive alongside the common `op`/`path`.
const TRAY_FS_REQUEST: NestedPayloadEntry<Extract<TrayFsRequest, { op: 'writeFile' }>> = {
  ios: 'mirrored',
  fields: {
    op: 'mirrored',
    path: 'mirrored',
    content: 'mirrored',
    encoding: 'mirrored',
  },
  sample: {
    op: 'writeFile',
    path: '/tmp/upload/clip.mp4',
    content: 'AAECAwQ=',
    encoding: 'base64',
  },
};

// The chunked success arm: `chunkIndex`/`totalChunks` are what the client's
// reassembly depends on, so a mirror that dropped them would strand every
// large read on the timeout path instead of failing here.
const TRAY_FS_RESPONSE: NestedPayloadEntry<Extract<TrayFsResponse, { ok: true }>> = {
  ios: 'mirrored',
  fields: {
    ok: 'mirrored',
    data: 'mirrored',
    chunkIndex: 'mirrored',
    totalChunks: 'mirrored',
  },
  sample: {
    ok: true,
    data: { type: 'file', content: 'hello', encoding: 'utf-8' },
    chunkIndex: 0,
    totalChunks: 2,
  },
};

const TRAY_TARGET_ENTRY: NestedPayloadEntry<TrayTargetEntry> = {
  ios: 'mirrored',
  fields: {
    targetId: 'mirrored',
    localTargetId: 'mirrored',
    runtimeId: 'mirrored',
    title: 'mirrored',
    url: 'mirrored',
    isLocal: 'mirrored',
    kind: 'mirrored',
    capabilities: 'mirrored',
  },
  sample: {
    targetId: 'leader:tab1',
    localTargetId: 'tab1',
    runtimeId: 'leader',
    title: 'Example',
    url: 'https://example.com',
    isLocal: false,
    kind: 'cherry',
    capabilities: { navigate: true, network: false, screenshot: true },
  },
};

/**
 * Field-level coverage for the payload types nested INSIDE the message
 * variants. The variant maps above only ever proved that an envelope reaches a
 * real Swift case; a mirror can decode `snapshot` into a real `.snapshot` and
 * still throw away two thirds of every `ChatMessage` it carries — which is
 * exactly what happens today.
 *
 * Every entry pairs an explicit per-field expectation with a sample that
 * populates all of them, so the Swift suite can round-trip the sample and
 * prove which fields actually survive.
 */
export const NESTED_PAYLOAD_CORPUS = {
  ChatMessage: CHAT_MESSAGE,
  ToolCall: TOOL_CALL,
  MessageAttachment: MESSAGE_ATTACHMENT,
  ScoopSummary: SCOOP_SUMMARY,
  SprinkleSummary: SPRINKLE_SUMMARY,
  RemoteTargetInfo: REMOTE_TARGET_INFO,
  TrayTargetEntry: TRAY_TARGET_ENTRY,
  TrayFsRequest: TRAY_FS_REQUEST,
  TrayFsResponse: TRAY_FS_RESPONSE,
} as const;

/** Field names of a nested payload entry carrying the given expectation. */
function fieldsWith(
  entry: { fields: Record<string, IosFieldExpectation> },
  expectation: IosFieldExpectation
): string[] {
  return Object.entries(entry.fields)
    .filter(([, value]) => value === expectation)
    .map(([key]) => key)
    .sort();
}

/** Stable JSON document shared with the Swift test suite. */
export function buildCorpusDocument(): {
  traySyncProtocolVersion: number;
  leaderVariantCount: number;
  followerVariantCount: number;
  agentEventVariantCount: number;
  leaderToFollower: Array<{ type: string; ios: string; message: unknown }>;
  followerToLeader: Array<{ type: string; ios: string; message: unknown }>;
  agentEvents: Array<{
    type: string;
    ios: string;
    mirrored: string[];
    dropped: string[];
    event: unknown;
  }>;
  nestedPayloads: Array<{
    name: string;
    ios: string;
    mirrored: string[];
    dropped: string[];
    sample: unknown;
  }>;
} {
  const flatten = (corpus: Record<string, { ios: string; message: { type: string } }>) =>
    Object.values(corpus)
      .map(({ ios, message }) => ({ type: message.type, ios, message: message as unknown }))
      .sort((a, b) => a.type.localeCompare(b.type));
  return {
    // Read from the constant, never a literal: the Swift suite asserts this
    // equals its own `traySyncProtocolVersion`, so a hand-pinned copy here
    // would silently pass a stale version through a protocol bump.
    traySyncProtocolVersion: TRAY_SYNC_PROTOCOL_VERSION,
    // Mapped-type-enforced variant counts; the Swift suite asserts the entry
    // arrays match so a truncated/stale JSON copy fails loudly.
    leaderVariantCount: Object.keys(LEADER_TO_FOLLOWER_CORPUS).length,
    followerVariantCount: Object.keys(FOLLOWER_TO_LEADER_CORPUS).length,
    agentEventVariantCount: Object.keys(AGENT_EVENT_CORPUS).length,
    leaderToFollower: flatten(LEADER_TO_FOLLOWER_CORPUS),
    followerToLeader: flatten(FOLLOWER_TO_LEADER_CORPUS),
    agentEvents: Object.values(AGENT_EVENT_CORPUS)
      .map((entry) => ({
        type: entry.event.type,
        ios: entry.ios,
        mirrored: fieldsWith(entry, 'mirrored'),
        dropped: fieldsWith(entry, 'dropped'),
        event: entry.event as unknown,
      }))
      .sort((a, b) => a.type.localeCompare(b.type)),
    nestedPayloads: Object.entries(NESTED_PAYLOAD_CORPUS)
      .map(([name, entry]) => ({
        name,
        ios: entry.ios,
        mirrored: fieldsWith(entry, 'mirrored'),
        dropped: fieldsWith(entry, 'dropped'),
        sample: entry.sample as unknown,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  };
}
