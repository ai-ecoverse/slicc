/**
 * Lick view helpers — per-channel icon, header label, preview extraction,
 * and body-stripping logic for the chat panel's `.lick` rows.
 *
 * Keeps the rendering rules for every lick channel in one place so the
 * chat panel just consumes descriptors. All helpers are pure.
 */

import {
  Webhook,
  CalendarClock,
  Sparkles,
  FolderSync,
  Compass,
  RotateCcw,
  Bell,
  IceCream,
  Hourglass,
} from 'lucide';
import type { ChatMessage } from './types.js';

type IconNode = [tag: string, attrs: Record<string, string | number>][];

/** Per-channel metadata driving the compact row + expanded body. */
export interface LickDescriptor {
  icon: IconNode;
  /** Label shown after the icon (e.g. "webhook", "cron"). Lowercase on
   *  purpose so it reads like a noun, matching the tool-call row. */
  label: string;
}

const DEFAULT: LickDescriptor = {
  icon: Bell as unknown as IconNode,
  label: 'event',
};

const DESCRIPTORS: Record<string, LickDescriptor> = {
  webhook: {
    icon: Webhook as unknown as IconNode,
    label: 'webhook',
  },
  cron: {
    icon: CalendarClock as unknown as IconNode,
    label: 'cron',
  },
  sprinkle: {
    icon: Sparkles as unknown as IconNode,
    label: 'sprinkle',
  },
  fswatch: {
    icon: FolderSync as unknown as IconNode,
    label: 'files',
  },
  navigate: {
    icon: Compass as unknown as IconNode,
    label: 'navigate',
  },
  'session-reload': {
    icon: RotateCcw as unknown as IconNode,
    label: 'reload',
  },
  'scoop-notify': {
    icon: IceCream as unknown as IconNode,
    label: 'scoop',
  },
  'scoop-idle': {
    icon: Hourglass as unknown as IconNode,
    label: 'idle',
  },
};

export function getLickDescriptor(msg: ChatMessage): LickDescriptor {
  const key = msg.channel ?? '';
  return DESCRIPTORS[key] ?? DEFAULT;
}

/** Matches the `[Xyz Event: name]` or `[Session Reload: name]` header
 *  the orchestrator prepends to each lick. Captures name + optional
 *  trailing code-fence opener so we can strip both cleanly. */
const HEADER_RE = /^\[([^\]:]+?)(?:\s+Event)?:\s*([^\]]+?)\]\s*\n?/;

/** Matches the `[@name completed]:` / `[@name idle]:` header that the
 *  orchestrator writes for scoop lifecycle licks. Captures the scoop
 *  label + keyword so the collapsed row surfaces "name completed"
 *  instead of the first body line. */
const SCOOP_HEADER_RE = /^\[@([^\]]+?)\s+(completed|idle)\]\s*:?\s*\n?/;

export interface ParsedLick {
  /** Human-readable event name (e.g. "github-push", "daily-digest",
   *  full URL for navigate). Used for the collapsed row preview. */
  preview: string;
  /** Content with the `[Xyz Event: name]` header removed so the expanded
   *  view does not repeat information already in the summary. */
  body: string;
}

/** Parse a lick message's content into { preview, body }. Falls back to
 *  the first non-empty line if the expected header pattern is missing.
 *  Recognizes both the generic `[Xyz Event: name]` header and the
 *  scoop-specific `[@name completed]` / `[@name idle]` headers. */
export function parseLickContent(content: string): ParsedLick {
  const scoopMatch = SCOOP_HEADER_RE.exec(content);
  if (scoopMatch) {
    return {
      preview: `${scoopMatch[1].trim()} ${scoopMatch[2]}`,
      body: content.slice(scoopMatch[0].length).replace(/^\s+/, ''),
    };
  }
  const match = HEADER_RE.exec(content);
  if (match) {
    return {
      preview: match[2].trim(),
      body: content.slice(match[0].length).replace(/^\s+/, ''),
    };
  }
  const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
  return {
    preview: firstLine.trim().slice(0, 80),
    body: content,
  };
}

/** Build the lucide SVG element for a channel. */
export function createLickIcon(msg: ChatMessage): SVGElement {
  const desc = getLickDescriptor(msg);
  return iconNodeToSvg(desc.icon);
}

function iconNodeToSvg(node: IconNode): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.setAttribute('width', '14');
  svg.setAttribute('height', '14');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  for (const [tag, attrs] of node) {
    const child = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [k, v] of Object.entries(attrs)) {
      child.setAttribute(k, String(v));
    }
    svg.appendChild(child);
  }
  return svg;
}
