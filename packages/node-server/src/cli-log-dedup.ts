const BUFFER_SIZE = 10;
const WINDOW_MS = 60_000;

interface Entry {
  fingerprint: string;
  count: number;
  firstSeen: number;

  sample: string;
}

function makeFingerprint(message: string): string {
  return message

    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')

    .replace(/\b[0-9A-Fa-f]{8,}\b/g, '<hex>')

    .replace(/\{[^}]{20,}\}/g, '{…}')
    .replace(/\[[^\]]{20,}\]/g, '[…]')

    .replace(/\b\d+(\.\d+)?\b/g, '<n>');
}

export class CliLogDedup {
  private entries: Entry[] = [];
  private prefix: string;

  constructor(prefix = '[cdp-proxy]') {
    this.prefix = prefix;
  }

  shouldLog(message: string): boolean {
    const fp = makeFingerprint(message);
    const now = Date.now();

    this.evict(now);

    const existing = this.entries.find((e) => e.fingerprint === fp);
    if (existing) {
      existing.count++;
      return false;
    }

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
