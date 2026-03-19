/**
 * Normalizes accessibility tree values into stable snapshot-friendly strings.
 */
export function normalizeAccessibilityText(value: unknown, fallback = ''): string {
  if (value == null) return fallback;
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') {
    return String(value);
  }
  try {
    const json = JSON.stringify(value);
    return json ?? fallback;
  } catch {
    return String(value);
  }
}
