export function errorDetailsToRawString(details: unknown): string | undefined {
  if (details == null) return undefined;
  if (typeof details === 'string') return details;
  if (details instanceof Error) return formatErrorInstance(details);
  if (typeof details === 'object') return objectErrorText(details);
  if (typeof details === 'number' || typeof details === 'boolean' || typeof details === 'bigint') {
    return String(details);
  }
  return undefined;
}

export function formatErrorDetails(details: unknown): string | undefined {
  if (details != null && typeof details === 'object' && !(details instanceof Error)) {
    return messageFromUnknown(details) ?? errorTypeFromUnknown(details);
  }
  const raw = errorDetailsToRawString(details);
  if (raw === undefined) return undefined;
  return unwrapStructuredErrorMessage(raw);
}

export function unwrapStructuredErrorMessage(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return raw;
  const direct = messageFromJson(trimmed);
  if (direct) return direct;
  const start = trimmed.indexOf('{');
  const end = trimmed.lastIndexOf('}');
  if (start > 0 && end > start) {
    const embedded = messageFromJson(trimmed.slice(start, end + 1));
    if (embedded) return embedded;
  }
  return raw;
}

function formatErrorInstance(error: Error): string {
  const name = error.name && error.name !== 'Error' ? error.name : '';
  const message = error.message || '';
  if (name && message) return `${name}: ${message}`;
  return message || name || 'Error';
}

function objectErrorText(obj: object): string | undefined {
  const message = messageFromUnknown(obj);
  const type = errorTypeFromUnknown(obj);
  if (type && message) return `${type}: ${message}`;
  return message ?? type;
}

function messageFromJson(text: string): string | undefined {
  if (!text.startsWith('{')) return undefined;
  try {
    return messageFromUnknown(JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

function messageFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as { message?: unknown; error?: unknown };
  if (typeof obj.message === 'string' && obj.message.length > 0) return obj.message;
  if (typeof obj.error === 'string' && obj.error.length > 0) return obj.error;
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as { message?: unknown };
    if (typeof inner.message === 'string' && inner.message.length > 0) return inner.message;
  }
  return undefined;
}

function errorTypeFromUnknown(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const obj = value as { type?: unknown; error?: unknown };
  if (obj.error && typeof obj.error === 'object') {
    const inner = obj.error as { type?: unknown };
    if (typeof inner.type === 'string' && inner.type.length > 0) return inner.type;
  }
  if (typeof obj.type === 'string' && obj.type.length > 0 && obj.type !== 'error') return obj.type;
  return undefined;
}
