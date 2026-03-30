/**
 * Simple .env parser and writer — no external dependencies.
 *
 * Supports:
 * - KEY=VALUE lines (no quoting required)
 * - Single- and double-quoted values (quotes stripped)
 * - Comment lines starting with #
 * - Blank lines preserved on round-trip
 */

export interface EnvEntry {
  key: string;
  value: string;
}

/**
 * Parse .env file content into key-value pairs.
 * Blank lines and comments are skipped.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  for (const raw of content.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const eqIndex = line.indexOf('=');
    if (eqIndex === -1) continue; // malformed line, skip

    const key = line.slice(0, eqIndex).trim();
    let value = line.slice(eqIndex + 1).trim();

    // Strip matching quotes
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (key) {
      entries.push({ key, value });
    }
  }
  return entries;
}

/**
 * Serialize key-value pairs back to .env format.
 * Values containing spaces, #, or quotes are double-quoted.
 */
export function serializeEnvFile(entries: EnvEntry[]): string {
  const lines: string[] = [];
  for (const { key, value } of entries) {
    const needsQuoting = /[\s#"']/.test(value);
    const serialized = needsQuoting ? `"${value.replace(/"/g, '\\"')}"` : value;
    lines.push(`${key}=${serialized}`);
  }
  return lines.join('\n') + '\n';
}
