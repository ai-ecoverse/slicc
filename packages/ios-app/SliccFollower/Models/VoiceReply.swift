import AVFoundation
import Foundation
import OSLog

/// The spoken-reply loop — the Swift twin of
/// `packages/webapp/src/speech/voice-reply.ts`.
///
/// A turn submitted by DICTATION gets its assistant reply read aloud; typed
/// turns stay silent. "Speak to it, it speaks back." The phone had the
/// listening half (push-to-talk) but not the answering half, so a hands-free
/// exchange still ended with the user having to look at the screen.
///
/// The web routes through Kokoro or Web Speech; iOS has one always-present
/// engine, `AVSpeechSynthesizer`, so the engine-selection layer collapses and
/// only the coordination survives.
@MainActor
final class VoiceReply {
    static let shared = VoiceReply()

    private let logger = Logger(subsystem: "com.sliccy.follower", category: "voice-reply")
    private let speaker: SpeechSpeaking

    /// Tracked as a COUNT, not a flag: queued dictated turns each mark a
    /// submission before any of them complete, and every completion must
    /// balance its own mark so a later typed turn is not read aloud.
    private var pendingCount = 0

    /// The engine is injectable so the coordination is testable without a
    /// live audio session; it defaults lazily because `AVSpeechSpeaker` is
    /// itself main-actor isolated.
    init(speaker: SpeechSpeaking? = nil) {
        self.speaker = speaker ?? AVSpeechSpeaker()
    }

    /// A dictated submission just went out — the next reply should be spoken.
    func markSubmission() {
        pendingCount += 1
    }

    /// Whether the completing turn was voice-initiated, decrementing when so.
    func consumeSubmission() -> Bool {
        guard pendingCount > 0 else { return false }
        pendingCount -= 1
        return true
    }

    /// Drop every pending mark — a disconnect or a new session must not let
    /// a stale mark speak the first reply of the next conversation.
    func reset() {
        pendingCount = 0
        speaker.stop()
    }

    /// Read an assistant reply aloud, markdown reduced to speakable prose.
    /// Best-effort: a failure never disturbs the chat flow.
    ///
    /// When the agent declared its reply language via `<!--lang:xx-->`, the
    /// reply is spoken ONLY if a voice exists for it — better silence than
    /// English prose mangled by the locale-default German voice.
    func speakReply(markdown: String) {
        let lang = DictationPriming.replyLang(markdown)
        if let lang, !speaker.hasVoice(for: lang) {
            logger.info("skipping spoken reply: no voice for \(lang, privacy: .public)")
            return
        }
        let text = Self.speechText(
            fromMarkdown: DictationPriming.stripReplyLangMarker(markdown))
        guard !text.isEmpty else { return }
        speaker.speak(text, lang: lang)
    }

    /// Stop any in-flight utterance (the user tapping to type, or aborting).
    func stopSpeaking() {
        speaker.stop()
    }

    // MARK: - Markdown → speech

    /// Spoken replies stay bounded; the cap only exists to keep runaway prose
    /// from monologuing.
    static let maxSpeechCharacters = 20000
    /// Inline code longer than this is a path or a blob, not a word.
    static let maxSpokenInlineCodeCharacters = 40

    /// Reduce markdown to speakable prose — the port of
    /// `speechTextFromMarkdown` in `speak.ts`. Order matters: fences go
    /// before inline code so a fence body is never mistaken for a span.
    static func speechText(fromMarkdown markdown: String) -> String {
        var text = markdown
        text = replace(#"```[\s\S]*?```"#, in: text, with: " ")
        text = replace(#"~~~[\s\S]*?~~~"#, in: text, with: " ")
        // An unterminated fence (a truncated reply) would otherwise leak its
        // whole body into speech — drop everything from the dangling opener.
        text = replace(#"(?:```|~~~)[\s\S]*$"#, in: text, with: " ")
        text = replace(#"!\[([^\]]*)\]\([^)]*\)"#, in: text, with: "$1")
        text = replace(#"\[([^\]]+)\]\([^)]*\)"#, in: text, with: "$1")
        text = replaceInlineCode(in: text)
        text = replace(#"<[^>\n]+>"#, in: text, with: " ")
        text = replace(#"^[ \t]{0,3}#{1,6}[ \t]+"#, in: text, with: "", multiline: true)
        text = replace(#"^[ \t]*>[ \t]?"#, in: text, with: "", multiline: true)
        text = replace(
            #"^[ \t]*(?:[-*+]|\d+[.)])[ \t]+"#, in: text, with: "", multiline: true)
        text = replace(#"[*_~]{1,3}([^*_~]+)[*_~]{1,3}"#, in: text, with: "$1")
        text = replace(#"\s+"#, in: text, with: " ")
        text = text.trimmingCharacters(in: .whitespacesAndNewlines)
        if text.count > maxSpeechCharacters {
            var clipped = String(text.prefix(maxSpeechCharacters))
            // Never end mid-word.
            if let lastSpace = clipped.lastIndex(of: " ") {
                clipped = String(clipped[clipped.startIndex..<lastSpace])
            }
            text = clipped + "…"
        }
        return text
    }

    /// Short inline code is spoken as its content; a long span is dropped.
    private static func replaceInlineCode(in text: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: "`([^`]*)`") else { return text }
        let full = NSRange(text.startIndex..., in: text)
        var result = ""
        var cursor = text.startIndex
        for match in regex.matches(in: text, range: full) {
            guard let matchRange = Range(match.range, in: text),
                let codeRange = Range(match.range(at: 1), in: text)
            else { continue }
            result += text[cursor..<matchRange.lowerBound]
            let code = String(text[codeRange])
            result += code.count > maxSpokenInlineCodeCharacters ? " " : code
            cursor = matchRange.upperBound
        }
        result += text[cursor...]
        return result
    }

    private static func replace(
        _ pattern: String, in text: String, with template: String, multiline: Bool = false
    ) -> String {
        let options: NSRegularExpression.Options = multiline ? [.anchorsMatchLines] : []
        guard let regex = try? NSRegularExpression(pattern: pattern, options: options) else {
            return text
        }
        return regex.stringByReplacingMatches(
            in: text, range: NSRange(text.startIndex..., in: text), withTemplate: template)
    }
}

// MARK: - Speech engine

/// The speaking seam. A protocol so the coordination above is testable
/// without a live audio session.
@MainActor
protocol SpeechSpeaking {
    func speak(_ text: String, lang: String?)
    func stop()
    func hasVoice(for lang: String) -> Bool
}

/// `AVSpeechSynthesizer` behind the seam.
@MainActor
final class AVSpeechSpeaker: SpeechSpeaking {
    /// Created on the first spoken reply, never at launch. Constructing a
    /// synthesizer wakes the system speech services on the main actor, and
    /// most sessions never dictate at all.
    private var synthesizer: AVSpeechSynthesizer?
    private let logger = Logger(subsystem: "com.sliccy.follower", category: "voice-reply")

    func speak(_ text: String, lang: String?) {
        configureSession()
        let utterance = AVSpeechUtterance(string: text)
        if let lang, let voice = Self.voice(for: lang) {
            utterance.voice = voice
        }
        let synthesizer = synthesizer ?? AVSpeechSynthesizer()
        self.synthesizer = synthesizer
        // Barge-in: a new reply replaces the one still playing rather than
        // queueing behind it.
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        synthesizer.speak(utterance)
    }

    func stop() {
        guard let synthesizer, synthesizer.isSpeaking else { return }
        synthesizer.stopSpeaking(at: .immediate)
    }

    func hasVoice(for lang: String) -> Bool {
        Self.voice(for: lang) != nil
    }

    /// An exact BCP-47 match first, then any voice sharing the base subtag —
    /// a `de` reply should still speak in `de-DE`.
    private static func voice(for lang: String) -> AVSpeechSynthesisVoice? {
        if let exact = AVSpeechSynthesisVoice(language: lang) { return exact }
        let base = lang.split(separator: "-").first.map(String.init)?.lowercased() ?? lang
        return AVSpeechSynthesisVoice.speechVoices().first {
            $0.language.lowercased().split(separator: "-").first.map(String.init) == base
        }
    }

    /// Push-to-talk leaves the session in a record-oriented mode; playback
    /// needs `.duckOthers` so the reply is audible over other audio and does
    /// not stop it outright.
    private func configureSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playAndRecord, mode: .spokenAudio,
                options: [.duckOthers, .defaultToSpeaker, .allowBluetooth])
            try session.setActive(true, options: [])
        } catch {
            logger.warning("audio session for spoken reply failed: \(error.localizedDescription)")
        }
    }
}
