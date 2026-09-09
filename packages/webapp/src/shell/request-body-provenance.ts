/**
 * Byte provenance for strings that came out of a VFS read.
 *
 * just-bash's `SecureFetchOptions.body` is typed `string`, so `curl -d @file`
 * / `-T file` can only hand us a JS string. `VfsAdapter.readFile` has to
 * decide how to turn the file's bytes into that string (UTF-8 when the bytes
 * decode cleanly, one-char-per-byte latin1 otherwise), and
 * `prepareRequestBody` has to decide how to turn the string back into bytes
 * (latin1 for a binary Content-Type, UTF-8 otherwise). Those two decisions
 * are made from different evidence, and when they disagree the request body
 * is silently corrupted:
 *
 *   - a file whose bytes are NOT valid UTF-8 sent with a text Content-Type
 *     took the latin1 read and the UTF-8 encode, so every byte ≥0x80 went out
 *     double-encoded (`E2 86 92` → `C3 A2 C2 86 C2 92`, i.e. `→` → `â†’`);
 *   - a valid UTF-8 file sent with a binary Content-Type took the UTF-8 read
 *     and the latin1 encode, so every multi-byte character collapsed onto one
 *     wrong byte (`→` → `92`).
 *
 * A string cannot carry the answer (`café` read from a UTF-8 file and from a
 * latin1 file are the same string), so the read parks its exact bytes here
 * under the string it returned and the fetch boundary looks them up. A miss (a
 * body the shell assembled from several pieces, a read past the budget below)
 * just falls back to the Content-Type convention.
 *
 * The string alone is NOT proof that a body came from the read that parked it:
 * an inline `curl -d 'é'` is the same string as a latin1 read of the single
 * byte `E9`, and substituting the file's bytes there would send `E9` where the
 * caller typed text that means `C3 A9`. Two guards keep a lookup honest:
 *
 *   - **one command line at a time** — `AlmostBashShellHeadless.runCommand`
 *     resets the table before each command, and a `curl` reads its `@file` and
 *     issues its request inside one command, so a read cannot reach an
 *     unrelated later body (nor another shell's, since the reset is global);
 *   - **ambiguity poisons the entry** — when two reads of DIFFERENT bytes
 *     decode to the same string (a latin1 `E9` file and a UTF-8 `C3 A9` one),
 *     neither can claim it, so the string stops resolving until the next
 *     command.
 *
 * What is left is a body prepared after the command that read it — a detached
 * job (`curl -d @f &`) whose fetch lands past the reset. That falls back to the
 * Content-Type convention, i.e. the behavior this module improves on, never a
 * substitution of some other file's bytes.
 *
 * This is the request-side sibling of `binary-cache.ts`, which does the same
 * for response bodies on their way to `writeFile`.
 */

/**
 * Longest a parked entry stays available. A body is handed to `fetch` in the
 * same turn as the read that produced it, so this only has to outlive the
 * command's own argument assembly.
 */
const TTL_MS = 10_000;

/**
 * Ceiling on the bytes parked at any one time. Every entry retains a copy of
 * the file's bytes for {@link TTL_MS}, so the budget bounds what a read loop
 * (`for f in *; do cat "$f"; done`) can pin. Bodies past it fall back to the
 * Content-Type convention, which is already correct for the large-payload case
 * that matters (a binary upload with a binary Content-Type).
 */
const MAX_PARKED_BYTES = 8 * 1024 * 1024;

interface ParkedRead {
  bytes: Uint8Array;
  timer: ReturnType<typeof setTimeout>;
}

/** Insertion-ordered so the oldest entry is the first eviction candidate. */
const parked = new Map<string, ParkedRead>();
let parkedBytes = 0;

/**
 * Strings two reads decoded from different bytes. They stay unresolvable for
 * the rest of the command: whichever read a body came from is exactly what this
 * module cannot tell, and guessing is what it exists to avoid.
 */
const ambiguous = new Set<string>();

function drop(text: string): void {
  const entry = parked.get(text);
  if (!entry) return;
  clearTimeout(entry.timer);
  parked.delete(text);
  parkedBytes -= entry.bytes.byteLength;
}

/** True when any byte needs a decoding decision (i.e. the string is ambiguous). */
function hasHighByte(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte >= 0x80) return true;
  }
  return false;
}

/** Drop CR and LF, the transform `curl -d @file` applies to a file it read. */
function stripNewlines(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.byteLength);
  let length = 0;
  for (const byte of bytes) {
    if (byte !== 0x0a && byte !== 0x0d) out[length++] = byte;
  }
  return out.slice(0, length);
}

/**
 * Remember that `text` is exactly what `bytes` decode to, so a later fetch can
 * send the bytes the file actually holds. All-ASCII reads are skipped: latin1
 * and UTF-8 agree on them, so there is nothing to recover.
 *
 * `curl -d @file` (as opposed to `--data-binary @file`) strips CR and LF from
 * what it read, so the newline-free form is parked too — it is the string that
 * reaches the fetch boundary. Removing those bytes cannot disturb a multi-byte
 * UTF-8 sequence, whose continuation bytes are all ≥0x80.
 */
export function parkReadBytes(text: string, bytes: Uint8Array): void {
  parkOne(text, bytes);
  const withoutNewlines = text.replace(/[\r\n]/g, '');
  if (withoutNewlines !== text) parkOne(withoutNewlines, stripNewlines(bytes));
}

/** Byte-for-byte equality, so a re-read of one file is not read as a conflict. */
function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

function parkOne(text: string, bytes: Uint8Array): void {
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_PARKED_BYTES) return;
  if (!hasHighByte(bytes)) return;
  if (ambiguous.has(text)) return;
  const existing = parked.get(text);
  if (existing && !sameBytes(existing.bytes, bytes)) {
    drop(text);
    ambiguous.add(text);
    return;
  }
  drop(text);
  // Evict oldest-first until the newcomer fits.
  for (const key of parked.keys()) {
    if (parkedBytes + bytes.byteLength <= MAX_PARKED_BYTES) break;
    drop(key);
  }
  parked.set(text, {
    bytes,
    timer: setTimeout(() => drop(text), TTL_MS),
  });
  parkedBytes += bytes.byteLength;
}

/**
 * The exact bytes `text` was decoded from, or `null` when it did not come
 * from a read this realm parked. Does NOT consume the entry: the same body
 * can be prepared more than once (a redirect re-sends it, `-v` prints it).
 */
export function lookupReadBytes(text: string): Uint8Array | null {
  return parked.get(text)?.bytes ?? null;
}

/**
 * Forget every parked read. Called at each shell command boundary (see the
 * module comment) so a read can only answer for a body in its own command, and
 * by tests that assert the fallback path.
 */
export function clearReadByteProvenance(): void {
  for (const key of [...parked.keys()]) drop(key);
  ambiguous.clear();
}
