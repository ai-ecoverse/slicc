import Foundation

/// Per-session dictation priming — the Swift twin of
/// `packages/webapp/src/speech/dictation-priming.ts`.
///
/// A turn submitted by push-to-talk carries AI-only markers so the model
/// tolerates transcription noise and answers in a speakable way, without
/// polluting the user-visible transcript:
///
/// - 🎙️ on EVERY dictated message.
/// - `◁ … ▷` wrapping a one-time priming note on the FIRST dictated turn of
///   a session.
///
/// The marked text is what gets stored AND sent, so replay and compaction
/// keep the context; the UI strips markers at render time.
enum DictationPriming {

    /// The one-time note, wrapped in ◁ … ▷ on the first dictated turn. Kept
    /// character-for-character in sync with the webapp so the phone and the
    /// browser prime the same model the same way.
    static let primingNote =
        "◁This message has been sent through text to speech, consider possible "
        + "phonetic alternatives and transcription errors. Future dictated messages "
        + "will have the 🎙️ emoji appended. Your responses to dictated messages "
        + "will be read out loud, avoid urls, acronyms, numbers, formatting. Begin "
        + "every reply with the language you are replying in as a hidden HTML "
        + "comment, e.g. <!--lang:en--> for English or <!--lang:de--> for German; "
        + "it stays hidden from the user and selects a matching voice▷"

    static let micGlyph = "\u{1F399}\u{FE0F}"

    /// Any ◁ … ▷ region (non-greedy, newline tolerant).
    private static let noteRegex = try? NSRegularExpression(
        pattern: "\u{25C1}[\\s\\S]*?\u{25B7}")
    /// Microphone glyph, with or without the VS16 variation selector.
    private static let micRegex = try? NSRegularExpression(
        pattern: "\u{1F399}\u{FE0F}?")
    /// The hidden reply-language marker, e.g. `<!--lang:de-->`; group 1 is
    /// the BCP-47 tag.
    private static let replyLangRegex = try? NSRegularExpression(
        pattern: "<!--\\s*lang:\\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\\s*-->",
        options: .caseInsensitive)

    /// Append the dictation markers. Pure — callers drive the "is first?"
    /// decision via ``consumeFirst()`` so this stays unit-testable.
    static func applyMarkers(_ text: String, isFirst: Bool) -> String {
        let base = text.hasSuffix(" ") ? text : "\(text) "
        return isFirst ? "\(base)\(micGlyph)\(primingNote)" : "\(base)\(micGlyph)"
    }

    /// Remove every dictation marker and trailing whitespace. Defensive: a
    /// message that is only markers yields the empty string.
    static func stripMarkers(_ text: String) -> String {
        var out = replaceAll(noteRegex, in: text, with: "")
        out = replaceAll(micRegex, in: out, with: "")
        while let last = out.last, last == " " || last == "\t" || last.isNewline {
            out.removeLast()
        }
        return out
    }

    /// The agent's declared reply language, or nil when it emitted none.
    static func replyLang(_ text: String) -> String? {
        guard let regex = replyLangRegex else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range),
            let tagRange = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[tagRange])
    }

    /// Remove every `<!--lang:xx-->` marker so it never reaches a bubble.
    static func stripReplyLangMarker(_ text: String) -> String {
        replaceAll(replyLangRegex, in: text, with: "")
    }

    // MARK: - Per-session first-turn flag

    private static var firstPending = true

    /// One-shot "is this the first dictated turn?" check. True ONCE per
    /// session (until the next reset); every later dictated turn gets false.
    static func consumeFirst() -> Bool {
        guard firstPending else { return false }
        firstPending = false
        return true
    }

    /// Re-arm the flag so a fresh session sends the priming note again.
    static func reset() {
        firstPending = true
    }

    private static func replaceAll(
        _ regex: NSRegularExpression?, in text: String, with template: String
    ) -> String {
        guard let regex else { return text }
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}
