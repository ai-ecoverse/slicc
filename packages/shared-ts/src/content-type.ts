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

export function isFormContentType(contentType: string): boolean {
  if (!contentType) return false;
  return contentType.toLowerCase().includes('urlencoded');
}

export function isTextRequestContentType(contentType: string): boolean {
  if (!contentType) return false;
  return isTextContentType(contentType) || isFormContentType(contentType);
}
