/** Check whether a content type is safe to decode as UTF-8 text. */
export function isTextContentType(contentType: string): boolean {
  if (!contentType) return false;
  const normalized = contentType.toLowerCase();
  return (
    normalized.startsWith('text/') ||
    normalized.includes('json') ||
    normalized.includes('xml') ||
    normalized.includes('javascript') ||
    normalized.includes('ecmascript') ||
    normalized.includes('html') ||
    normalized.includes('css') ||
    normalized.includes('svg')
  );
}
