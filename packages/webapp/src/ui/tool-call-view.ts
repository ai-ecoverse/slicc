/**
 * Tool-call view helpers — per-tool icon, preview summary, and expanded body.
 *
 * The chat panel delegates here so the rendering logic for every tool lives
 * in one file instead of being sprinkled through `chat-panel.ts`. All helpers
 * are pure: they take a `ToolCall` and return DOM nodes or strings.
 */

import {
  IceCreamCone,
  FileText,
  FilePen,
  FilePlus,
  Terminal,
  Globe,
  Code2,
  MessageCircle,
  Send,
  Trash2,
  List,
  ListChecks,
  BrainCog,
  UserRoundPlus,
  UtensilsCrossed,
  Clock,
  Wrench,
} from 'lucide';
import type { ToolCall } from './types.js';
import { escapeHtml } from './message-renderer.js';

type IconNode = [tag: string, attrs: Record<string, string | number>][];

/** Per-tool metadata driving the compact row + expanded body. */
interface ToolDescriptor {
  icon: IconNode;
  /** Short lowercase noun describing the action, used as the row title. */
  title: string;
  /** Returns the inline summary shown to the right of the title. */
  preview: (input: unknown) => string;
  /** Optional custom expanded-body renderer. Falls back to YAML rendering. */
  renderBody?: (tc: ToolCall) => HTMLElement;
}

const FALLBACK: ToolDescriptor = {
  icon: Wrench as unknown as IconNode,
  title: 'tool',
  preview: (input) => shortValue(input, 80),
};

const DESCRIPTORS: Record<string, ToolDescriptor> = {
  read_file: {
    icon: FileText as unknown as IconNode,
    title: 'read',
    preview: (input) => getField(input, 'path') ?? '',
    // Path already in the collapsed preview — the expanded body only
    // needs to show what the file returned (or the error).
    renderBody: renderResultOnlyBody,
  },
  write_file: {
    icon: FilePlus as unknown as IconNode,
    title: 'write',
    preview: (input) => getField(input, 'path') ?? '',
  },
  edit_file: {
    icon: FilePen as unknown as IconNode,
    title: 'edit',
    preview: (input) => getField(input, 'path') ?? '',
    renderBody: renderEditBody,
  },
  bash: {
    icon: Terminal as unknown as IconNode,
    title: 'bash',
    preview: (input) => {
      const cmd = getField(input, 'command') ?? '';
      return cmd ? `$ ${truncate(cmd, 120)}` : '';
    },
    renderBody: renderBashBody,
  },
  browser: {
    icon: Globe as unknown as IconNode,
    title: 'browser',
    preview: (input) => shortValue(input, 80),
  },
  javascript: {
    icon: Code2 as unknown as IconNode,
    title: 'javascript',
    preview: (input) => {
      const code = getField(input, 'code') ?? '';
      return truncate(code.replace(/\s+/g, ' '), 100);
    },
  },
  send_message: {
    icon: MessageCircle as unknown as IconNode,
    title: 'message',
    preview: (input) => {
      const text = getField(input, 'text') ?? '';
      return text ? `"${truncate(text, 100)}"` : '';
    },
  },
  feed_scoop: {
    icon: UtensilsCrossed as unknown as IconNode,
    title: 'feed',
    preview: (input) => getField(input, 'scoop_name') ?? '',
  },
  scoop_scoop: {
    icon: IceCreamCone as unknown as IconNode,
    title: 'scoop',
    preview: (input) => getField(input, 'name') ?? '',
  },
  drop_scoop: {
    icon: Trash2 as unknown as IconNode,
    title: 'drop',
    preview: (input) => getField(input, 'scoop_name') ?? '',
  },
  list_scoops: {
    icon: List as unknown as IconNode,
    title: 'list scoops',
    preview: () => '',
  },
  list_tasks: {
    icon: ListChecks as unknown as IconNode,
    title: 'list tasks',
    preview: () => '',
  },
  register_scoop: {
    icon: UserRoundPlus as unknown as IconNode,
    title: 'register',
    preview: (input) => getField(input, 'name') ?? '',
  },
  schedule_task: {
    icon: Clock as unknown as IconNode,
    title: 'schedule',
    preview: (input) => getField(input, 'cron') ?? getField(input, 'name') ?? '',
  },
  update_global_memory: {
    icon: BrainCog as unknown as IconNode,
    title: 'memory',
    preview: (input) => {
      const content = getField(input, 'content') ?? '';
      const firstLine = content.split('\n').find((l) => l.trim().length > 0) ?? '';
      return truncate(firstLine, 100);
    },
  },
  delegate_to_scoop: {
    icon: Send as unknown as IconNode,
    title: 'delegate',
    preview: (input) => getField(input, 'scoop_name') ?? '',
  },
};

/** Public entry point: returns the metadata used to render a tool call. */
export function getToolDescriptor(name: string): ToolDescriptor {
  return DESCRIPTORS[name] ?? { ...FALLBACK, title: name };
}

/** Status variants for the colored circle indicator. */
export type ToolStatus = 'running' | 'success' | 'error' | 'other';

/** Classify a ToolCall into a status bucket. */
export function toolStatus(tc: ToolCall): ToolStatus {
  if (tc.result === undefined) return 'running';
  if (tc.isError) return 'error';
  return 'success';
}

/** Build the icon element for the collapsed row. */
export function createToolIcon(name: string): SVGElement {
  const desc = getToolDescriptor(name);
  return iconNodeToSvg(desc.icon);
}

/** Build the expanded body for a tool call. Custom bodies for bash/edit_file
 *  fall through to the YAML renderer when inputs are missing. */
export function createToolBody(tc: ToolCall): HTMLElement {
  const desc = getToolDescriptor(tc.name);
  if (desc.renderBody) {
    try {
      return desc.renderBody(tc);
    } catch {
      // fall through to default
    }
  }
  return renderDefaultBody(tc);
}

// ── helpers ─────────────────────────────────────────────────────────

function getField(input: unknown, key: string): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = (input as Record<string, unknown>)[key];
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return undefined;
}

function shortValue(input: unknown, max: number): string {
  if (input === undefined || input === null) return '';
  if (typeof input === 'string') return truncate(input, max);
  try {
    return truncate(JSON.stringify(input), max);
  } catch {
    return truncate(String(input), max);
  }
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trimEnd() + '…';
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

// ── body renderers ──────────────────────────────────────────────────

function renderDefaultBody(tc: ToolCall): HTMLElement {
  const body = document.createElement('div');
  body.className = 'tool-call__body';

  if (tc.input !== undefined) {
    body.appendChild(renderYamlInput(tc.input));
  }
  if (tc.result !== undefined) {
    body.appendChild(renderResultPre(tc));
  }
  return body;
}

/** Used by tools whose only interesting input is already mirrored in the
 *  collapsed preview (read_file → path). Skip the YAML echo and only show
 *  what the tool returned. */
function renderResultOnlyBody(tc: ToolCall): HTMLElement {
  const body = document.createElement('div');
  body.className = 'tool-call__body';
  if (tc.result !== undefined) {
    body.appendChild(renderResultPre(tc));
  }
  return body;
}

function renderResultPre(tc: ToolCall): HTMLPreElement {
  const resultEl = document.createElement('pre');
  resultEl.className = `tool-call__result${tc.isError ? ' tool-call__result--error' : ''}`;
  resultEl.textContent = tc.result ?? '';
  return resultEl;
}

/** Render input as a YAML-like block with colored keys. Arrays render as
 *  bullet lists, nested objects indent one level deeper. */
function renderYamlInput(input: unknown): HTMLElement {
  const pre = document.createElement('pre');
  pre.className = 'tool-call__yaml';
  pre.innerHTML = yamlHtml(input, 0);
  return pre;
}

function yamlHtml(value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  if (value === null || value === undefined) {
    return `${pad}<span class="tool-call__yaml-null">~</span>`;
  }
  if (typeof value === 'string') {
    return renderStringValue(value, indent);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return `${pad}<span class="tool-call__yaml-scalar">${escapeHtml(String(value))}</span>`;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) return `${pad}<span class="tool-call__yaml-scalar">[]</span>`;
    return value
      .map((item) => {
        if (isPrimitive(item)) {
          return `${pad}- ${inlinePrimitive(item)}`;
        }
        const inner = yamlHtml(item, indent + 1).replace(/^\s+/, '');
        return `${pad}- ${inner}`;
      })
      .join('\n');
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return `${pad}<span class="tool-call__yaml-scalar">{}</span>`;
    return entries.map(([k, v]) => renderKeyValue(k, v, indent)).join('\n');
  }
  return `${pad}${escapeHtml(String(value))}`;
}

function renderKeyValue(key: string, value: unknown, indent: number): string {
  const pad = '  '.repeat(indent);
  const keyHtml = `<span class="tool-call__yaml-key">${escapeHtml(key)}</span>`;
  if (isPrimitive(value)) {
    return `${pad}${keyHtml}: ${inlinePrimitive(value)}`;
  }
  if (Array.isArray(value) && value.length === 0) {
    return `${pad}${keyHtml}: <span class="tool-call__yaml-scalar">[]</span>`;
  }
  if (typeof value === 'object' && value && Object.keys(value).length === 0) {
    return `${pad}${keyHtml}: <span class="tool-call__yaml-scalar">{}</span>`;
  }
  return `${pad}${keyHtml}:\n${yamlHtml(value, indent + 1)}`;
}

function isPrimitive(v: unknown): boolean {
  return v === null || v === undefined || typeof v !== 'object';
}

function inlinePrimitive(v: unknown): string {
  if (v === null || v === undefined) return '<span class="tool-call__yaml-null">~</span>';
  if (typeof v === 'string') {
    if (v.includes('\n')) {
      // inline form — fall back to block string (handled by caller via
      // renderStringValue when not primitive context). For safety we show
      // the first line + ellipsis here; full multi-line strings land on
      // their own indent level via renderKeyValue's recursion.
      const first = v.split('\n')[0];
      return `<span class="tool-call__yaml-string">${escapeHtml(first)}</span><span class="tool-call__yaml-scalar">…</span>`;
    }
    return `<span class="tool-call__yaml-string">${escapeHtml(v)}</span>`;
  }
  return `<span class="tool-call__yaml-scalar">${escapeHtml(String(v))}</span>`;
}

function renderStringValue(value: string, indent: number): string {
  const pad = '  '.repeat(indent);
  if (!value.includes('\n')) {
    return `${pad}<span class="tool-call__yaml-string">${escapeHtml(value)}</span>`;
  }
  // multi-line block string using YAML literal `|` indicator.
  const lines = value
    .split('\n')
    .map((l) => `${pad}  <span class="tool-call__yaml-string">${escapeHtml(l)}</span>`)
    .join('\n');
  return `${pad}<span class="tool-call__yaml-scalar">|</span>\n${lines}`;
}

// ── bash terminal body ──────────────────────────────────────────────

function renderBashBody(tc: ToolCall): HTMLElement {
  const cmd = getField(tc.input, 'command') ?? '';
  const body = document.createElement('div');
  body.className = 'tool-call__terminal';

  const prompt = document.createElement('div');
  prompt.className = 'tool-call__terminal-prompt';
  prompt.innerHTML =
    `<span class="tool-call__terminal-sigil">$</span> ` +
    `<span class="tool-call__terminal-cmd">${escapeHtml(cmd)}</span>`;
  body.appendChild(prompt);

  if (tc.result !== undefined) {
    const out = document.createElement('pre');
    out.className = `tool-call__terminal-output${tc.isError ? ' tool-call__terminal-output--error' : ''}`;
    out.textContent = tc.result;
    body.appendChild(out);
  } else {
    const pending = document.createElement('div');
    pending.className = 'tool-call__terminal-pending';
    pending.textContent = '…';
    body.appendChild(pending);
  }
  return body;
}

// ── edit_file diff body ─────────────────────────────────────────────

function renderEditBody(tc: ToolCall): HTMLElement {
  const oldStr = getField(tc.input, 'old_str') ?? '';
  const newStr = getField(tc.input, 'new_str') ?? '';

  const body = document.createElement('div');
  body.className = 'tool-call__body';

  // Path is already shown in the collapsed preview — no need to repeat it.
  const diff = document.createElement('pre');
  diff.className = 'tool-call__diff';
  const oldLines = oldStr.split('\n');
  const newLines = newStr.split('\n');
  const rows: string[] = [];
  for (const line of oldLines) {
    rows.push(`<span class="tool-call__diff-del">- ${escapeHtml(line)}</span>`);
  }
  for (const line of newLines) {
    rows.push(`<span class="tool-call__diff-add">+ ${escapeHtml(line)}</span>`);
  }
  diff.innerHTML = rows.join('\n');
  body.appendChild(diff);

  if (tc.result !== undefined) {
    body.appendChild(renderResultPre(tc));
  }
  return body;
}
