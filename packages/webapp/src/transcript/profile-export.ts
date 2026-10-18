/**
 * SLICC 7 profile export ("Export for SLICC 7", `export-profile`).
 *
 * Collects one six origin's profile into `slicc-profile` v1 zips (the format
 * lives in `@slicc/shared-ts` `profile-export.ts`; reference:
 * `docs/profile-export.md`). It reuses the transcript export pipeline — per
 * cone `snapshotCone`, per frozen session `snapshotFrozen` — and the stored
 * ZIP writer, and adds the VFS walk, the skip and flag rules, memory, skills,
 * sprinkles and licks.
 *
 * Two phases, so the dialog can show what will be written before anything is:
 *
 * 1. {@link planProfileExport} reads and redacts everything once, hashes each
 *    entry, and builds every manifest. Redacted bytes are kept only where
 *    redaction changed them; every other file is re-read when written.
 * 2. {@link ProfileArchivePlan.open} streams one archive. A re-read file whose
 *    hash no longer matches its manifest entry fails the export.
 *
 * Never exported (G8): provider keys and tokens, `secrets.env`, the GitHub
 * token, MCP tokens and `/mnt` handles. Only provider ids, MCP server names
 * and URLs, and which secret kinds six had reach the manifest.
 */

import {
  PROFILE_FOLDER_PATTERN,
  PROFILE_MANIFEST_PATH,
  PROFILE_MAX_ARCHIVE_BYTES,
  PROFILE_MAX_ARCHIVE_ENTRIES,
  PROFILE_MAX_FILE_BYTES,
  PROFILE_MAX_REDACTED_TEXT_BYTES,
  type ProfileConeEntry,
  type ProfileFlaggedEntry,
  type ProfileFrozenEntry,
  type ProfileMcpServer,
  type ProfileNamedPath,
  type ProfileSecretKind,
  type ProfileSkippedEntry,
  profileArchiveFilename,
  profileFlagRuleFor,
  SLICC_PROFILE_FORMAT,
  SLICC_PROFILE_VERSION,
  type SliccProfileManifestV1,
  sha256Hex,
  slugify,
  type TranscriptDocumentV1,
  validateSliccProfileManifestV1,
  validateTranscriptDocumentV1,
} from '@slicc/shared-ts';
import { matchLickTargetAlias } from '../base/lick-target-match.js';
import type { DirEntry } from '../fs/types.js';
import type { LocalVfsClient } from '../kernel/local-vfs-client.js';
import type { CronTaskEntry, WebhookEntry } from '../scoops/lick-manager.js';
import type { RegisteredScoop, ScheduledTask } from '../scoops/types.js';
import { conversationKeyFor } from '../work-unit/conversation/key.js';
import { workspaceFor } from '../work-unit/descriptor.js';
import { isRootUnit, subtreeOf } from '../work-unit/policy.js';
import { isPrimaryRoot } from '../work-unit/record.js';
import type { TranscriptSnapshot } from './export-service.js';
import { readSessionsIndex } from './frozen-archive-format.js';
import {
  literalSecretsRedactor,
  MIN_LITERAL_SECRET_LENGTH,
  redactProfileTexts,
} from './profile-redact.js';
import type { KnownSecretBatchRedactor } from './redact.js';
import { createZipStream, type ZipEntrySource, type ZipStreamResult } from './zip-stream.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

/** A unit as the exporter needs it. */
export type ProfileUnit = Pick<RegisteredScoop, 'jid' | 'name' | 'folder' | 'parentJid'>;

/** One `slicc_accounts` row: the id is exported, the secrets only redacted. */
export interface ProfileAccount {
  providerId: string;
  apiKey?: string;
  accessToken?: string;
  refreshToken?: string;
}

/** `servers.json` as far as the exporter reads it. */
export interface ProfileMcpServersFile {
  servers: {
    [name: string]: { url: string; headers?: { [header: string]: string }; auth?: unknown };
  };
}

export interface ProfileLicks {
  crontasks: readonly CronTaskEntry[];
  tasks: readonly ScheduledTask[];
  webhooks: readonly WebhookEntry[];
}

/** The transcript side, built over the composed (page-secret-aware) redactor. */
export interface ProfileTranscriptSource {
  snapshotCone(
    cone: { jid: string; name: string },
    signal?: AbortSignal
  ): Promise<TranscriptSnapshot>;
  snapshotFrozen(sessionId: string, signal?: AbortSignal): Promise<TranscriptSnapshot>;
}

export interface ProfileExportDeps {
  vfs: Pick<LocalVfsClient, 'readDir' | 'readFile' | 'stat'>;
  listUnits(): readonly ProfileUnit[];
  createTranscriptSource(knownSecrets: KnownSecretBatchRedactor): ProfileTranscriptSource;
  knownSecrets: KnownSecretBatchRedactor;
  accounts(): readonly ProfileAccount[];
  licks(): Promise<ProfileLicks>;
  mcpServers(): Promise<ProfileMcpServersFile | null>;
  /** Mount target paths (`/mnt/x`, …); never walked. */
  mounts(): Promise<readonly string[]>;
  /** `secrets-env` / `chrome-storage` when six's secret store holds any. */
  storedSecretKinds(): Promise<readonly ProfileSecretKind[]>;
  githubToken(): Promise<string | null>;
  /** The global `.gitconfig` text, or null. */
  gitconfig(): Promise<string | null>;
  /** Bundled vfs-root bytes for a VFS path, or null. */
  bundledFile(vfsPath: string): Promise<Uint8Array | null>;
  version: string;
  origin: string;
  now?(): Date;
  randomUUID?(): string;
  /** Archive ceilings; tests lower them to exercise the part split. */
  limits?: { maxArchiveBytes?: number; maxArchiveEntries?: number };
}

/** A flagged file as the dialog lists it. */
export interface ProfileFlaggedFile extends ProfileFlaggedEntry {
  /** Where the file lived in six. */
  sourcePath: string;
}

export interface ProfileExportSummary {
  providers: string[];
  flagged: ProfileFlaggedFile[];
  mcp: ProfileMcpServer[];
  secrets: ProfileSecretKind[];
  mounts: string[];
  cones: number;
  scoops: number;
  frozen: number;
  files: number;
  skills: number;
  sprinkles: number;
  bytes: number;
  archives: string[];
}

export interface ProfileArchivePlan {
  filename: string;
  manifest: SliccProfileManifestV1;
  /** Exact byte length of the archive this plan writes. */
  byteLength: number;
  open(signal?: AbortSignal): ZipStreamResult & { filename: string };
}

export interface ProfileExportPlan {
  exportId: string;
  createdAt: string;
  archives: ProfileArchivePlan[];
  summary: ProfileExportSummary;
}

/** A failure the user can act on; the message is shown verbatim. */
export class ProfileExportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProfileExportError';
  }
}

// ---------------------------------------------------------------------------
// Internal model
// ---------------------------------------------------------------------------

interface PlannedEntry {
  path: string;
  size: number;
  sha256: string;
  load(): Promise<Uint8Array>;
}

interface Group {
  entries: Map<string, PlannedEntry>;
  skipped: ProfileSkippedEntry[];
  flagged: ProfileFlaggedFile[];
  redactionCounts: { [category: string]: number };
  cones: ProfileConeEntry[];
  frozen: ProfileFrozenEntry[];
  skills: ProfileNamedPath[];
  sprinkles: ProfileNamedPath[];
  licks: string | null;
  gitconfig: string | null;
  counts: {
    files: number;
    attachments: number;
    crontasks: number;
    tasks: number;
    webhooks: number;
  };
}

function newGroup(): Group {
  return {
    entries: new Map(),
    skipped: [],
    flagged: [],
    redactionCounts: {},
    cones: [],
    frozen: [],
    skills: [],
    sprinkles: [],
    licks: null,
    gitconfig: null,
    counts: { files: 0, attachments: 0, crontasks: 0, tasks: 0, webhooks: 0 },
  };
}

/** A walked file waiting to be read, routed to a zip path and a group. */
interface QueuedFile {
  vfsPath: string;
  zipPath: string;
  group: Group;
}

const CACHE_DIRS = new Set(['node_modules', '.cache', '__pycache__']);
const encoder = new TextEncoder();
const strictDecoder = new TextDecoder('utf-8', { fatal: true });
const latin1 = new TextDecoder('latin1');

function addCounts(into: { [k: string]: number }, from: { readonly [k: string]: number }): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

function joinPath(dir: string, name: string): string {
  return dir === '/' ? `/${name}` : `${dir}/${name}`;
}

/** Decode `bytes` as text the redactor may rewrite, or null for binary. */
function asText(bytes: Uint8Array): string | null {
  if (bytes.includes(0)) return null;
  try {
    return strictDecoder.decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Split text over the redactor's batch size into chunks of at most `max`
 * characters, cutting after a newline where one exists so a secret (never
 * multi-line) is not split across two batches.
 */
export function splitForRedaction(text: string, max = PROFILE_MAX_REDACTED_TEXT_BYTES): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + max, text.length);
    if (end < text.length) {
      const newline = text.lastIndexOf('\n', end - 1);
      if (newline >= start) end = newline + 1;
    }
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** Only the `[user]` section of a gitconfig (name, email, signing key). */
export function gitconfigUserSection(text: string): string | null {
  const out: string[] = [];
  let inUser = false;
  for (const line of text.split(/\r?\n/)) {
    const header = /^\s*\[([^\]]+)\]/.exec(line);
    if (header) inUser = header[1]!.trim().toLowerCase() === 'user';
    if (inUser && line.trim() !== '') out.push(line);
  }
  return out.length > 1 ? `${out.join('\n')}\n` : null;
}

/** `frozen/<safeId>.json` name for a session id. */
async function frozenSafeId(id: string): Promise<string> {
  if (/^[A-Za-z0-9._-]{1,128}$/.test(id) && id !== '.' && id !== '..') return id;
  return `s-${(await sha256Hex(id)).slice(0, 16)}`;
}

// ---------------------------------------------------------------------------
// Collector
// ---------------------------------------------------------------------------

class ProfileCollector {
  readonly profile = newGroup();
  readonly groups: Group[] = [this.profile];
  private readonly queue: QueuedFile[] = [];
  private readonly mountPaths: Set<string>;
  readonly mounts: string[];

  constructor(
    readonly deps: ProfileExportDeps,
    private readonly redactor: KnownSecretBatchRedactor,
    mounts: readonly string[],
    private readonly signal: AbortSignal | undefined,
    private readonly literals: readonly string[] = []
  ) {
    this.mountPaths = new Set(mounts.map((m) => m.replace(/\/+$/, '') || '/'));
    this.mounts = [...this.mountPaths].sort();
    for (const mount of this.mounts) this.profile.skipped.push({ path: mount, reason: 'mount' });
  }

  private checkAbort(): void {
    if (this.signal?.aborted) throw new ProfileExportError('Export cancelled.');
  }

  private async readDir(path: string): Promise<DirEntry[] | null> {
    try {
      return await this.deps.vfs.readDir(path);
    } catch {
      return null;
    }
  }

  async readBytes(path: string): Promise<Uint8Array | null> {
    try {
      const raw = await this.deps.vfs.readFile(path, { encoding: 'binary' });
      return typeof raw === 'string' ? encoder.encode(raw) : raw;
    } catch {
      return null;
    }
  }

  /**
   * Walk `root`, queueing every file under `zipPrefix`. `omit` names
   * top-level children of `root` routed elsewhere (memory, skills, …).
   */
  async walk(
    root: string,
    zipPrefix: string,
    group: Group,
    omit: ReadonlySet<string> = new Set()
  ): Promise<number> {
    let queued = 0;
    const visit = async (dir: string, rel: string): Promise<void> => {
      this.checkAbort();
      const entries = await this.readDir(dir);
      if (!entries) return;
      for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
        if (!rel && omit.has(entry.name)) continue;
        const path = joinPath(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        const action = this.classify(entry, dir, path);
        if (action === 'descend') await visit(path, relPath);
        else if (action === 'queue') {
          this.queue.push({ vfsPath: path, zipPath: `${zipPrefix}${relPath}`, group });
          queued++;
        } else if (action !== 'ignore') group.skipped.push({ path, reason: action });
      }
    };
    if (this.mountPaths.has(root)) return 0;
    await visit(root, '');
    return queued;
  }

  /** What the walk does with one directory entry. */
  private classify(
    entry: DirEntry,
    dir: string,
    path: string
  ): 'descend' | 'queue' | 'ignore' | 'cache' | 'secret' {
    if (this.mountPaths.has(path)) return 'ignore';
    if (entry.type === 'directory') {
      const isHooks = entry.name === 'hooks' && dir.endsWith('/.git');
      return CACHE_DIRS.has(entry.name) || isHooks ? 'cache' : 'descend';
    }
    if (entry.type !== 'file') return 'ignore';
    if (path.endsWith('/.git/github-token') || path.endsWith('/.mcp/servers.json')) {
      return 'secret';
    }
    return 'queue';
  }

  /** Add an in-memory entry (transcripts, memory, licks). */
  async addBytes(group: Group, path: string, bytes: Uint8Array): Promise<void> {
    const sha256 = await sha256Hex(bytes);
    group.entries.set(path, { path, size: bytes.byteLength, sha256, load: async () => bytes });
  }

  /** Redact a text entry, then add it. */
  async addText(group: Group, path: string, text: string): Promise<void> {
    const [redacted] = await redactProfileTexts(
      [text],
      this.redactor,
      group.redactionCounts,
      this.signal
    );
    await this.addBytes(group, path, encoder.encode(redacted!));
  }

  /** Read, classify, redact and hash every queued file, in 1 MiB batches. */
  async drain(): Promise<void> {
    const queue = this.queue.splice(0);
    let batch: { file: QueuedFile; bytes: Uint8Array; text: string }[] = [];
    let batchChars = 0;
    const flush = async (): Promise<void> => {
      if (batch.length === 0) return;
      const pending = batch;
      batch = [];
      batchChars = 0;
      const byGroup = new Map<Group, typeof pending>();
      for (const item of pending) {
        const list = byGroup.get(item.file.group) ?? [];
        list.push(item);
        byGroup.set(item.file.group, list);
      }
      for (const [group, items] of byGroup) {
        const out = await redactProfileTexts(
          items.map((i) => i.text),
          this.redactor,
          group.redactionCounts,
          this.signal
        );
        for (let i = 0; i < items.length; i++) {
          const item = items[i]!;
          if (out[i] === item.text) await this.addFileEntry(item.file, item.bytes, false);
          else await this.addFileEntry(item.file, encoder.encode(out[i]!), true);
        }
      }
    };
    for (const file of queue) {
      this.checkAbort();
      const bytes = await this.readBytes(file.vfsPath);
      if (!bytes) {
        file.group.skipped.push({ path: file.vfsPath, reason: 'unreadable' });
        continue;
      }
      if (bytes.byteLength > PROFILE_MAX_FILE_BYTES) {
        file.group.skipped.push({ path: file.vfsPath, reason: 'too-large' });
        continue;
      }
      const bundled = await this.deps.bundledFile(file.vfsPath);
      if (bundled && sameBytes(bundled, bytes)) {
        file.group.skipped.push({ path: file.vfsPath, reason: 'bundled' });
        continue;
      }
      const rule = profileFlagRuleFor(file.vfsPath);
      if (rule) {
        file.group.flagged.push({
          path: file.zipPath,
          size: bytes.byteLength,
          rule,
          sourcePath: file.vfsPath,
        });
        await this.addFileEntry(file, bytes, false);
        continue;
      }
      const text = asText(bytes);
      if (text === null) {
        if (this.holdsLiteralSecret(bytes)) {
          file.group.skipped.push({ path: file.vfsPath, reason: 'secret' });
        } else {
          await this.addFileEntry(file, bytes, false);
        }
        continue;
      }
      if (text.length > PROFILE_MAX_REDACTED_TEXT_BYTES) {
        await this.addLargeText(file, bytes, text);
        continue;
      }
      if (batchChars + text.length > PROFILE_MAX_REDACTED_TEXT_BYTES) await flush();
      batch.push({ file, bytes, text });
      batchChars += text.length;
    }
    await flush();
  }

  /** A text file over one batch: redact it chunk by chunk, keep it only if it changed. */
  private async addLargeText(file: QueuedFile, bytes: Uint8Array, text: string): Promise<void> {
    const chunks = splitForRedaction(text);
    const out = await redactProfileTexts(
      chunks,
      this.redactor,
      file.group.redactionCounts,
      this.signal
    );
    const changed = out.some((chunk, i) => chunk !== chunks[i]);
    await this.addFileEntry(file, changed ? encoder.encode(out.join('')) : bytes, changed);
  }

  /** True when a binary file carries a page-known secret verbatim (it is then skipped). */
  private holdsLiteralSecret(bytes: Uint8Array): boolean {
    if (this.literals.length === 0) return false;
    const haystack = latin1.decode(bytes);
    return this.literals.some((secret) => haystack.includes(secret));
  }

  /**
   * Record a file entry. `keep` holds redacted bytes in memory; otherwise the
   * file is re-read when the archive is written and must hash the same.
   */
  private async addFileEntry(file: QueuedFile, bytes: Uint8Array, keep: boolean): Promise<void> {
    const sha256 = await sha256Hex(bytes);
    file.group.counts.files++;
    const load = keep
      ? async () => bytes
      : async (): Promise<Uint8Array> => {
          const again = await this.readBytes(file.vfsPath);
          if (!again || (await sha256Hex(again)) !== sha256) {
            throw new ProfileExportError(`${file.vfsPath} changed while exporting. Export again.`);
          }
          return again;
        };
    file.group.entries.set(file.zipPath, {
      path: file.zipPath,
      size: bytes.byteLength,
      sha256,
      load,
    });
  }

  /** Skills or sprinkles under `root/<name>/` (and flat `<name>.shtml` sprinkles). */
  async collectNamedDirs(
    root: string,
    zipRoot: 'skills' | 'sprinkles',
    seen: Set<string>
  ): Promise<void> {
    const entries = await this.readDir(root);
    if (!entries) return;
    for (const entry of [...entries].sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const path = joinPath(root, entry.name);
      if (this.mountPaths.has(path)) continue;
      const isFlatSprinkle =
        zipRoot === 'sprinkles' && entry.type === 'file' && entry.name.endsWith('.shtml');
      if (entry.type !== 'directory' && !isFlatSprinkle) continue;
      const name = isFlatSprinkle ? entry.name.slice(0, -'.shtml'.length) : entry.name;
      if (await this.isBundledTree(path, entry.type === 'directory')) {
        this.profile.skipped.push({ path, reason: 'bundled' });
        continue;
      }
      let unique = name;
      for (let n = 2; seen.has(unique); n++) unique = `${name}-${n}`;
      seen.add(unique);
      const prefix = `${zipRoot}/${unique}/`;
      const queued = isFlatSprinkle
        ? this.queueOne(path, `${prefix}${entry.name}`)
        : await this.walk(path, prefix, this.profile);
      if (queued === 0) continue;
      const list = zipRoot === 'skills' ? this.profile.skills : this.profile.sprinkles;
      list.push({ name: unique, path: prefix });
    }
  }

  private queueOne(vfsPath: string, zipPath: string): number {
    this.queue.push({ vfsPath, zipPath, group: this.profile });
    return 1;
  }

  /** True when every file under `path` is byte-identical to its bundled copy. */
  private async isBundledTree(path: string, isDir: boolean): Promise<boolean> {
    const files: string[] = [];
    const visit = async (dir: string): Promise<void> => {
      for (const entry of (await this.readDir(dir)) ?? []) {
        const child = joinPath(dir, entry.name);
        if (entry.type === 'directory') await visit(child);
        else if (entry.type === 'file') files.push(child);
      }
    };
    if (isDir) await visit(path);
    else files.push(path);
    if (files.length === 0) return true;
    for (const file of files) {
      const bundled = await this.deps.bundledFile(file);
      if (!bundled) return false;
      const bytes = await this.readBytes(file);
      if (!bytes || !sameBytes(bundled, bytes)) return false;
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

/**
 * Re-home a snapshot's attachments at `attachments/<sha256>` (shared across
 * transcripts) and return the rewritten document.
 */
async function rehomeAttachments(
  collector: ProfileCollector,
  group: Group,
  snapshot: TranscriptSnapshot
): Promise<TranscriptDocumentV1> {
  const attachments = [];
  for (const att of snapshot.document.attachments) {
    const bytes = att.present && att.path ? snapshot.bundleFiles.get(att.path) : undefined;
    if (!bytes) {
      attachments.push(att);
      continue;
    }
    const sha256 = await sha256Hex(bytes);
    const path = `attachments/${sha256}`;
    if (!group.entries.has(path)) {
      await collector.addBytes(group, path, bytes);
      group.counts.attachments++;
    }
    attachments.push({ ...att, path, sha256, byteLength: bytes.byteLength });
  }
  const document = { ...snapshot.document, attachments };
  const validation = validateTranscriptDocumentV1(document);
  if (!validation.ok) {
    throw new ProfileExportError(`A transcript failed validation: ${validation.error}`);
  }
  addCounts(group.redactionCounts, document.privacy.redactionCounts);
  return document;
}

function transcriptBytes(document: TranscriptDocumentV1): Uint8Array {
  return encoder.encode(JSON.stringify(document, null, 2));
}

// ---------------------------------------------------------------------------
// Folders, cones and licks
// ---------------------------------------------------------------------------

/** Export folder per unit: six's own when it fits the shared rule, else a slug. */
function exportFolders(units: readonly ProfileUnit[]): Map<string, string> {
  const used = new Set<string>();
  const out = new Map<string, string>();
  const ordered = [...units].sort(
    (a, b) =>
      Number(!PROFILE_FOLDER_PATTERN.test(a.folder)) -
      Number(!PROFILE_FOLDER_PATTERN.test(b.folder))
  );
  for (const unit of ordered) {
    let base = unit.folder;
    if (!PROFILE_FOLDER_PATTERN.test(base)) {
      base = slugify(base.toLowerCase(), { maxLen: 56, fallback: 'unit' }).toLowerCase();
      if (!PROFILE_FOLDER_PATTERN.test(base)) base = 'unit';
    }
    let folder = base;
    for (let n = 2; used.has(folder); n++) folder = `${base}-${n}`;
    used.add(folder);
    out.set(unit.jid, folder);
  }
  return out;
}

function lickTargetFolder(
  scoopField: string | undefined,
  units: readonly ProfileUnit[],
  folders: ReadonlyMap<string, string>
): string | null {
  if (!scoopField) return null;
  const unit = matchLickTargetAlias(units, scoopField);
  return unit ? (folders.get(unit.jid) ?? null) : null;
}

async function collectCone(
  collector: ProfileCollector,
  transcripts: ProfileTranscriptSource,
  cone: ProfileUnit,
  units: readonly ProfileUnit[],
  folders: ReadonlyMap<string, string>,
  signal: AbortSignal | undefined
): Promise<Group> {
  const group = newGroup();
  const folder = folders.get(cone.jid)!;
  const snapshot = await transcripts.snapshotCone({ jid: cone.jid, name: cone.name }, signal);
  const document = await rehomeAttachments(collector, group, snapshot);
  const transcriptPath = `transcripts/${folder}.json`;
  await collector.addBytes(group, transcriptPath, transcriptBytes(document));
  const conversationIds = new Set(document.conversations.map((c) => c.id));

  const { root, memoryPath } = workspaceFor(cone);
  const primary = isPrimaryRoot(cone);
  const omit = new Set(primary ? ['skills', 'sprinkles', 'CLAUDE.md'] : []);
  const filesPrefix = `files/cones/${folder}/`;
  const coneFiles = await collector.walk(root, filesPrefix, group, omit);

  let memory: string | null = null;
  const memoryBytes = await collector.readBytes(memoryPath);
  if (memoryBytes) {
    const bundled = await collector.deps.bundledFile(memoryPath);
    if (bundled && sameBytes(bundled, memoryBytes)) {
      group.skipped.push({ path: memoryPath, reason: 'bundled' });
    } else {
      memory = `memory/${folder}.md`;
      await collector.addText(group, memory, new TextDecoder().decode(memoryBytes));
    }
  }

  const scoops = [];
  for (const scoop of subtreeOf(units, cone.jid)) {
    if (scoop.jid === cone.jid) continue;
    const scoopFolder = folders.get(scoop.jid)!;
    const prefix = `files/scoops/${scoopFolder}/`;
    const queued = await collector.walk(workspaceFor(scoop).root, prefix, group);
    scoops.push({
      key: conversationKeyFor(scoop),
      folder: scoopFolder,
      name: scoop.name,
      conversation: conversationIds.has(scoop.jid) ? scoop.jid : null,
      files: queued > 0 ? prefix : null,
    });
  }
  group.cones.push({
    key: conversationKeyFor(cone),
    folder,
    name: cone.name,
    transcript: transcriptPath,
    conversation: conversationIds.has(cone.jid) ? cone.jid : null,
    files: coneFiles > 0 ? filesPrefix : null,
    memory,
    scoops,
  });
  return group;
}

async function collectFrozen(
  collector: ProfileCollector,
  transcripts: ProfileTranscriptSource,
  vfs: ProfileExportDeps['vfs'],
  signal: AbortSignal | undefined
): Promise<void> {
  const group = collector.profile;
  const used = new Set<string>();
  for (const entry of await readSessionsIndex(vfs)) {
    const id = entry.sessionId ?? entry.filename;
    let snapshot: TranscriptSnapshot;
    try {
      snapshot = await transcripts.snapshotFrozen(id, signal);
    } catch (err) {
      if (signal?.aborted) throw err;
      group.skipped.push({ path: `/sessions/${entry.filename}`, reason: 'unreadable' });
      continue;
    }
    let safe = await frozenSafeId(id);
    for (let n = 2; used.has(safe); n++) safe = `${await frozenSafeId(id)}-${n}`;
    used.add(safe);
    const document = await rehomeAttachments(collector, group, snapshot);
    const transcript = `frozen/${safe}.json`;
    await collector.addBytes(group, transcript, transcriptBytes(document));
    group.frozen.push({ id, title: entry.title, frozenAt: entry.frozenAt ?? null, transcript });
  }
}

async function collectLicks(
  collector: ProfileCollector,
  deps: ProfileExportDeps,
  units: readonly ProfileUnit[],
  folders: ReadonlyMap<string, string>
): Promise<void> {
  const licks = await deps.licks();
  if (licks.crontasks.length + licks.tasks.length + licks.webhooks.length === 0) return;
  const group = collector.profile;
  const body = {
    crontasks: licks.crontasks.map((c) => ({
      ...c,
      targetFolder: lickTargetFolder(c.scoop, units, folders),
    })),
    tasks: licks.tasks,
    webhooks: licks.webhooks.map((w) => ({
      ...w,
      targetFolder: lickTargetFolder(w.scoop, units, folders),
    })),
  };
  group.licks = 'licks.json';
  group.counts.crontasks = licks.crontasks.length;
  group.counts.tasks = licks.tasks.length;
  group.counts.webhooks = licks.webhooks.length;
  await collector.addText(group, 'licks.json', `${JSON.stringify(body, null, 2)}\n`);
}

async function collectGlobals(collector: ProfileCollector, deps: ProfileExportDeps): Promise<void> {
  const group = collector.profile;
  const globalMemory = await collector.readBytes('/shared/CLAUDE.md');
  if (globalMemory) {
    const bundled = await deps.bundledFile('/shared/CLAUDE.md');
    if (bundled && sameBytes(bundled, globalMemory)) {
      group.skipped.push({ path: '/shared/CLAUDE.md', reason: 'bundled' });
    } else {
      await collector.addText(group, 'memory/global.md', new TextDecoder().decode(globalMemory));
    }
  }
  const gitconfig = await deps.gitconfig();
  const user = gitconfig ? gitconfigUserSection(gitconfig) : null;
  if (user) {
    group.gitconfig = 'git/gitconfig';
    await collector.addText(group, 'git/gitconfig', user);
  }
  await collector.walk('/home/user', 'files/home-user/', group);
  const skills = new Set<string>();
  await collector.collectNamedDirs('/workspace/skills', 'skills', skills);
  const sprinkles = new Set<string>();
  await collector.collectNamedDirs('/shared/sprinkles', 'sprinkles', sprinkles);
  await collector.collectNamedDirs('/workspace/sprinkles', 'sprinkles', sprinkles);
}

// ---------------------------------------------------------------------------
// Secrets that only the page knows
// ---------------------------------------------------------------------------

interface PageSecrets {
  providers: string[];
  mcp: ProfileMcpServer[];
  secrets: ProfileSecretKind[];
  literals: string[];
}

async function collectPageSecrets(deps: ProfileExportDeps): Promise<PageSecrets> {
  const literals: string[] = [];
  const kinds = new Set<ProfileSecretKind>(await deps.storedSecretKinds());
  const servers = (await deps.mcpServers())?.servers ?? {};
  const mcpProviderIds = new Set<string>();
  const mcp: ProfileMcpServer[] = [];
  for (const [name, server] of Object.entries(servers).sort(([a], [b]) => (a < b ? -1 : 1))) {
    mcp.push({ name, url: server.url });
    const headers = Object.values(server.headers ?? {});
    literals.push(...headers);
    const auth = server.auth as { providerId?: unknown } | undefined;
    if (typeof auth?.providerId === 'string') mcpProviderIds.add(auth.providerId);
    if (headers.length > 0 || auth) kinds.add('mcp-tokens');
  }
  const providers = new Set<string>();
  for (const account of deps.accounts()) {
    literals.push(account.apiKey ?? '', account.accessToken ?? '', account.refreshToken ?? '');
    if (mcpProviderIds.has(account.providerId)) {
      if (account.accessToken || account.apiKey) kinds.add('mcp-tokens');
      continue;
    }
    providers.add(account.providerId);
  }
  const githubToken = await deps.githubToken();
  if (githubToken) {
    literals.push(githubToken);
    kinds.add('github-token');
  }
  return {
    providers: [...providers].sort(),
    mcp,
    secrets: [...kinds].sort(),
    literals: literals.filter((l) => l.length > 0),
  };
}

// ---------------------------------------------------------------------------
// Archives
// ---------------------------------------------------------------------------

interface ArchiveContent {
  groups: Group[];
  part?: { index: number; of: number };
}

/** Exact stored-ZIP size for these entry names and sizes. */
function zipByteLength(entries: readonly { path: string; size: number }[]): number {
  let total = 22;
  for (const e of entries) total += 30 + 46 + 2 * encoder.encode(e.path).byteLength + e.size;
  return total;
}

function mergedEntries(groups: readonly Group[]): PlannedEntry[] {
  const out = new Map<string, PlannedEntry>();
  for (const g of groups) for (const [path, e] of g.entries) if (!out.has(path)) out.set(path, e);
  return [...out.values()];
}

interface ManifestHeader {
  exportId: string;
  createdAt: string;
  version: string;
  origin: string;
  page: PageSecrets;
}

function buildManifest(header: ManifestHeader, content: ArchiveContent): SliccProfileManifestV1 {
  const { groups } = content;
  const entries = mergedEntries(groups);
  const flat = <T>(pick: (g: Group) => T[]): T[] => groups.flatMap(pick);
  const sum = (pick: (g: Group) => number): number => groups.reduce((n, g) => n + pick(g), 0);
  const redactionCounts: { [category: string]: number } = {};
  for (const g of groups) addCounts(redactionCounts, g.redactionCounts);
  const cones = flat((g) => g.cones);
  const flagged = flat((g) => g.flagged).map(({ path, size, rule }) => ({ path, size, rule }));
  const profile = groups.find((g) => g.licks !== null || g.gitconfig !== null);
  return {
    format: SLICC_PROFILE_FORMAT,
    version: SLICC_PROFILE_VERSION,
    exportId: header.exportId,
    producer: { slicc: header.version, origin: header.origin },
    createdAt: header.createdAt,
    ...(content.part ? { part: content.part } : {}),
    cones,
    frozen: flat((g) => g.frozen),
    skills: flat((g) => g.skills),
    sprinkles: flat((g) => g.sprinkles),
    licks: profile?.licks ?? null,
    gitconfig: profile?.gitconfig ?? null,
    files: entries.map(({ path, size, sha256 }) => ({ path, size, sha256 })),
    skipped: flat((g) => g.skipped),
    flagged,
    providers: header.page.providers,
    mcp: header.page.mcp,
    secrets: header.page.secrets,
    redactionCounts,
    totals: {
      cones: cones.length,
      scoops: cones.reduce((n, c) => n + c.scoops.length, 0),
      frozen: sum((g) => g.frozen.length),
      files: sum((g) => g.counts.files),
      bytes: entries.reduce((n, e) => n + e.size, 0),
      entries: entries.length + 1,
      attachments: entries.filter((e) => e.path.startsWith('attachments/')).length,
      skills: sum((g) => g.skills.length),
      sprinkles: sum((g) => g.sprinkles.length),
      crontasks: sum((g) => g.counts.crontasks),
      tasks: sum((g) => g.counts.tasks),
      webhooks: sum((g) => g.counts.webhooks),
      flagged: flagged.length,
    },
  };
}

/**
 * After the drain, drop directory references whose files were all skipped
 * (bundled, unreadable, too large), so every reference names a real entry.
 */
function finalizeGroup(group: Group): void {
  const paths = [...group.entries.keys()];
  const has = (prefix: string | null): string | null =>
    prefix !== null && paths.some((p) => p.startsWith(prefix)) ? prefix : null;
  for (const cone of group.cones) {
    cone.files = has(cone.files);
    for (const scoop of cone.scoops) scoop.files = has(scoop.files);
  }
  group.skills = group.skills.filter((s) => has(s.path) !== null);
  group.sprinkles = group.sprinkles.filter((s) => has(s.path) !== null);
}

function isEmptyGroup(g: Group): boolean {
  return g.entries.size === 0 && g.cones.length === 0 && g.frozen.length === 0;
}

function planArchive(
  header: ManifestHeader,
  content: ArchiveContent,
  limits: { maxArchiveBytes: number; maxArchiveEntries: number }
): ProfileArchivePlan | null {
  const manifest = buildManifest(header, content);
  const validation = validateSliccProfileManifestV1(manifest);
  if (!validation.ok)
    throw new ProfileExportError(`Manifest failed validation: ${validation.error}`);
  const manifestBytes = encoder.encode(`${JSON.stringify(manifest, null, 2)}\n`);
  const entries = mergedEntries(content.groups);
  const byteLength = zipByteLength([
    { path: PROFILE_MANIFEST_PATH, size: manifestBytes.byteLength },
    ...entries,
  ]);
  if (byteLength > limits.maxArchiveBytes || entries.length + 1 > limits.maxArchiveEntries) {
    return null;
  }
  const filename = profileArchiveFilename(header.createdAt, content.part);
  return {
    filename,
    manifest,
    byteLength,
    open: (signal) => {
      const sources: ZipEntrySource[] = [
        { path: PROFILE_MANIFEST_PATH, load: () => manifestBytes },
        ...entries.map((e) => ({ path: e.path, load: () => e.load() })),
      ];
      return { filename, ...createZipStream(sources, signal) };
    },
  };
}

function oversizeMessage(group: Group): string {
  const name = group.cones[0]?.name;
  const what = name ? `The cone "${name}"` : 'The profile part (frozen chats, skills, home files)';
  return `${what} is too big for one archive (2 GiB or 60,000 files). Delete or move large files and export again.`;
}

function planArchives(
  header: ManifestHeader,
  groups: readonly Group[],
  limits: { maxArchiveBytes: number; maxArchiveEntries: number }
): ProfileArchivePlan[] {
  const single = planArchive(header, { groups: [...groups] }, limits);
  if (single) return [single];
  const parts = groups.filter((g) => !isEmptyGroup(g));
  return parts.map((group, i) => {
    const plan = planArchive(
      header,
      { groups: [group], part: { index: i + 1, of: parts.length } },
      limits
    );
    if (!plan) throw new ProfileExportError(oversizeMessage(group));
    return plan;
  });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Read, redact and hash the whole profile, and plan its archive(s). Nothing
 * is written; call `open()` on each archive to stream it.
 */
export async function planProfileExport(
  deps: ProfileExportDeps,
  signal?: AbortSignal
): Promise<ProfileExportPlan> {
  const now = deps.now?.() ?? new Date();
  const exportId = deps.randomUUID?.() ?? crypto.randomUUID();
  const page = await collectPageSecrets(deps);
  const redactor = literalSecretsRedactor(deps.knownSecrets, page.literals);
  const transcripts = deps.createTranscriptSource(redactor);
  const collector = new ProfileCollector(
    deps,
    redactor,
    await deps.mounts(),
    signal,
    page.literals.filter((l) => l.length >= MIN_LITERAL_SECRET_LENGTH)
  );

  const units = deps.listUnits();
  const folders = exportFolders(units);
  const cones = units
    .filter((u) => isRootUnit(u))
    .sort((a, b) => Number(isPrimaryRoot(b)) - Number(isPrimaryRoot(a)));
  for (const cone of cones) {
    collector.groups.push(await collectCone(collector, transcripts, cone, units, folders, signal));
  }
  await collectFrozen(collector, transcripts, deps.vfs, signal);
  await collectGlobals(collector, deps);
  await collectLicks(collector, deps, units, folders);
  await collector.drain();
  if (signal?.aborted) throw new ProfileExportError('Export cancelled.');
  for (const group of collector.groups) finalizeGroup(group);

  const header: ManifestHeader = {
    exportId,
    createdAt: now.toISOString(),
    version: deps.version,
    origin: deps.origin,
    page,
  };
  const archives = planArchives(header, collector.groups, {
    maxArchiveBytes: deps.limits?.maxArchiveBytes ?? PROFILE_MAX_ARCHIVE_BYTES,
    maxArchiveEntries: deps.limits?.maxArchiveEntries ?? PROFILE_MAX_ARCHIVE_ENTRIES,
  });
  const all = collector.groups;
  const count = (pick: (g: Group) => number): number => all.reduce((n, g) => n + pick(g), 0);
  return {
    exportId,
    createdAt: header.createdAt,
    archives,
    summary: {
      providers: page.providers,
      flagged: all.flatMap((g) => g.flagged),
      mcp: page.mcp,
      secrets: page.secrets,
      mounts: collector.mounts,
      cones: count((g) => g.cones.length),
      scoops: count((g) => g.cones.reduce((n, c) => n + c.scoops.length, 0)),
      frozen: count((g) => g.frozen.length),
      files: count((g) => g.counts.files),
      skills: count((g) => g.skills.length),
      sprinkles: count((g) => g.sprinkles.length),
      bytes: archives.reduce((n, a) => n + a.byteLength, 0),
      archives: archives.map((a) => a.filename),
    },
  };
}
