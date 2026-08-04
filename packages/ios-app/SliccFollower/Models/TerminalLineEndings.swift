import Foundation

/// `ONLCR` translation for leader output.
///
/// The leader executes commands with no PTY in the path, so its bytes carry
/// bare `\n` line endings the way any program writing to a pipe does. Ghostty
/// is a real terminal emulator: a bare LF moves the cursor down one row and
/// leaves the column where it was, so multi-line output renders as a
/// staircase. A kernel PTY would apply this translation itself via the termios
/// `ONLCR` flag; with no PTY here, the follower is the only place left to do
/// it.
///
/// Kept as a value type rather than inline in the view model so the
/// chunk-boundary behaviour is unit-testable without a Ghostty surface.
struct TerminalLineEndings {

    /// Whether the previous byte emitted was a CR. Carried across calls: the
    /// leader is free to split a `\r\n` pair across two `exec.chunk`
    /// messages, and translating the orphaned `\n` would insert a second CR.
    private var trailingCarriageReturn = false

    /// Rewrites a bare LF to CRLF, leaving an existing CRLF alone.
    mutating func normalize(_ data: Data) -> Data {
        // The overwhelmingly common cases are output with no newline at all
        // and output already in CRLF, so scan before allocating.
        guard data.contains(0x0A) else {
            if let last = data.last { trailingCarriageReturn = last == 0x0D }
            return data
        }

        var out = Data()
        out.reserveCapacity(data.count + 8)
        for byte in data {
            if byte == 0x0A && !trailingCarriageReturn {
                out.append(0x0D)
            }
            trailingCarriageReturn = byte == 0x0D
            out.append(byte)
        }
        return out
    }

    /// Drops the carry. Called when the surface is reset, so a `\r` left over
    /// from a previous session cannot swallow the next one's first CR.
    mutating func reset() {
        trailingCarriageReturn = false
    }
}
