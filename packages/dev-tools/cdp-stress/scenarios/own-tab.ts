import { launchChrome } from '../chrome.js';
import { startSite } from '../site.js';
import { buildStack } from '../stack.js';

const HANDOFF_REL = 'https://www.sliccy.ai/rel/handoff';

const DWELL_MS = 1500;

const SETTLE_MS = 2500;

export interface OwnTabArm {
  guarded: boolean;

  webSocketFrameEvents: number;

  navigateVerbs: string[];

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
