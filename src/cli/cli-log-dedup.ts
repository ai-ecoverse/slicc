/**
 * Lightweight log deduplication for CLI-side console output.
 *
 * Fingerprints messages by replacing variable parts (numbers, IDs, hex, JSON blobs)
 * with placeholders, then suppresses duplicates within a sliding window.
 * Periodically flushes suppression counts so the operator knows what was hidden.
 */

const BUFFER_SIZE = 10;
const WINDOW_MS = 60_000; // 1 minute

interface Entry {
  fingerprint: string;
  count: number;
  firstSeen: number;
  /** The original first message, for the suppression summary. */
  sample: string;
}

function makeFingerprint(message: string): string {
  return (
    message
      // UUIDs
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
      // Hex strings (8+ chars, e.g. session IDs, target IDs)
      .replace(/\b[0-9A-Fa-f]{8,}\b/g, '<hex>')
      // JSON object/array blobs — collapse {...} and [...]
      .replace(/\{[^}]{20,}\}/g, '{…}')
      .replace(/\[[^\]]{20,}\]/g, '[…]')
      // Numbers (integers and floats)
      .replace(/\b\d+(\.\d+)?\b/g, '<n>')
  );
}

export class CliLogDedup {
  private entries: Entry[] = [];
  private prefix: string;

  constructor(prefix = '[cdp-proxy]') {
    this.prefix = prefix;
  }

  /**
   * Returns true if the message should be printed, false if suppressed.
   * Automatically flushes stale entries and emits suppression summaries.
   */
  shouldLog(message: string): boolean {
    const fp = makeFingerprint(message);
    const now = Date.now();

    // Evict stale entries
    this.evict(now);

    // Check for existing match
    const existing = this.entries.find((e) => e.fingerprint === fp);
    if (existing) {
      existing.count++;
      return false;
    }

    // New entry — evict oldest if buffer full
    if (this.entries.length >= BUFFER_SIZE) {
      const evicted = this.entries.shift()!;
      this.flushEntry(evicted);
    }

    this.entries.push({ fingerprint: fp, count: 0, firstSeen: now, sample: message.slice(0, 120) });
    return true;
  }

  private evict(now: number): void {
    while (this.entries.length > 0 && now - this.entries[0].firstSeen > WINDOW_MS) {
      const evicted = this.entries.shift()!;
      this.flushEntry(evicted);
    }
  }

  private flushEntry(entry: Entry): void {
    if (entry.count > 0) {
      console.log(`${this.prefix} (suppressed ${entry.count} similar: "${entry.sample}")`);
    }
  }
}
