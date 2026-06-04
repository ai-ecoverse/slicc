/**
 * Wave B7 — Heavy harness (THROWAWAY).
 *
 * Verifies three assertions in a real browser with `slicc_opfs_vfs=opfs`:
 *   A1: Two-tab single-writer election (electOpfsLeader, BroadcastChannel).
 *   A2: Follower reads leader's worker OPFS via federated fs.request, AND
 *       follower's LFS shadow has NO orphan entry for the leader-written path.
 *   A3: Cherry/Tray read-through — exercised via the same `handleFsRequest`
 *       handler that backs the WebRTC `fs.request` tray wire (the WebRTC
 *       transport is simulated by a BroadcastChannel; the handler under
 *       test is the production tray-fs-handler).
 *
 * The harness boots in two tabs (?role=A first, ?role=B second). Each tab
 * stashes results in `localStorage[__waveB7Result_<role>]` and in
 * `globalThis.__waveB7Result`. The driver polls both.
 */

import { VirtualFS } from '../../src/fs/virtual-fs.js';
import { handleFsRequest } from '../../src/scoops/tray-fs-handler.js';
import { electOpfsLeader } from '../../src/ui/opfs-leader-election.js';

interface AssertResult {
  name: string;
  status: 'pass' | 'fail';
  detail?: string;
  observed?: unknown;
  expected?: unknown;
}

const role = (new URLSearchParams(location.search).get('role') ?? 'A').toUpperCase();
const COORD_CHANNEL = 'b7-coord';
const FS_CHANNEL = 'b7-fs-rpc';
const SHARED_PATH = '/shared/.welcomed';
const LFS_DB = `b7-lfs-shadow-${role}`;
const OPFS_DB = 'b7-opfs-shared';

const roleLabel = document.getElementById('role-label');
if (roleLabel) roleLabel.textContent = `(role=${role})`;

const results: AssertResult[] = [];
const root = document.getElementById('app')!;

function pass(name: string, detail?: string): void {
  results.push({ name, status: 'pass', detail });
}
function fail(name: string, observed: unknown, expected: unknown, detail?: string): void {
  results.push({ name, status: 'fail', observed, expected, detail });
}
function describeErr(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}
function render(): void {
  const lines = results.map((r) => {
    const icon = r.status === 'pass' ? '✅' : '❌';
    const detail = r.detail ? ` — ${r.detail}` : '';
    const obs =
      r.status === 'fail'
        ? `\n    observed: ${JSON.stringify(r.observed)}\n    expected: ${JSON.stringify(r.expected)}`
        : '';
    return `${icon} ${r.name}${detail}${obs}`;
  });
  root.innerHTML = `<pre>${lines.join('\n')}</pre>`;
}

function publish(extra: Record<string, unknown>): void {
  const payload = { role, ts: new Date().toISOString(), results, ...extra };
  localStorage.setItem(`__waveB7Result_${role}`, JSON.stringify(payload));
  (globalThis as Record<string, unknown>).__waveB7Result = payload;
}

async function waitForBroadcast<T>(
  channel: BroadcastChannel,
  predicate: (data: unknown) => T | null,
  timeoutMs: number
): Promise<T | null> {
  return new Promise<T | null>((resolve) => {
    const timer = setTimeout(() => {
      channel.removeEventListener('message', onMsg);
      resolve(null);
    }, timeoutMs);
    function onMsg(ev: MessageEvent): void {
      const result = predicate(ev.data);
      if (result !== null) {
        clearTimeout(timer);
        channel.removeEventListener('message', onMsg);
        resolve(result);
      }
    }
    channel.addEventListener('message', onMsg);
  });
}

interface CoordReady {
  type: 'b7-ready';
  role: string;
  isLeader: boolean;
  tabId: string;
}
interface CoordLeaderWrote {
  type: 'b7-leader-wrote';
  value: string;
}
interface FsRpcRequest {
  type: 'b7-fs.request';
  requestId: string;
  request: Parameters<typeof handleFsRequest>[1];
}
interface FsRpcResponse {
  type: 'b7-fs.response';
  requestId: string;
  responses: Awaited<ReturnType<typeof handleFsRequest>>;
}

async function runLeader(
  coord: BroadcastChannel,
  fsCh: BroadcastChannel,
  tabId: string
): Promise<void> {
  const vfs = await VirtualFS.create({ dbName: OPFS_DB, backend: 'opfs', wipe: true });

  fsCh.addEventListener('message', (ev) => {
    const data = ev.data as FsRpcRequest;
    if (data?.type !== 'b7-fs.request') return;
    void handleFsRequest(vfs, data.request).then((responses) => {
      const reply: FsRpcResponse = {
        type: 'b7-fs.response',
        requestId: data.requestId,
        responses,
      };
      fsCh.postMessage(reply);
    });
  });

  const readyMsg: CoordReady = { type: 'b7-ready', role, isLeader: true, tabId };
  coord.postMessage(readyMsg);

  const followerInfo = await waitForBroadcast<CoordReady>(
    coord,
    (d) => {
      const m = d as CoordReady;
      return m?.type === 'b7-ready' && m.role !== role ? m : null;
    },
    15_000
  );

  if (followerInfo) {
    pass(
      'B7.A1 leader sees follower readiness (election concluded with a peer)',
      `follower role=${followerInfo.role} isLeader=${followerInfo.isLeader}`
    );
  } else {
    fail(
      'B7.A1 leader sees follower readiness',
      { followerInfo },
      { followerInfo: 'CoordReady{ isLeader:false }' },
      'follower never broadcast readiness within 15s'
    );
  }
  render();

  const value = `B7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  try {
    await vfs.mkdir('/shared', { recursive: true });
    await vfs.writeFile(SHARED_PATH, value);
    const readback = await vfs.readTextFile(SHARED_PATH);
    if (readback === value) {
      pass('B7.A2-leader leader wrote /shared/.welcomed to worker OPFS', `value="${value}"`);
    } else {
      fail('B7.A2-leader OPFS readback mismatch', { readback }, { readback: value });
    }
  } catch (err) {
    fail('B7.A2-leader OPFS write threw', describeErr(err), 'no throw');
  }
  render();

  const wroteMsg: CoordLeaderWrote = { type: 'b7-leader-wrote', value };
  coord.postMessage(wroteMsg);

  try {
    const responses = await handleFsRequest(vfs, { op: 'readFile', path: SHARED_PATH });
    const first = responses[0];
    const content =
      first?.ok && first.data?.type === 'file' ? (first.data as { content: string }).content : null;
    if (content === value) {
      pass(
        'B7.A3 leader handleFsRequest readFile returns written content (tray FS handler under test)',
        `content="${content}", chunks=${responses.length}`
      );
    } else {
      fail('B7.A3 leader handleFsRequest content mismatch', { content }, { content: value });
    }
  } catch (err) {
    fail('B7.A3 leader handleFsRequest threw', describeErr(err), 'no throw');
  }
  render();

  publish({ isLeader: true, tabId, value });
}

async function runFollower(
  coord: BroadcastChannel,
  fsCh: BroadcastChannel,
  tabId: string,
  leaderTabId: string | undefined
): Promise<void> {
  pass(
    'B7.A1 follower lost election → read-only mode',
    `selfTabId=${tabId}, leaderTabId=${leaderTabId ?? '?'}`
  );
  render();

  const followerReady: CoordReady = { type: 'b7-ready', role, isLeader: false, tabId };
  coord.postMessage(followerReady);

  const value = await waitForBroadcast<string>(
    coord,
    (d) => {
      const m = d as CoordLeaderWrote;
      return m?.type === 'b7-leader-wrote' && typeof m.value === 'string' ? m.value : null;
    },
    20_000
  );
  if (!value) {
    fail(
      'B7.A2 follower waited for leader-write broadcast',
      { value },
      { value: 'string' },
      'leader never broadcast b7-leader-wrote within 20s'
    );
    publish({ isLeader: false, tabId, leaderTabId });
    return;
  }

  const lfsShadow = await VirtualFS.create({ dbName: LFS_DB, backend: 'lfs', wipe: true });
  let lfsOrphan: unknown = null;
  let lfsExists = false;
  try {
    lfsOrphan = await lfsShadow.readTextFile(SHARED_PATH);
    lfsExists = true;
  } catch (err) {
    lfsOrphan = describeErr(err);
  }
  await lfsShadow.dispose();

  const requestId = `b7-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const responsesP = new Promise<FsRpcResponse['responses'] | null>((resolve) => {
    const timer = setTimeout(() => {
      fsCh.removeEventListener('message', onMsg);
      resolve(null);
    }, 10_000);
    function onMsg(ev: MessageEvent): void {
      const d = ev.data as FsRpcResponse;
      if (d?.type !== 'b7-fs.response' || d.requestId !== requestId) return;
      clearTimeout(timer);
      fsCh.removeEventListener('message', onMsg);
      resolve(d.responses);
    }
    fsCh.addEventListener('message', onMsg);
    const reqMsg: FsRpcRequest = {
      type: 'b7-fs.request',
      requestId,
      request: { op: 'readFile', path: SHARED_PATH },
    };
    fsCh.postMessage(reqMsg);
  });
  const responses = await responsesP;
  const first = responses?.[0];
  const remoteContent =
    first?.ok && first.data?.type === 'file' ? (first.data as { content: string }).content : null;

  if (remoteContent === value && !lfsExists) {
    pass(
      'B7.A2 follower read leader OPFS via federated fs.request; no LFS-shadow orphan',
      `remote="${remoteContent}", lfsExists=${lfsExists} (${String(lfsOrphan)})`
    );
  } else {
    fail(
      'B7.A2 follower federated read OR no-orphan check failed',
      { remoteContent, lfsExists, lfsOrphan },
      { remoteContent: value, lfsExists: false }
    );
  }
  render();

  if (remoteContent === value) {
    pass(
      'B7.A3 follower → leader: handleFsRequest readFile content matches over BroadcastChannel (simulated WebRTC tray wire)',
      `content="${remoteContent}", note="WebRTC data channel simulated by BroadcastChannel; handler is production tray-fs-handler"`
    );
  } else {
    fail('B7.A3 follower federated readFile mismatch', { remoteContent }, { remoteContent: value });
  }
  render();

  publish({ isLeader: false, tabId, leaderTabId, remoteContent, lfsExists });
}

async function main(): Promise<void> {
  const claimDelay = role === 'A' ? 0 : 400;
  if (claimDelay) await new Promise((r) => setTimeout(r, claimDelay));

  const coord = new BroadcastChannel(COORD_CHANNEL);
  const fsCh = new BroadcastChannel(FS_CHANNEL);

  const electionResult = await electOpfsLeader({ logger: console });
  (globalThis as Record<string, unknown>).__slicc_opfs_leader = {
    isLeader: electionResult.isLeader,
    self: electionResult.self,
    leader: electionResult.leader,
  };
  const tabId = electionResult.self.tabId;
  const leaderTabId = electionResult.leader?.tabId;

  if (electionResult.isLeader) {
    await runLeader(coord, fsCh, tabId);
  } else {
    await runFollower(coord, fsCh, tabId, leaderTabId);
  }
}

main().catch((err) => {
  fail('B7 FATAL', describeErr(err), 'no throw', 'main() threw');
  render();
  publish({ fatal: describeErr(err) });
});
