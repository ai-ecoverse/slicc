import {
  extractHandoffFromWebRequest,
  type HandoffMatch,
  handoffFingerprint,
} from '@slicc/shared-ts';

import type { NavigateLickMsg } from '../../webapp/src/kernel/messages.js';
import { postLickToWelcomedLeaderPorts } from './bridge-sw.js';
import { focusLeaderTab } from './leader-tab-sw.js';

const HANDOFF_NOTIFICATION_ID_PREFIX = 'slicc-handoff-';
const HANDOFF_INSTRUCTION_SNIPPET_MAX = 150;

let handoffNotificationSeq = 0;

function truncateInstruction(text: string): string {
  if (text.length <= HANDOFF_INSTRUCTION_SNIPPET_MAX) return text;
  return `${text.slice(0, HANDOFF_INSTRUCTION_SNIPPET_MAX - 1)}…`;
}

const CONTROL_CHARS_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
  'g'
);

function sanitizeInstruction(text: string): string {
  return text.replace(CONTROL_CHARS_RE, ' ');
}

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

const notifiedHandoffFingerprints = new Set<string>();
const HANDOFF_NOTIFIED_FINGERPRINTS_KEY = 'slicc_handoff_notified_fingerprints';
const HANDOFF_NOTIFIED_FINGERPRINTS_MAX = 100;

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
    console.warn('[slicc-sw] handoff fingerprint read failed', err);
    readOk = false;
  }
  for (const seen of stored) notifiedHandoffFingerprints.add(seen);
  if (stored.includes(fingerprint)) return;
  showHandoffNotification(match, url);

  if (!readOk) return;
  stored.push(fingerprint);
  await chrome.storage.session.set({
    [HANDOFF_NOTIFIED_FINGERPRINTS_KEY]: stored.slice(-HANDOFF_NOTIFIED_FINGERPRINTS_MAX),
  });
}

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

  chrome.runtime.sendMessage({ source: 'service-worker' as const, payload }).catch(() => {});
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

export function installHandoffNotifications(): void {
  chrome.notifications.onClicked.addListener((notificationId: string) => {
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
