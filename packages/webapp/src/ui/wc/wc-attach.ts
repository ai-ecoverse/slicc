/**
 * Composer add-menu wiring: the library's `<slicc-add-menu>` searches REAL
 * data (VFS files, installed skills, frozen conversations) and its actions
 * land as staged prompt attachments — uploads/drops, VFS file picks, camera
 * photos (getUserMedia), and screen captures (getDisplayMedia). Staged chips
 * render inside the input card and ride the next submit.
 */

import type { MessageAttachment } from '../../core/attachments.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';

/** Mirrors the library's `SliccAddSection` (not exported through the barrel). */
interface AddSection {
  kind: string;
  label: string;
  icon: string;
  entries: { id: string; label: string; sub?: string }[];
}

const MAX_ROWS_PER_SECTION = 8;
const MAX_WALK_ENTRIES = 400;
const WALK_ROOTS = ['/workspace', '/shared'] as const;
const WALK_DEPTH = 3;
const FILE_CACHE_MS = 10_000;

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|avif)$/i;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 256 * 1024;

function uid(): string {
  return `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

function mimeFor(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  const map: Record<string, string> = {
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    svg: 'image/svg+xml',
    avif: 'image/avif',
    md: 'text/markdown',
    json: 'application/json',
  };
  return map[ext] ?? 'text/plain';
}

/** Bytes → MessageAttachment: images inline as base64, the rest as text. */
export function attachmentFromBytes(name: string, bytes: Uint8Array): MessageAttachment {
  const base = { id: uid(), name, size: bytes.length };
  if (IMAGE_EXT.test(name)) {
    if (bytes.length > MAX_IMAGE_BYTES) {
      return {
        ...base,
        mimeType: mimeFor(name),
        kind: 'image',
        error: 'image too large to inline',
      };
    }
    return { ...base, mimeType: mimeFor(name), kind: 'image', data: toBase64(bytes) };
  }
  if (bytes.length > MAX_TEXT_BYTES) {
    return { ...base, mimeType: 'text/plain', kind: 'file', error: 'file too large to inline' };
  }
  return { ...base, mimeType: mimeFor(name), kind: 'text', text: new TextDecoder().decode(bytes) };
}

/** A picked/dropped File → MessageAttachment (same inlining rules). */
export async function attachmentFromFile(file: File): Promise<MessageAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const attachment = attachmentFromBytes(file.name, bytes);
  return file.type ? { ...attachment, mimeType: file.type } : attachment;
}

/** A canvas frame (camera snap / screen grab) → image attachment. */
export function attachmentFromDataUrl(name: string, dataUrl: string): MessageAttachment | null {
  const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
  if (!match) return null;
  return {
    id: uid(),
    name,
    mimeType: match[1],
    size: Math.floor((match[2].length * 3) / 4),
    kind: 'image',
    data: match[2],
  };
}

// ---------------------------------------------------------------------------
// Search provider (Files / Skills / Conversations)
// ---------------------------------------------------------------------------

async function walkFiles(fs: LocalVfsClient): Promise<string[]> {
  const out: string[] = [];
  const queue: Array<{ dir: string; depth: number }> = WALK_ROOTS.map((dir) => ({
    dir,
    depth: 0,
  }));
  while (queue.length > 0 && out.length < MAX_WALK_ENTRIES) {
    const { dir, depth } = queue.shift() as { dir: string; depth: number };
    let entries: Awaited<ReturnType<LocalVfsClient['readDir']>>;
    try {
      entries = await fs.readDir(dir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.type === 'directory') {
        if (depth < WALK_DEPTH) queue.push({ dir: path, depth: depth + 1 });
      } else {
        out.push(path);
        if (out.length >= MAX_WALK_ENTRIES) break;
      }
    }
  }
  return out;
}

export interface AddProviderDeps {
  openReader(): Promise<LocalVfsClient>;
  /** Frozen-session entries (filename + title + meta line). */
  listConversations(): Promise<{ id: string; label: string; sub?: string }[]>;
}

/**
 * Build the add-menu's results provider: live VFS files, installed skills,
 * and frozen conversations, substring-filtered by the query. The file walk
 * is cached briefly so per-keystroke calls don't storm the worker RPC.
 */
export function createAddProvider(deps: AddProviderDeps): (query: string) => Promise<AddSection[]> {
  let fileCache: { at: number; paths: string[] } | null = null;
  return async (query: string): Promise<AddSection[]> => {
    const reader = await deps.openReader();
    if (!fileCache || Date.now() - fileCache.at > FILE_CACHE_MS) {
      fileCache = { at: Date.now(), paths: await walkFiles(reader) };
    }
    const match = (text: string): boolean => query === '' || text.toLowerCase().includes(query);

    const files = fileCache.paths
      .filter((p) => match(p))
      .slice(0, MAX_ROWS_PER_SECTION)
      .map((p) => ({
        id: p,
        label: p.split('/').pop() ?? p,
        sub: p.slice(0, p.lastIndexOf('/')),
      }));

    let skills: { id: string; label: string }[] = [];
    try {
      skills = (await reader.readDir('/workspace/skills'))
        .filter((e) => e.type === 'directory' && match(e.name))
        .slice(0, MAX_ROWS_PER_SECTION)
        .map((e) => ({ id: e.name, label: e.name }));
    } catch {
      // No skills directory — section renders empty.
    }

    const conversations = (await deps.listConversations().catch(() => []))
      .filter((c) => match(c.label))
      .slice(0, MAX_ROWS_PER_SECTION);

    return [
      { kind: 'file', label: 'Files', icon: 'file', entries: files },
      { kind: 'skill', label: 'Skills', icon: 'sparkles', entries: skills },
      {
        kind: 'conversation',
        label: 'Conversations',
        icon: 'message-square',
        entries: conversations,
      },
    ];
  };
}

// ---------------------------------------------------------------------------
// Staged-attachment chips
// ---------------------------------------------------------------------------

const STAGE_STYLE_ID = 'slicc-wc-attach-style';
const STAGE_CSS = `
.wcatt{display:flex;flex-wrap:wrap;gap:6px;padding:8px 10px 0;font-family:var(--ui);}
.wcatt:empty{display:none;}
.wcatt__chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--ink);
  background:var(--ghost);border:1px solid var(--line);border-radius:14px;padding:3px 8px;max-width:220px;}
.wcatt__name{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wcatt__x{appearance:none;background:none;border:none;cursor:pointer;color:var(--txt-3);
  font:inherit;padding:0;line-height:1;}
.wcatt__x:hover{color:var(--ink);}
`;

/** Pending attachments staged as removable chips inside the input card. */
export class WcAttachmentStage {
  readonly #strip: HTMLElement;
  #items: MessageAttachment[] = [];

  constructor(inputCard: HTMLElement) {
    if (!document.getElementById(STAGE_STYLE_ID)) {
      const style = document.createElement('style');
      style.id = STAGE_STYLE_ID;
      style.textContent = STAGE_CSS;
      document.head.appendChild(style);
    }
    this.#strip = document.createElement('div');
    this.#strip.className = 'wcatt';
    inputCard.prepend(this.#strip);
  }

  get items(): readonly MessageAttachment[] {
    return this.#items;
  }

  add(attachment: MessageAttachment): void {
    this.#items.push(attachment);
    this.#render();
  }

  /** Hand the staged attachments to a submit and clear the strip. */
  take(): MessageAttachment[] {
    const taken = this.#items;
    this.#items = [];
    this.#render();
    return taken;
  }

  #render(): void {
    this.#strip.replaceChildren(
      ...this.#items.map((attachment) => {
        const chip = document.createElement('span');
        chip.className = 'wcatt__chip';
        const name = document.createElement('span');
        name.className = 'wcatt__name';
        name.textContent = attachment.name;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'wcatt__x';
        remove.setAttribute('aria-label', `Remove ${attachment.name}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => {
          this.#items = this.#items.filter((a) => a.id !== attachment.id);
          this.#render();
        });
        chip.append(name, remove);
        return chip;
      })
    );
  }
}

// ---------------------------------------------------------------------------
// Camera / screen capture
// ---------------------------------------------------------------------------

/** Grab one frame from a media stream into a PNG data URL, then stop it. */
async function grabFrame(stream: MediaStream): Promise<string | null> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();
    // One settled frame — dimensions are 0 until metadata lands.
    await new Promise((r) => requestAnimationFrame(() => r(null)));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    if (canvas.width === 0 || canvas.height === 0) return null;
    canvas.getContext('2d')?.drawImage(video, 0, 0);
    return canvas.toDataURL('image/png');
  } finally {
    for (const track of stream.getTracks()) track.stop();
    video.srcObject = null;
  }
}

/** One-frame screen capture via the user's display-picker. */
async function captureScreenshot(): Promise<MessageAttachment | null> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  const dataUrl = await grabFrame(stream);
  return dataUrl ? attachmentFromDataUrl(`screenshot-${Date.now()}.png`, dataUrl) : null;
}

/** Camera photo: a minimal slicc-dialog with a live preview + Snap. */
async function capturePhoto(): Promise<MessageAttachment | null> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  return new Promise((resolve) => {
    const dialog = document.createElement('slicc-dialog');
    dialog.setAttribute('heading', 'Take a photo');
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.srcObject = stream;
    video.style.cssText = 'width:100%;border-radius:10px;background:#000;';
    dialog.append(video);

    const finish = (attachment: MessageAttachment | null): void => {
      for (const track of stream.getTracks()) track.stop();
      (dialog as HTMLElement & { hide?: () => void }).hide?.();
      dialog.remove();
      resolve(attachment);
    };

    const snap = document.createElement('button');
    snap.type = 'button';
    snap.textContent = 'Snap';
    snap.setAttribute('slot', 'footer');
    snap.addEventListener('click', () => {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d')?.drawImage(video, 0, 0);
      finish(attachmentFromDataUrl(`photo-${Date.now()}.png`, canvas.toDataURL('image/png')));
    });
    dialog.append(snap);
    dialog.addEventListener('slicc-dialog-close', () => finish(null));
    document.body.append(dialog);
    (dialog as HTMLElement & { show?: () => void }).show?.();
  });
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface WireWcAttachDeps {
  inputCard: HTMLElement & { value?: string };
  /** The freezer rail — conversation picks thaw through its select event. */
  freezer: HTMLElement;
  openReader(): Promise<LocalVfsClient>;
  listConversations(): Promise<{ id: string; label: string; sub?: string }[]>;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Stage a captured frame (camera vs screen) when the user completes it. */
async function stageCapture(detail: Record<string, unknown>, stage: WcAttachmentStage) {
  const attachment = detail.mode === 'photo' ? await capturePhoto() : await captureScreenshot();
  if (attachment) stage.add(attachment);
}

/** Stage a VFS file pick, read through the worker-routed reader. */
async function stageVfsFile(id: string, deps: WireWcAttachDeps, stage: WcAttachmentStage) {
  const reader = await deps.openReader();
  const raw = await reader.readFile(id);
  const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
  stage.add(attachmentFromBytes(id.split('/').pop() ?? id, bytes));
}

/** Append a skill mention to the composer's draft. */
function insertSkillMention(label: string, inputCard: WireWcAttachDeps['inputCard']): void {
  const current = inputCard.value ?? inputCard.getAttribute('value') ?? '';
  const sep = current && !current.endsWith(' ') ? ' ' : '';
  inputCard.setAttribute('value', `${current}${sep}Use the "${label}" skill: `);
}

async function handleAdd(
  detail: Record<string, unknown>,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (detail.kind === 'upload' && detail.file instanceof File) {
    stage.add(await attachmentFromFile(detail.file));
  } else if (detail.kind === 'capture') {
    await stageCapture(detail, stage);
  } else if (detail.kind === 'file' && typeof detail.id === 'string') {
    await stageVfsFile(detail.id, deps, stage);
  } else if (detail.kind === 'skill' && typeof detail.label === 'string') {
    insertSkillMention(detail.label, deps.inputCard);
  } else if (detail.kind === 'conversation' && typeof detail.id === 'string') {
    // Same path as clicking the frozen card in the rail: thaw read-only.
    deps.freezer.dispatchEvent(
      new CustomEvent('freezer-card-select', {
        bubbles: true,
        composed: true,
        detail: { slug: detail.id },
      })
    );
  }
}

/**
 * Wire the input card's add-menu to real data + actions. Returns the stage
 * so the submit handler can collect (`take()`) the pending attachments.
 */
export function wireWcAttach(deps: WireWcAttachDeps): WcAttachmentStage {
  const { inputCard, log } = deps;
  const stage = new WcAttachmentStage(inputCard);
  const menu = inputCard.querySelector('slicc-add-menu') as
    | (HTMLElement & { provider?: unknown })
    | null;
  if (menu) {
    menu.provider = createAddProvider({
      openReader: deps.openReader,
      listConversations: deps.listConversations,
    });
  }

  inputCard.addEventListener('slicc-add', (event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!detail) return;
    void handleAdd(detail, deps, stage).catch((err) => log.error('WC add-menu action failed', err));
  });
  return stage;
}
