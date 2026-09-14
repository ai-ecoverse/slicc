import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { ChatMessage } from '../scoops/chat-types.js';

export const SESSIONS_DIR = '/sessions';
export const SESSIONS_INDEX_PATH = '/sessions/index.json';

export interface FrozenSessionCost {
  total: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface FrozenSessionModel {
  model: string;
  cost: number;
  turns: number;
  tokens: number;
}

export interface FrozenSessionIndexEntry {
  filename: string;

  title: string;

  frozenAt: string;

  messageCount: number;

  cost?: FrozenSessionCost;

  models?: FrozenSessionModel[];

  sessionId?: string;

  icon?: string;

  pendingEnrichment?: boolean;

  memoryPending?: true;

  memoryCuratedAt?: string;

  memoryFailed?: string;

  memorySkipped?: true;

  pendingAttemptCount?: number;

  completeSnapshotUnavailable?: true;

  cone?: string;

  coneLabel?: string;

  live?: true;

  liveThrough?: number;

  compactions?: number;
}

export interface FrozenSessionArchive {
  id: string;
  title: string;
  frozenAt: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
  messages: ChatMessage[];
  cost?: FrozenSessionCost;
  models?: FrozenSessionModel[];

  cone?: string;

  coneLabel?: string;

  memorySkipped?: true;

  live?: true;

  liveThrough?: number;

  compactions?: number;
}

export async function readSessionsIndex(vfs: LocalVfsClient): Promise<FrozenSessionIndexEntry[]> {
  try {
    const raw = await vfs.readFile(SESSIONS_INDEX_PATH, { encoding: 'utf-8' });
    const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? (parsed as FrozenSessionIndexEntry[]) : [];
  } catch {
    return [];
  }
}

export function frozenSessionPath(entry: FrozenSessionIndexEntry): string {
  return `${SESSIONS_DIR}/${entry.filename}`;
}

export function parseFrozenArchive(
  markdown: string
): Pick<
  FrozenSessionArchive,
  | 'title'
  | 'messages'
  | 'cost'
  | 'models'
  | 'cone'
  | 'coneLabel'
  | 'memorySkipped'
  | 'live'
  | 'liveThrough'
  | 'compactions'
> & { id?: string; sidecar?: string } {
  let body = markdown;
  let title = 'Untitled';
  const meta: Pick<
    FrozenSessionArchive,
    | 'cost'
    | 'models'
    | 'cone'
    | 'coneLabel'
    | 'memorySkipped'
    | 'live'
    | 'liveThrough'
    | 'compactions'
  > & { id?: string; sidecar?: string } = {};

  const fmMatch = body.match(/^---\n([\s\S]*?)\n---\n+/);
  if (fmMatch) {
    body = body.slice(fmMatch[0].length);
    Object.assign(meta, parseFrontmatterMeta(fmMatch[1]));
    const titleLine = fmMatch[1].match(/^title:\s*(.+?)\s*$/m);
    if (titleLine) title = decodeFrontmatterString(titleLine[1]);
  }

  const dataMatch = body.match(/<!-- slicc:session-data\n([\s\S]*?)\n-->\n*/);
  if (dataMatch) {
    try {
      const restored = dataMatch[1].replace(/-- >/g, '-->');
      const parsed = JSON.parse(restored);
      if (Array.isArray(parsed)) {
        return { title, messages: parsed as ChatMessage[], ...meta };
      }
    } catch {}

    body = body.replace(/<!-- slicc:session-data\n[\s\S]*?\n-->\n*/, '');
  }

  if (meta.sidecar) {
    return { title, messages: [], ...meta };
  }

  body = body.replace(/^#\s+[^\n]*\n+/, '');

  return { title, messages: parseHeadingFallback(body), ...meta };
}

function parseFrontmatterMeta(
  frontmatter: string
): Pick<
  FrozenSessionArchive,
  | 'cost'
  | 'models'
  | 'cone'
  | 'coneLabel'
  | 'memorySkipped'
  | 'live'
  | 'liveThrough'
  | 'compactions'
> & { id?: string; sidecar?: string } {
  const meta: ReturnType<typeof parseFrontmatterMeta> = {};
  const cost = parseFrontmatterJson<FrozenSessionCost>(frontmatter, 'cost');
  const models = parseFrontmatterJson<FrozenSessionModel[]>(frontmatter, 'models');
  if (cost) meta.cost = cost;
  if (models) meta.models = models;

  const cone = frontmatter.match(/^cone:\s*(.+?)\s*$/m)?.[1];
  if (cone) meta.cone = cone;
  const coneLabel = frontmatter.match(/^coneLabel:\s*(.+?)\s*$/m)?.[1];
  if (coneLabel) meta.coneLabel = decodeFrontmatterString(coneLabel);

  if (/^memorySkipped:\s*true\s*$/m.test(frontmatter)) meta.memorySkipped = true;

  if (/^live:\s*true\s*$/m.test(frontmatter)) meta.live = true;

  const liveThrough = Number(frontmatter.match(/^liveThrough:\s*(\d+)\s*$/m)?.[1]);
  if (Number.isFinite(liveThrough) && liveThrough > 0) meta.liveThrough = liveThrough;
  const compactions = Number(frontmatter.match(/^compactions:\s*(\d+)\s*$/m)?.[1]);
  if (Number.isFinite(compactions) && compactions > 0) meta.compactions = compactions;
  const id = frontmatter.match(/^id:\s*(\S+)\s*$/m)?.[1];
  if (id) meta.id = id;

  const sidecar = frontmatter.match(/^sidecar:\s*(\S+)\s*$/m)?.[1];
  if (sidecar) meta.sidecar = sidecar;
  return meta;
}

function decodeFrontmatterString(raw: string): string {
  const value = raw.trim();
  if (!value.startsWith('"')) return value;
  try {
    const decoded = JSON.parse(value);
    if (typeof decoded === 'string') return decoded;
  } catch {}
  return value.replace(/^"|"$/g, '');
}

function parseFrontmatterJson<T>(frontmatter: string, key: string): T | undefined {
  const value = new RegExp(`^${key}:\\s*(.+?)\\s*$`, 'm').exec(frontmatter)?.[1];
  if (!value) return undefined;
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

function parseHeadingFallback(body: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const headingRe = /^## (User|Assistant)\s*\n/gm;
  const heads: { role: 'user' | 'assistant'; start: number; bodyStart: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = headingRe.exec(body)) !== null) {
    heads.push({
      role: m[1] === 'User' ? 'user' : 'assistant',
      start: m.index,
      bodyStart: m.index + m[0].length,
    });
  }
  for (let i = 0; i < heads.length; i++) {
    const end = i + 1 < heads.length ? heads[i + 1].start : body.length;
    const content = body.slice(heads[i].bodyStart, end).trim();
    messages.push({
      id: `frozen-${i}`,
      role: heads[i].role,
      content,
      timestamp: 0,
    });
  }
  return messages;
}
