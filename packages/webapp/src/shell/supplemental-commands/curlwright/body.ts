import type { CommandContext } from 'just-bash';
import type { DataSpec, FormSpec } from './parse-args.js';

export const CURL_READ_ERROR = 26;

export interface BodyError {
  message: string;
  exitCode: number;
}

export interface ResolvedBody {
  bytes: Uint8Array | null;

  form: FormData | null;

  contentType: string | null;

  accept: string | null;
}

const ENCODER = new TextEncoder();

function isBodyError(value: unknown): value is BodyError {
  return typeof value === 'object' && value !== null && 'exitCode' in value;
}

async function readBytes(ctx: CommandContext, path: string): Promise<Uint8Array | BodyError> {
  try {
    return await ctx.fs.readFileBuffer(ctx.fs.resolvePath(ctx.cwd, path));
  } catch {
    return { message: `curlwright: cannot read ${path}`, exitCode: CURL_READ_ERROR };
  }
}

function stripNewlines(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length);
  let length = 0;
  for (const byte of bytes) {
    if (byte !== 0x0a && byte !== 0x0d) out[length++] = byte;
  }
  return out.subarray(0, length);
}

async function resolveUrlEncoded(
  ctx: CommandContext,
  value: string
): Promise<Uint8Array | BodyError> {
  const eq = value.indexOf('=');
  const at = value.indexOf('@');
  const useFile = at !== -1 && (eq === -1 || at < eq);
  const splitAt = useFile ? at : eq;
  const name = splitAt === -1 ? '' : value.slice(0, splitAt);
  const rest = splitAt === -1 ? value : value.slice(splitAt + 1);

  let content = rest;
  if (useFile) {
    const bytes = await readBytes(ctx, rest);
    if (isBodyError(bytes)) return bytes;
    content = new TextDecoder().decode(bytes);
  }
  const encoded = encodeURIComponent(content);
  return ENCODER.encode(name === '' ? encoded : `${name}=${encoded}`);
}

async function resolveDataSpec(
  ctx: CommandContext,
  spec: DataSpec
): Promise<Uint8Array | BodyError> {
  if (spec.kind === 'urlencode') return resolveUrlEncoded(ctx, spec.value);
  if (spec.kind === 'raw' || !spec.value.startsWith('@')) return ENCODER.encode(spec.value);
  const bytes = await readBytes(ctx, spec.value.slice(1));
  if (isBodyError(bytes)) return bytes;

  return spec.kind === 'binary' ? bytes : stripNewlines(bytes);
}

function joinParts(parts: Uint8Array[]): Uint8Array {
  const separators = Math.max(0, parts.length - 1);
  const total = parts.reduce((sum, part) => sum + part.length, 0) + separators;
  const out = new Uint8Array(total);
  let offset = 0;
  parts.forEach((part, index) => {
    if (index > 0) out[offset++] = 0x26;
    out.set(part, offset);
    offset += part.length;
  });
  return out;
}

function splitFormOptions(raw: string): { value: string; options: string[] } {
  const parts = raw.split(';');
  return { value: parts[0], options: parts.slice(1) };
}

function formOption(options: string[], key: string): string | null {
  for (const option of options) {
    const trimmed = option.trim();
    if (trimmed.startsWith(`${key}=`)) return trimmed.slice(key.length + 1);
  }
  return null;
}

function basename(path: string): string {
  const cleaned = path.replace(/\/+$/, '');
  const slash = cleaned.lastIndexOf('/');
  return slash === -1 ? cleaned : cleaned.slice(slash + 1);
}

async function appendFormPart(
  ctx: CommandContext,
  form: FormData,
  spec: FormSpec
): Promise<BodyError | null> {
  const eq = spec.value.indexOf('=');
  if (eq === -1) {
    return { message: `curlwright: -F requires name=content (got "${spec.value}")`, exitCode: 2 };
  }
  const name = spec.value.slice(0, eq);
  const rest = spec.value.slice(eq + 1);
  if (spec.literal || (rest[0] !== '@' && rest[0] !== '<')) {
    form.append(name, rest);
    return null;
  }
  const { value, options } = splitFormOptions(rest.slice(1));
  const bytes = await readBytes(ctx, value);
  if (isBodyError(bytes)) return bytes;
  if (rest[0] === '<') {
    form.append(name, new TextDecoder().decode(bytes));
    return null;
  }
  const type = formOption(options, 'type') ?? 'application/octet-stream';
  const filename = formOption(options, 'filename') ?? basename(value);
  form.append(name, new Blob([bytes as BlobPart], { type }), filename);
  return null;
}

export async function resolveBody(
  ctx: CommandContext,
  data: DataSpec[],
  form: FormSpec[]
): Promise<ResolvedBody | BodyError> {
  if (data.length > 0 && form.length > 0) {
    return { message: 'curlwright: -F cannot be combined with -d', exitCode: 2 };
  }
  if (form.length > 0) {
    const formData = new FormData();
    for (const spec of form) {
      const failure = await appendFormPart(ctx, formData, spec);
      if (failure) return failure;
    }
    return { bytes: null, form: formData, contentType: null, accept: null };
  }
  if (data.length === 0) return { bytes: null, form: null, contentType: null, accept: null };

  const parts: Uint8Array[] = [];
  for (const spec of data) {
    const resolved = await resolveDataSpec(ctx, spec);
    if (isBodyError(resolved)) return resolved;
    parts.push(resolved);
  }
  const json = data.some((spec) => spec.kind === 'json');
  return {
    bytes: joinParts(parts),
    form: null,
    contentType: json ? 'application/json' : 'application/x-www-form-urlencoded',
    accept: json ? 'application/json' : null,
  };
}
