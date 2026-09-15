/**
 * Normalization for the free-text reasons that ride an approval.
 *
 * Two fields use it: `SudoRequest.reason` (why the requester needs this) and
 * `SudoDecision.note` (what the approver said about the decision). Both are
 * untrusted prose written by an agent, and both land somewhere with a fixed
 * shape — a native `confirm` string, a dialog row, a one-line entry in
 * `list_sudo_requests`.
 *
 * Kept next to `SudoRequest`/`SudoDecision` rather than in the shell, because
 * both ends of the round trip need the same bound and neither should have to
 * import the other's layer to get it.
 */

/** Longest reason carried into an approval surface; longer text is truncated. */
export const MAX_SUDO_REASON_LENGTH = 300;

/**
 * Collapse `text` to a single trimmed line no longer than
 * {@link MAX_SUDO_REASON_LENGTH}.
 *
 * Both halves matter. Embedded newlines would break the layout of a native
 * dialog and the one-line-per-request shape of `list_sudo_requests`; an
 * unbounded string would let a requester push the actual SUBJECT of the
 * approval off the approver's screen behind a wall of prose. Same reasoning as
 * `sanitizeGrantPattern`, which collapses a grant pattern before it is
 * persisted.
 *
 * Truncation counts CODE POINTS, not UTF-16 units. A plain `slice` can cut an
 * astral character (emoji, and every non-BMP script) in half and leave a lone
 * surrogate; `JSON.stringify` emits that as an unpaired `\uDxxx` escape and
 * Foundation's decoder rejects the whole message — so a reason that happened
 * to end at the wrong offset would silently stop `sudo.approve.request` from
 * reaching an iOS approver. The cap is a display bound; losing one character
 * to keep it is cheaper than losing the prompt.
 */
export function normalizeSudoReason(text: string): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  if (oneLine.length <= MAX_SUDO_REASON_LENGTH) return oneLine;
  // `Array.from` iterates code points, so a surrogate pair stays intact.
  const points = Array.from(oneLine);
  if (points.length <= MAX_SUDO_REASON_LENGTH) return oneLine;
  return `${points
    .slice(0, MAX_SUDO_REASON_LENGTH - 1)
    .join('')
    .trimEnd()}…`;
}
