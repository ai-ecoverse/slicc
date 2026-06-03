/**
 * Slash commands surface SLICC actions and skill references in the chat
 * composer. Two kinds:
 *  - `action`: fires a UI action (e.g. open settings), strips the token.
 *  - `skill`:  inserts a `/<name>` reference as inline text; the agent
 *              reads it on send (skills are in the system prompt).
 * Triggered by a `/<word>` token at any word boundary.
 */

export type SlashCommandKind = 'action' | 'skill' | 'submenu';

export interface ActiveSlashToken {
  /** Text after the slash, up to the cursor (e.g. 'sett'). */
  prefix: string;
  /** Index of the leading '/' in the full text. */
  start: number;
  /** Cursor index (end of the token). */
  end: number;
}

const ACTIVE_TOKEN_RE = /(?:^|\s)\/([a-zA-Z][a-zA-Z0-9-]*)?$/;

/**
 * Find the slash-command token the cursor is currently within, if any.
 * The token must start at a word boundary (start of text or after
 * whitespace) so paths embedded in prose (`cd /tmp`) and slash-separated
 * paths (`/workspace/skills`) don't false-trigger.
 */
export function findActiveSlashToken(text: string, cursor: number): ActiveSlashToken | null {
  const before = text.slice(0, cursor);
  const m = ACTIVE_TOKEN_RE.exec(before);
  if (!m) return null;
  const prefix = m[1] ?? '';
  const start = cursor - (prefix.length + 1); // +1 for the leading '/'
  return { prefix, start, end: cursor };
}

export interface SlashCommandContext {
  chat: { addSystemMessage(content: string): void };
  actions: SlashCommandActions;
  isCone(): boolean;
  getRegistry(): SlashCommandRegistry;
}

export interface SlashCommandActions {
  newSession(): Promise<void>;
  freezeSession(): Promise<void>;
  clearChat(): Promise<void>;
  openSettings(): Promise<void>;
  openMemory(): Promise<void>;
  openFrozenSessions(): Promise<void>;
}

export interface SlashCommand {
  kind: SlashCommandKind;
  name: string;
  description: string;
  /** Action commands only. Fires the UI action. Skill refs have no run. */
  run?(ctx: SlashCommandContext): Promise<void>;
}

export interface SlashCommandRegistry {
  list(): SlashCommand[];
  get(name: string): SlashCommand | undefined;
  match(prefix: string): SlashCommand[];
}

const SKILLS_SUBMENU_RE = /(?:^|\s)\/skills\s+([a-zA-Z0-9-]*)$/;

export interface SkillSubmenuQuery {
  /** Text typed after `/skills ` (the filter), may be empty. */
  query: string;
  /** Index of the leading '/' of `/skills`. */
  start: number;
  /** Cursor index (end of the query). */
  end: number;
}

/**
 * Detect when the cursor is inside a `/skills <query>` region — the
 * second level of the skills submenu. Returns null otherwise.
 */
export function findSkillSubmenuQuery(text: string, cursor: number): SkillSubmenuQuery | null {
  const before = text.slice(0, cursor);
  const m = SKILLS_SUBMENU_RE.exec(before);
  if (!m) return null;
  const query = m[1] ?? '';
  const matchText = m[0];
  const leadingWs = matchText.length - matchText.trimStart().length; // 0 or 1
  const start = cursor - (matchText.length - leadingWs);
  return { query, start, end: cursor };
}

export function createSlashCommandRegistry(commands: SlashCommand[]): SlashCommandRegistry {
  const sorted = [...commands].sort((a, b) => a.name.localeCompare(b.name));
  const byName = new Map(sorted.map((c) => [c.name, c]));
  return {
    list: () => sorted,
    get: (name) => byName.get(name),
    match: (prefix) => sorted.filter((c) => c.name.startsWith(prefix)),
  };
}
