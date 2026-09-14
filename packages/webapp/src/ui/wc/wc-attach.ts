import { base64ToUint8, uint8ToBase64 } from '@slicc/shared-ts';
import type {
  CaptureDeviceChangeDetail,
  CaptureResult,
  PermissionGrant,
  PermissionKind,
} from '@slicc/webcomponents';
import type { MessageAttachment } from '../../core/attachments.js';
import type { LocalVfsClient } from '../../kernel/local-vfs-client.js';
import type { WritableVfsClient } from '../../kernel/writable-vfs-client.js';
import { getLeaderPermissionsSurface } from './wc-permissions-registry.js';

interface AddSection {
  kind: string;
  label: string;
  icon: string;
  entries: { id: string; label: string; sub?: string }[];
}

interface AddEventDetail {
  kind?: string;
  mode?: string;
  file?: File;
  id?: string;
  label?: string;
  name?: string;
  size?: number;
}

const MAX_ROWS_PER_SECTION = 8;

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
    return { ...base, mimeType: mimeFor(name), kind: 'image', data: uint8ToBase64(bytes) };
  }
  const file = { ...base, mimeType: mimeFor(name), kind: 'file' as const };

  return bytes.length > MAX_TEXT_BYTES ? { ...file, error: 'file too large to inline' } : file;
}

export async function attachmentFromFile(file: File): Promise<MessageAttachment> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const attachment = attachmentFromBytes(file.name, bytes);
  return file.type ? { ...attachment, mimeType: file.type } : attachment;
}

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

export const UPLOAD_DIR = '/tmp/upload';

const INLINE_MAX_EDGE = 1568;

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

export async function attachmentFromCapture(
  name: string,
  dataUrl: string,
  writer: WritableVfsClient | null
): Promise<MessageAttachment | null> {
  const full = attachmentFromDataUrl(name, dataUrl);
  if (!full) return null;
  let path: string | undefined;
  if (writer && full.data) {
    path = await persistUpload(writer, name, base64ToUint8(full.data)).catch(() => undefined);
  }
  const inline = attachmentFromDataUrl(name, await downscaleDataUrl(dataUrl).catch(() => dataUrl));
  return { ...(inline ?? full), name, path };
}

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

  listConversations(): Promise<{ id: string; label: string; sub?: string }[]>;
}

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
    } catch {}

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

async function grabFrame(stream: MediaStream): Promise<string | null> {
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  try {
    await video.play();

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

async function captureScreenshot(): Promise<string | null> {
  const surface = getLeaderPermissionsSurface();
  if (surface) {
    const grant = await surface.request('screenshare', { constraints: { video: true } });
    if (!grant) return null;
    const stream = (grant as Extract<PermissionGrant, { kind: 'screenshare' }>).stream;
    return grabFrame(stream);
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({ video: true });
  return grabFrame(stream);
}

async function probeCaptureKinds(
  kinds: PermissionKind[],
  description: string
): Promise<boolean | null> {
  const surface = getLeaderPermissionsSurface();
  if (!surface) return null;
  const result = await surface.prompt({ kinds, description, skipIfGranted: true });

  for (const grant of result.grants) {
    if (grant.kind === 'camera' || grant.kind === 'microphone' || grant.kind === 'screenshare') {
      for (const track of grant.stream.getTracks()) track.stop();
    }
  }
  return result.status === 'granted';
}

const CAMERA_PREF_KEY = 'slicc_camera_device';
const MIC_PREF_KEY = 'slicc_microphone_device';

const COMPACT_CSS = [
  'position:absolute',
  'left:50%',
  'right:auto',
  'transform:translateX(-50%)',
  'bottom:56px',
  'width:calc(100% - 32px)',
  'max-width:680px',
  'z-index:3',
].join(';');

async function captureInline(
  host: HTMLElement,
  initialMode: 'photo' | 'video'
): Promise<CaptureResult | null> {
  const granted = await probeCaptureKinds(
    ['camera', 'microphone'],
    'Slicc is requesting access to your camera and microphone to capture a photo or video for this conversation.'
  );
  if (granted === false) return null;

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

export interface WireWcAttachDeps {
  inputCard: HTMLElement & { value?: string };

  freezer: HTMLElement;

  composer?: HTMLElement;

  openReader?(): Promise<LocalVfsClient>;

  openWriter?(): Promise<WritableVfsClient>;

  listConversations?(): Promise<{ id: string; label: string; sub?: string }[]>;

  noCamera?: boolean;

  secretEntry?: boolean;
  log: { error(message: string, ...data: unknown[]): void };
}

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

async function stageCapture(
  detail: AddEventDetail,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (detail.mode === 'photo') {
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

async function capturePhotoFallback(): Promise<string | null> {
  const granted = await probeCaptureKinds(
    ['camera'],
    'Slicc is requesting access to your camera to capture a photo for this conversation.'
  );
  if (granted === false) return null;
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

  if (attachment.kind === 'image') return attachment;
  return { ...attachment, error: 'could not be saved to the virtual filesystem' };
}

async function readVfsImageBytes(
  id: string,
  openReader: () => Promise<LocalVfsClient>,
  log: WireWcAttachDeps['log']
): Promise<Uint8Array | null> {
  const reader = await openReader();
  const raw = await reader.readFile(id, { encoding: 'binary' });
  if (typeof raw !== 'string') return raw;
  log.error('VFS image pick returned text, not bytes — skipping the inline copy', id);
  return null;
}

async function referenceVfsFile(
  id: string,
  name: string,
  openReader: () => Promise<LocalVfsClient>
): Promise<MessageAttachment> {
  let size = 0;
  try {
    size = (await (await openReader()).stat(id)).size;
  } catch {}
  return { id: uid(), name, mimeType: mimeFor(name), size, kind: 'file', path: id };
}

async function stageVfsFile(
  id: string,
  openReader: () => Promise<LocalVfsClient>,
  stage: WcAttachmentStage,
  log: WireWcAttachDeps['log']
) {
  const name = id.split('/').pop() ?? id;
  if (IMAGE_EXT.test(name)) {
    const bytes = await readVfsImageBytes(id, openReader, log);
    if (bytes) {
      const attachment = attachmentFromBytes(name, bytes);
      stage.add({ ...attachment, error: undefined, path: id });
      return;
    }
  }
  stage.add(await referenceVfsFile(id, name, openReader));
}

function appendToDraft(text: string, inputCard: WireWcAttachDeps['inputCard']): void {
  const current = inputCard.value ?? inputCard.getAttribute('value') ?? '';
  const sep = current && !current.endsWith(' ') ? ' ' : '';
  inputCard.setAttribute('value', `${current}${sep}${text}`);
}

function insertSkillMention(label: string, inputCard: WireWcAttachDeps['inputCard']): void {
  appendToDraft(`Use the "${label}" skill: `, inputCard);
}

async function stageSecret(deps: WireWcAttachDeps): Promise<void> {
  const { requestSecretFromUser } = await import('./wc-secret-request.js');
  const outcome = await requestSecretFromUser();
  if (!outcome.stored) return;
  const scope = outcome.domains.join(', ');
  const lifetime = outcome.persisted ? 'saved' : 'this session only';
  appendToDraft(
    outcome.maskedValue
      ? `I stored the secret ${outcome.name} (masked value ${outcome.maskedValue}, scope: ${scope}, ${lifetime}). Use the masked value — SLICC swaps in the real one at the network boundary. `
      : `I stored the secret ${outcome.name} (scope: ${scope}, ${lifetime}). Run \`secret get ${outcome.name}\` for its masked value. `,
    deps.inputCard
  );
}

function isUserCancelledCapture(err: unknown): boolean {
  return (err as { name?: string } | null | undefined)?.name === 'NotAllowedError';
}

async function handleAdd(
  detail: AddEventDetail,
  deps: WireWcAttachDeps,
  stage: WcAttachmentStage
): Promise<void> {
  if (detail.kind === 'upload' && detail.file instanceof File) {
    const bytes = new Uint8Array(await detail.file.arrayBuffer());
    stage.add(await persistStagedUpload(await attachmentFromFile(detail.file), bytes, deps));
  } else if (detail.kind === 'capture') {
    await stageCapture(detail, deps, stage);
  } else if (detail.kind === 'file' && typeof detail.id === 'string' && deps.openReader) {
    await stageVfsFile(detail.id, deps.openReader, stage, deps.log);
  } else if (detail.kind === 'secret') {
    await stageSecret(deps);
  } else if (detail.kind === 'skill' && typeof detail.label === 'string') {
    insertSkillMention(detail.label, deps.inputCard);
  } else if (detail.kind === 'conversation' && typeof detail.id === 'string') {
    deps.freezer.dispatchEvent(
      new CustomEvent('freezer-card-select', {
        bubbles: true,
        composed: true,
        detail: { slug: detail.id },
      })
    );
  }
}

export function wireWcAttach(deps: WireWcAttachDeps): WcAttachmentStage {
  const { inputCard, log } = deps;
  const stage = new WcAttachmentStage(inputCard);
  const menu = inputCard.querySelector('slicc-add-menu') as
    | (HTMLElement & { provider?: unknown; results?: unknown })
    | null;
  if (menu) {
    if (deps.openReader) {
      menu.provider = createAddProvider({
        openReader: deps.openReader,
        listConversations: deps.listConversations ?? (async () => []),
      });
    } else {
      menu.results = [];
    }

    menu.setAttribute('global-drop', '');

    if (deps.noCamera) menu.setAttribute('no-camera', '');

    if (deps.secretEntry) menu.setAttribute('secret-action', '');
  }

  inputCard.addEventListener('slicc-add', (event) => {
    const detail = (event as CustomEvent<AddEventDetail>).detail;
    if (!detail) return;
    void handleAdd(detail, deps, stage).catch((err) => {
      if (isUserCancelledCapture(err)) return;
      log.error('WC add-menu action failed', err);
    });
  });

  inputCard.addEventListener('paste', (e) => {
    const items = (e as ClipboardEvent).clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (!item.type.startsWith('image/')) continue;
      const raw = item.getAsFile();
      if (!raw) continue;
      e.preventDefault();
      const ext = (raw.type.split('/')[1] || 'png').replace(/[^a-z0-9]/gi, '') || 'png';
      const file = raw.name ? raw : new File([raw], `pasted-image.${ext}`, { type: raw.type });
      const detail = { kind: 'upload', name: file.name, size: file.size, file };
      void handleAdd(detail, deps, stage).catch((err) => log.error('Paste image failed', err));
    }
  });

  return stage;
}
