/**
 * Scenario 7 — SLICC's own leader tab (#2417 follow-up 3).
 *
 * The leader tab is the page that owns the `/cdp` socket. With `Network`
 * enabled on a session for it, Chrome reports that socket's own frames back as
 * `Network.webSocketFrame*` — the amplification that overflows swift-server's
 * 1,000-message inbound pump.
 *
 * `/leader` stands in for it: a page holding a busy WebSocket, opened with
 * `Target.createTarget` so `BrowserAPI` never attaches and the
 * `NavigationWatcher` is the only thing that can. It then navigates ITSELF to a
 * page serving a handoff `Link` header, which is the case a watcher that simply
 * detached from the app tab could not serve: by the time a re-attach could be
 * triggered, the document response that carried the header is gone.
 *
 * Expectation, per arm:
 *   guarded (`isOwnTab` wired)   — zero webSocketFrame events, handoff still seen
 *   unguarded (the old behaviour) — webSocketFrame events flow
 */
import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack } from '../stack.js';

const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';
/** Time the leader tab chatters before navigating itself away. */
const DWELL_MS = 1500;
/** Time allowed for the navigation and its handoff event to land. */
const SETTLE_MS = 2500;

export interface OwnTabArm {
  guarded: boolean;
  /** Inbound `Network.webSocketFrame*` events — the leader tab's whole cost. */
  webSocketFrameEvents: number;
  /** Verbs of the navigate licks the watcher emitted. */
  navigateVerbs: string[];
  /** Instructions carried by those licks. */
  navigateInstructions: string[];
}

export interface OwnTabResult {
  guarded: OwnTabArm;
  unguarded: OwnTabArm;
}

interface NavigationEventLike {
  verb?: string;
  instruction?: string;
}

async function runArm(guarded: boolean): Promise<OwnTabArm> {
  const chrome = await launchChrome();
  const site = await startSite();
  try {
    const linkHeader = `<>; rel="${HANDOFF_REL}"; title="armed in time"`;
    const dest = `${site.url}/page/dest?link=${encodeURIComponent(linkHeader)}`;
    const leaderUrl = `${site.url}/leader`;
    const seen: NavigationEventLike[] = [];
    const st = await buildStack(chrome.wsUrl, {
      navigationWatcher: true,
      onNavigation: (event) => seen.push(event as NavigationEventLike),
      ...(guarded ? { ownTabUrl: leaderUrl } : {}),
    });
    await st.transport.send('Target.createTarget', {
      url: `${leaderUrl}?goto=${encodeURIComponent(dest)}&after=${DWELL_MS}`,
    });
    // Count the WebSocket cost while the tab is still the app tab, before the
    // navigation away legitimately turns Network on in the guarded arm.
    await new Promise((r) => setTimeout(r, DWELL_MS));
    const webSocketFrameEvents =
      (st.counters.eventsByMethod.get('Network.webSocketFrameSent') ?? 0) +
      (st.counters.eventsByMethod.get('Network.webSocketFrameReceived') ?? 0);
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    st.stop();
    return {
      guarded,
      webSocketFrameEvents,
      navigateVerbs: seen.map((e) => e.verb ?? '?'),
      navigateInstructions: seen.map((e) => e.instruction ?? ''),
    };
  } finally {
    site.close();
    chrome.kill();
  }
}

export async function run(): Promise<OwnTabResult> {
  return { guarded: await runArm(true), unguarded: await runArm(false) };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await run(), null, 2));
}
