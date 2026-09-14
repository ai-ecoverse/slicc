const PREVIEW_HOST_RE = /^([^.]+)\.(?:sliccy\.(?:now|dev)|localhost(?::\d+)?)$/i;

function rehyphenateUuid(compact: string): string {
  return [
    compact.slice(0, 8),
    compact.slice(8, 12),
    compact.slice(12, 16),
    compact.slice(16, 20),
    compact.slice(20),
  ].join('-');
}

export interface PreviewHostResult {
  token: string;
  userHash: string | null;
}

export function previewTokenFromHost(host: string): PreviewHostResult | null {
  if (!host) return null;
  const m = host.match(PREVIEW_HOST_RE);
  if (!m) return null;
  const label = m[1];
  if (!label) return null;
  const separatorIndex = label.indexOf('--');
  if (separatorIndex === -1) return null;
  const compactUuid = label.slice(0, separatorIndex);
  if (compactUuid.length !== 32) return null;
  const remainder = label.slice(separatorIndex + 2);

  if (remainder.length > 8 && remainder[8] === '-') {
    const userHash = remainder.slice(0, 8);
    const secret = remainder.slice(9);
    return { token: `${rehyphenateUuid(compactUuid)}.${secret}`, userHash };
  }

  return { token: `${rehyphenateUuid(compactUuid)}.${remainder}`, userHash: null };
}
