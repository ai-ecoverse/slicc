/**
 * Composer add-menu wiring: the library's `<slicc-add-menu>` searches REAL
 * data (VFS files, installed skills, frozen conversations) and its actions
 * land as staged prompt attachments — uploads/drops, VFS file picks, camera
 * photos (getUserMedia), and screen captures (getDisplayMedia). Staged chips
 * render inside the input card and ride the next submit.
 */

import type { CaptureDeviceChangeDetail, CaptureResult } from '@slicc/webcomponents';
import type { MessageAttachment } from '../../core/attachments.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';

/** Mirrors the library's `SliccAddSection` (not exported through the barrel). */
interface AddSection {
  kind: string;
  label: string;
  icon: string;
  entries: { id: string; label: string; sub?: string }[];
}

const MAX_ROWS_PER_SECTION = 8;
// The walk must cover what a user would search FOR: deep and wide, skipping
// only the junk trees. A shallow walk made typed queries look like the menu
// "wasn't going back to the filesystem".
const MAX_WALK_ENTRIES = 2000;
const WALK_ROOTS = ['/workspace', '/shared', '/tmp'] as const;
const WALK_DEPTH = 8;
const SKIP_DIRS = new Set(['node_modules', '.git']);
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

/**
 * Bytes → MessageAttachment. Images inline as base64 (within the 4 MB cap);
 * every other file becomes a `kind:'file'` reference with NO inline content —
 * the staging step persists the raw bytes to {@link UPLOAD_DIR} and links the
 * path, so binary files are never UTF-8-decoded (no mojibake) and text files
 * are never inlined.
 */
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
  const file = { ...base, mimeType: mimeFor(name), kind: 'file' as const };
  // Oversized files keep a fallback label only — the staging step replaces it
  // with a persisted path when a writer is available.
  return bytes.length > MAX_TEXT_BYTES ? { ...file, error: 'file too large to inline' } : file;
}

/** A picked/dropped File → MessageAttachment (same rules). */
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

/** Directory in the VFS where captures + oversized uploads are persisted. */
export const UPLOAD_DIR = '/tmp/upload';
/** Long-edge cap for the inline (vision) copy of a capture. */
const INLINE_MAX_EDGE = 1568;

function bytesFromBase64(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/** Persist bytes under {@link UPLOAD_DIR}; returns the written VFS path. */
export async function persistUpload(
  writer: WritableVfsClient,
  name: string,
  bytes: Uint8Array
): Promise<string> {
  await writer.mkdir(UPLOAD_DIR, { recursive: true }).catch(() => undefined);
  const path = `${UPLOAD_DIR}/${Date.now()}-${name.replace(/[^A-Za-z0-9._-]+/g, '_')}`;
  await writer.writeFile(path, bytes);
  return path;
}

/** Downscale an image data URL to the vision-friendly long-edge cap (JPEG).
 *  Falls back to the original on any decode failure (fail-open). */
async function downscaleDataUrl(dataUrl: string, maxEdge = INLINE_MAX_EDGE): Promise<string> {
  const img = new Image();
  img.src = dataUrl;
  try {
    await img.decode();
  } catch {
    return dataUrl;
  }
  const scale = Math.min(1, maxEdge / Math.max(img.naturalWidth, img.naturalHeight, 1));
  if (scale >= 1) return dataUrl;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.85);
}

/**
 * A capture → attachment: the full-resolution original lands in
 * {@link UPLOAD_DIR} (linked in the prompt), the inline copy is downscaled
 * so big retina captures don't blow the model's image budget.
 */
export async function attachmentFromCapture(
  name: string,
  dataUrl: string,
  writer: WritableVfsClient | null
): Promise<MessageAttachment | null> {
  const full = attachmentFromDataUrl(name, dataUrl);
  if (!full) return null;
  let path: string | undefined;
  if (writer && full.data) {
    path = await persistUpload(writer, name, bytesFromBase64(full.data)).catch(() => undefined);
  }
  const inline = attachmentFromDataUrl(name, await downscaleDataUrl(dataUrl).catch(() => dataUrl));
  return { ...(inline ?? full), name, path };
}

/**
 * A recorded video Blob → file attachment. The WebM (with its mic audio track)
 * is persisted to {@link UPLOAD_DIR} and referenced by path — video is not a
 * vision input, so no inline `data` is carried. Returns `null` when no writer
 * is available (a video with no path is just a dead chip).
 */
export async function attachmentFromVideoBlob(
  name: string,
  blob: Blob,
  writer: WritableVfsClient | null
): Promise<MessageAttachment | null> {
  if (!writer) return null;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  const path = await persistUpload(writer, name, bytes).catch(() => undefined);
  if (!path) return null;
  return {
    id: uid(),
    name,
    mimeType: blob.type || 'video/webm',
    size: bytes.length,
    kind: 'file',
    path,
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
        if (depth < WALK_DEPTH && !SKIP_DIRS.has(entry.name)) {
          queue.push({ dir: path, depth: depth + 1 });
        }
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
.wcatt__thumb{width:28px;height:28px;object-fit:cover;border-radius:8px;cursor:zoom-in;
  border:1px solid var(--line);flex:0 0 auto;}
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
    this.#strip.replaceChildren(...this.#items.map((attachment) => this.#chip(attachment)));
  }

  #chip(attachment: MessageAttachment): HTMLElement {
    const chip = document.createElement('span');
    chip.className = 'wcatt__chip';
    // Image attachments get a real thumbnail; clicking zooms it in the
    // library's FLIP lightbox.
    if (attachment.kind === 'image' && attachment.data) {
      const img = document.createElement('img');
      img.className = 'wcatt__thumb';
      img.src = `data:${attachment.mimeType};base64,${attachment.data}`;
      img.alt = attachment.name;
      img.addEventListener('click', () => {
        void import('@slicc/webcomponents').then(({ SliccImagePreview }) =>
          SliccImagePreview.show(img.src, img)
        );
      });
      chip.append(img);
    }
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

/** One-frame screen capture via the user's display-picker (raw data URL). */
async function captureScreenshot(): Promise<string | null> {
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  return grabFrame(stream);
}

/** Remembered camera + mic picks (the component reports changes via its event). */
const CAMERA_PREF_KEY = 'slicc_camera_device';
const MIC_PREF_KEY = 'slicc_microphone_device';

/** Compact "drop-target" placement that mounts inside the composer band
 *  (`<slicc-composer>` is `position:relative; z-index:2`) and overlays the
 *  input row from the bottom up — `bottom:0` aligns the surface's bottom
 *  with the composer band's bottom so the enlarged capture box covers the
 *  textarea while open. Constrained to the composer's inner-column width
 *  (max 680px, centered via translateX). */
const COMPACT_CSS = [
  'position:absolute',
  'left:50%',
  'right:auto',
  'transform:translateX(-50%)',
  'bottom:0',
  'width:calc(100% - 32px)',
  'max-width:680px',
  'aspect-ratio:auto',
  'z-index:3',
].join(';');

/**
 * Camera capture via the inline `<slicc-composer-capture>` surface, mounted
 * inside the composer band and anchored to its bottom so the enlarged box
 * overlays the input textarea while open. Photo + video are both reachable
 * through the in-surface mode toggle; the caller picks the initial mode.
 * Resolves with the raw `CaptureResult` or `null` on cancel / no camera.
 *
 * Camera + mic picks persist across sessions via the
 * `slicc-capture-device-change` event (`detail.kind: 'camera' | 'microphone'`).
 */
async function captureInline(
  host: HTMLElement,
  initialMode: 'photo' | 'video'
): Promise<CaptureResult | null> {
  // The library barrel is already imported by `wc-shell.ts`, so the
  // `<slicc-composer-capture>` element is registered by the time we mount it.
  const capture = document.createElement('slicc-composer-capture') as HTMLElement & {
    open(mode?: 'photo' | 'video'): Promise<CaptureResult | null>;
  };
  const preferredCam = localStorage.getItem(CAMERA_PREF_KEY);
  if (preferredCam) capture.setAttribute('preferred-device', preferredCam);
  const preferredMic = localStorage.getItem(MIC_PREF_KEY);
  if (preferredMic) capture.setAttribute('preferred-audio-device', preferredMic);
  capture.style.cssText = COMPACT_CSS;
  capture.hidden = true;
  capture.addEventListener('slicc-capture-device-change', (event) => {
    const detail = (event as CustomEvent<CaptureDeviceChangeDetail>).detail;
    if (!detail?.deviceId) return;
    const key = detail.kind === 'microphone' ? MIC_PREF_KEY : CAMERA_PREF_KEY;
    localStorage.setItem(key, detail.deviceId);
  });
  host.append(capture);
  try {
    return await capture.open(initialMode);
  } finally {
    capture.remove();
  }
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

export interface WireWcAttachDeps {
  inputCard: HTMLElement & { value?: string };
  /** The freezer rail — conversation picks thaw through its select event. */
  freezer: HTMLElement;
  /** Host for the inline `<slicc-composer-capture>` surface — the
   *  `<slicc-composer>` band element (already `position:relative; z-index:2`).
   *  The surface anchors to the band's bottom (`bottom:0`) so the enlarged
   *  capture box overlays the input textarea while open. Optional: hosts
   *  without an overlay site (tests, harnesses) get the legacy
   *  `<slicc-camera-dialog>` modal as a fallback. */
  composer?: HTMLElement;
  openReader(): Promise<LocalVfsClient>;
  /** Writable VFS for persisting captures + oversized uploads to /tmp/upload. */
  openWriter?(): Promise<WritableVfsClient>;
  listConversations(): Promise<{ id: string; label: string; sub?: string }[]>;
  log: { error(message: string, ...data: unknown[]): void };
}

/** Stage a photo result (image data URL) — full-res to VFS + inline downscale. */
async function stagePhotoResult(
  result: CaptureResult,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (!result.dataUrl) return;
  const name = `photo-${Date.now()}.png`;
  const writer = (await deps.openWriter?.().catch(() => null)) ?? null;
  const attachment = await attachmentFromCapture(name, result.dataUrl, writer);
  if (attachment) stage.add(attachment);
}

/** Stage a video result (WebM Blob) — persist to VFS, reference by path. */
async function stageVideoResult(
  result: CaptureResult,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (!result.blob) return;
  const ext = /webm/i.test(result.mimeType) ? 'webm' : 'bin';
  const name = `video-${Date.now()}.${ext}`;
  const writer = (await deps.openWriter?.().catch(() => null)) ?? null;
  const attachment = await attachmentFromVideoBlob(name, result.blob, writer);
  if (attachment) stage.add(attachment);
}

/**
 * Stage a captured frame:
 * - `mode:'photo'` (camera) → inline `<slicc-composer-capture>` mounted
 *    inside the composer band and anchored to its bottom so the enlarged
 *    box overlays the input textarea; the in-surface toggle reaches video;
 *    photo result → image attachment, video result → file attachment
 *    (WebM persisted to VFS).
 * - `mode:'screen'` (or anything else) → `getDisplayMedia` one-frame grab.
 */
async function stageCapture(
  detail: Record<string, unknown>,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (detail.mode === 'photo') {
    // No overlay host (preview / test harness) → fall back to the modal.
    if (!deps.composer) {
      const dataUrl = await capturePhotoFallback();
      if (!dataUrl) return;
      const name = `photo-${Date.now()}.png`;
      const writer = (await deps.openWriter?.().catch(() => null)) ?? null;
      const attachment = await attachmentFromCapture(name, dataUrl, writer);
      if (attachment) stage.add(attachment);
      return;
    }
    const result = await captureInline(deps.composer, 'photo');
    if (!result) return;
    if (result.kind === 'image') await stagePhotoResult(result, deps, stage);
    else if (result.kind === 'video') await stageVideoResult(result, deps, stage);
    return;
  }
  const dataUrl = await captureScreenshot();
  if (!dataUrl) return;
  const name = `screenshot-${Date.now()}.png`;
  const writer = (await deps.openWriter?.().catch(() => null)) ?? null;
  const attachment = await attachmentFromCapture(name, dataUrl, writer);
  if (attachment) stage.add(attachment);
}

/** Fallback camera capture via the legacy `<slicc-camera-dialog>` for hosts
 *  with no chat-pane overlay site. */
async function capturePhotoFallback(): Promise<string | null> {
  const dialog = document.createElement('slicc-camera-dialog');
  const preferred = localStorage.getItem(CAMERA_PREF_KEY);
  if (preferred) dialog.setAttribute('preferred-device', preferred);
  dialog.addEventListener('slicc-camera-device-change', (event) => {
    const id = (event as CustomEvent<{ deviceId?: string }>).detail?.deviceId;
    if (id) localStorage.setItem(CAMERA_PREF_KEY, id);
  });
  document.body.append(dialog);
  try {
    return await dialog.open();
  } finally {
    dialog.remove();
  }
}

/**
 * Persist a staged upload's raw bytes under {@link UPLOAD_DIR} and reference
 * the written path — never inline file content. Images within the inline cap
 * keep their base64 `data` (so the model still sees them) AND gain a `path` to
 * the full-resolution original; oversized images get the path with no inline
 * `data`. Once persisted, any inline-fallback `error` is cleared. When no
 * writer is available we degrade gracefully: images keep their inline data (no
 * path), and files surface a "not included" note rather than mojibake.
 */
async function persistStagedUpload(
  attachment: MessageAttachment,
  bytes: Uint8Array,
  deps: WireWcAttachDeps
): Promise<MessageAttachment> {
  const writer = (await deps.openWriter?.().catch(() => null)) ?? null;
  const path = writer
    ? await persistUpload(writer, attachment.name, bytes).catch(() => undefined)
    : undefined;
  if (path) return { ...attachment, error: undefined, path };
  // No writer (or the write failed): keep inline image data; for files there is
  // no inline content, so flag a clear "not included" reason.
  if (attachment.kind === 'image') return attachment;
  return { ...attachment, error: 'could not be saved to the virtual filesystem' };
}

/** Stage a VFS file pick by reference — the pick already HAS a canonical path,
 *  so link it directly instead of reading + inlining its contents. */
async function stageVfsFile(id: string, deps: WireWcAttachDeps, stage: WcAttachmentStage) {
  const name = id.split('/').pop() ?? id;
  if (IMAGE_EXT.test(name)) {
    // Images keep an inline copy for vision alongside the existing path.
    const reader = await deps.openReader();
    const raw = await reader.readFile(id);
    const bytes = typeof raw === 'string' ? new TextEncoder().encode(raw) : raw;
    const attachment = attachmentFromBytes(name, bytes);
    stage.add({ ...attachment, error: undefined, path: id });
    return;
  }
  let size = 0;
  try {
    size = (await (await deps.openReader()).stat(id)).size;
  } catch {
    // Stat failure leaves size at 0 — the reference line still renders.
  }
  stage.add({ id: uid(), name, mimeType: mimeFor(name), size, kind: 'file', path: id });
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
    const bytes = new Uint8Array(await detail.file.arrayBuffer());
    stage.add(await persistStagedUpload(await attachmentFromFile(detail.file), bytes, deps));
  } else if (detail.kind === 'capture') {
    await stageCapture(detail, deps, stage);
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
    // Full UI only: a file dragged anywhere in the window opens the add-menu and
    // activates its drop zone (the library default stays wrap-scoped).
    menu.setAttribute('global-drop', '');
  }

  inputCard.addEventListener('slicc-add', (event) => {
    const detail = (event as CustomEvent<Record<string, unknown>>).detail;
    if (!detail) return;
    void handleAdd(detail, deps, stage).catch((err) => log.error('WC add-menu action failed', err));
  });
  return stage;
}
