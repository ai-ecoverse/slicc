const OPAQUE_LABEL = 'binary';

export function shortMimeLabel(mime: string): string {
  const base = mime.split(';', 1)[0]?.trim() ?? mime;
  if (base === 'application/octet-stream' || base.length === 0) return OPAQUE_LABEL;
  const subtype = base.slice(base.indexOf('/') + 1);

  return subtype.replace(/^x-/, '').replace(/\+.*$/, '');
}
