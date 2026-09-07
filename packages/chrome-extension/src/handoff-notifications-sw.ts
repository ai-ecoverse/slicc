/**
 * Handoff notifications + the RFC 8288 `Link`-header observer.
 *
 * Alerts the user when a main-frame document response advertises a SLICC
 * handoff via a `Link` header, forwards the handoff to the welcomed leader
 * Port(s) as an `extension.lick` envelope, and focuses the hosted leader tab
 * on notification click (a user gesture is required for the focus).
 *
 * Chrome extension API types provided by ./chrome.d.ts
 */

import {
  extractHandoffFromWebRequest,
  type HandoffMatch,
  handoffFingerprint,
} from '@slicc/shared-ts';
// `import type` only — see the import-boundary note in
// packages/chrome-extension/CLAUDE.md.
import type { NavigateLickMsg } from '../../webapp/src/kernel/messages.js';
import { postLickToWelcomedLeaderPorts } from './bridge-sw.js';
import { focusLeaderTab } from './leader-tab-sw.js';

const HANDOFF_NOTIFICATION_ID_PREFIX = 'slicc-handoff-';
const HANDOFF_INSTRUCTION_SNIPPET_MAX = 150;

// Distinguishes ids minted within the same millisecond — chrome.notifications
// treats create() with an existing id as an update, which would replace the
// earlier toast before the user sees it.
let handoffNotificationSeq = 0;

function truncateInstruction(text: string): string {
  if (text.length <= HANDOFF_INSTRUCTION_SNIPPET_MAX) return text;
  return `${text.slice(0, HANDOFF_INSTRUCTION_SNIPPET_MAX - 1)}…`;
}

// The instruction is attacker prose from the page's Link header; RFC 8187
// decoding can smuggle newlines/control characters that reshape the OS toast
// into something that reads as extension speech. Collapse them to spaces.
const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
  'g'
);

function sanitizeInstruction(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ');
}

// Attribute the toast prose to the page that advertised it, so it never
// reads as a message from the extension itself.
function handoffSourceLabel(sourceUrl: string): string {
  try {
    const origin = new URL(sourceUrl).origin;
    return origin === 'null' ? 'A page' : origin;
  } catch {
    return 'A page';
  }
}

function handoffNotificationContent(
  match: HandoffMatch,
  sourceUrl: string
): { title: string; message: string } {
  const source = handoffSourceLabel(sourceUrl);
  if (match.verb === 'upskill') {
    const repo = match.target.replace(/^https?:\/\//, '');
    const skill = match.path ? `${repo} (${match.path})` : repo;
    return {
      title: 'Slicc skill available',
      message: `${source} offers a skill: ${skill}. Click to open the Slicc leader tab.`,
    };
  }
  return {
    title: 'Slicc handoff received',
    message: match.instruction
      ? `${source} asks: ${truncateInstruction(sanitizeInstruction(match.instruction))} — click to open the Slicc leader tab.`
      : `${source} sent a handoff. Click to open the Slicc leader tab.`,
  };
}

function showHandoffNotification(match: HandoffMatch, sourceUrl: string): void {
  const notificationId = `${HANDOFF_NOTIFICATION_ID_PREFIX}${Date.now()}-${handoffNotificationSeq++}`;
  chrome.action.setBadgeText({ text: '!' });
  chrome.action.setBadgeBackgroundColor({ color: '#ff5f72' });
  chrome.notifications.create(notificationId, {
    type: 'basic',
    iconUrl: 'logos/sliccy-color-1scoops-128x128.png',
    ...handoffNotificationContent(match, sourceUrl),
  });
}

/**
 * Payload fingerprints of handoffs whose OS notification has already been
 * shown. A site can advertise the same SLICC `Link` rel on every page
 * response (e.g. a site-wide upskill); without this guard each navigation
 * re-shows the toast.
 *
 * Two layers: the in-memory set is the synchronous fast path within one
 * worker lifetime (a sighting is added before any await, so a burst of
 * navigations can't race past it). `chrome.storage.session` carries the set
 * across MV3 evictions — deliberately the same browser-session lifetime as
 * the receiver-side `seenNavigateFingerprints` dedup in the webapp's
 * LickManager. The stored list is capped; oldest entries drop first.
 *
 * IMPORTANT: this gates ONLY the notification — never the forward. The
 * forward (an `extension.lick` envelope over the welcomed leader Port(s), plus
 * the legacy `chrome.runtime.sendMessage` fallback) is best-effort and
 * silently drops when no port is welcomed yet (e.g. the leader tab still
 * booting). If we suppressed the forward on "seen", a first delivery that was
 * dropped before the leader was ready would lose the handoff permanently. So
 * we always forward and let the receiver dedup the cone turn.
 * See {@link handoffFingerprint}.
 */
const notifiedHandoffFingerprints = new Set<string>();
const HANDOFF_NOTIFIED_FINGERPRINTS_KEY = 'slicc_handoff_notified_fingerprints';
const HANDOFF_NOTIFIED_FINGERPRINTS_MAX = 100;

// Serializes the read-merge-write cycles below so two near-simultaneous
// sightings of different fingerprints can't clobber each other's write-back.
let handoffNotifyChain: Promise<void> = Promise.resolve();

function queueHandoffNotification(fingerprint: string, match: HandoffMatch, url: string): void {
  handoffNotifyChain = handoffNotifyChain
    .then(() => notifyHandoffOncePerSession(fingerprint, match, url))
    .catch((err) => {
      console.warn('[slicc-sw] handoff notification dedup failed', err);
    });
}

async function notifyHandoffOncePerSession(
  fingerprint: string,
  match: HandoffMatch,
  url: string
): Promise<void> {
  let stored: string[] = [];
  let readOk = true;
  try {
    const result = await chrome.storage.session.get(HANDOFF_NOTIFIED_FINGERPRINTS_KEY);
    const value = result[HANDOFF_NOTIFIED_FINGERPRINTS_KEY];
    if (Array.isArray(value)) stored = value.filter((v): v is string => typeof v === 'string');
  } catch (err) {
    // Storage read failure → fall back to in-memory-only dedup for this one.
    console.warn('[slicc-sw] handoff fingerprint read failed', err);
    readOk = false;
  }
  for (const seen of stored) notifiedHandoffFingerprints.add(seen);
  if (stored.includes(fingerprint)) return;
  showHandoffNotification(match, url);
  // Skip the write-back when the read failed — writing the fallback list
  // would replace every previously persisted fingerprint with this one.
  if (!readOk) return;
  stored.push(fingerprint);
  await chrome.storage.session.set({
    [HANDOFF_NOTIFIED_FINGERPRINTS_KEY]: stored.slice(-HANDOFF_NOTIFIED_FINGERPRINTS_MAX),
  });
}

/** Build the legacy `navigate-lick` payload for a sighted handoff. */
function buildNavigateLick(match: HandoffMatch, url: string, tabId: number): NavigateLickMsg {
  const payload: NavigateLickMsg = {
    type: 'navigate-lick',
    url,
    verb: match.verb,
    target: match.target,
    tabId: tabId >= 0 ? tabId : undefined,
  };
  if (match.instruction) payload.instruction = match.instruction;
  if (match.branch) payload.branch = match.branch;
  if (match.path) payload.path = match.path;
  return payload;
}

/**
 * Forward a sighted handoff to the leader.
 *
 * Primary path: push the lick over the live bridge Port(s) the welcomed leader
 * tab holds. The forward is ALWAYS attempted (never gated by the notification
 * fingerprint) so a handoff that arrived before the leader was ready isn't
 * lost; dedup of the resulting cone turn is the receiver's job. The envelope is
 * stamped per-port with that port's pinned channelId inside
 * `postLickToWelcomedLeaderPorts`.
 */
function dispatchHandoffLick(payload: NavigateLickMsg): void {
  postLickToWelcomedLeaderPorts({
    kind: 'extension.lick',
    verb: payload.verb,
    target: payload.target,
    url: payload.url,
    ...(payload.instruction ? { instruction: payload.instruction } : {}),
    ...(payload.branch ? { branch: payload.branch } : {}),
    ...(payload.path ? { path: payload.path } : {}),
    ...(payload.title ? { title: payload.title } : {}),
  });
  // Legacy best-effort broadcast. Retained as a harmless fallback: in thin
  // mode the leader tab has no in-page `chrome.runtime.onMessage` listener
  // for this, so it silently drops — but keeping it costs nothing and
  // covers any legacy/detached receiver that does listen.
  chrome.runtime.sendMessage({ source: 'service-worker' as const, payload }).catch(() => {
    // Leader may not be listening yet — best effort.
  });
}

function onHandoffHeaders(details: {
  url: string;
  tabId: number;
  responseHeaders?: Array<{ name: string; value?: string }>;
}): void {
  const { match } = extractHandoffFromWebRequest(details.responseHeaders, details.url);
  if (!match) return;
  const fingerprint = handoffFingerprint(match);
  const alreadyNotified = notifiedHandoffFingerprints.has(fingerprint);
  notifiedHandoffFingerprints.add(fingerprint);
  const payload = buildNavigateLick(match, details.url, details.tabId);
  const dispatch = (title?: string): void => {
    if (title) payload.title = title;
    dispatchHandoffLick(payload);
  };
  if (!alreadyNotified) queueHandoffNotification(fingerprint, match, details.url);
  if (details.tabId >= 0) {
    chrome.tabs
      .get(details.tabId)
      .then((tab) => dispatch(tab.title))
      .catch(() => dispatch());
  } else {
    dispatch();
  }
}

/**
 * Register the handoff `Link`-header observer and the notification-click
 * handler. MUST be installed before the discovery observer so the handoff
 * notification/forward path stays the first `onHeadersReceived` listener.
 */
export function installHandoffNotifications(): void {
  chrome.notifications.onClicked.addListener((notificationId: string) => {
    // Deterministic prefix check instead of an in-memory id set: MV3 can evict
    // the worker between showing the notification and the click, and a respawned
    // worker would not recognize ids minted by its predecessor.
    if (!notificationId.startsWith(HANDOFF_NOTIFICATION_ID_PREFIX)) return;
    chrome.action.setBadgeText({ text: '' });
    focusLeaderTab().catch(() => {});
  });

  chrome.webRequest.onHeadersReceived.addListener(
    onHandoffHeaders,
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['responseHeaders']
  );
}
