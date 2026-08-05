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
/// Like the web, iOS routes English replies through Kokoro when its local
/// models are present and otherwise falls back to the system synthesizer.
@MainActor
final class VoiceReply {
    static let shared = VoiceReply()

    private let logger = Logger(subsystem: "com.sliccy.follower", category: "voice-reply")
    private let speaker: SpeechSpeaking

    /// One dictated submission awaiting its answer.
    ///
    /// The web tracks a bare count because a browser turn is strictly
    /// sequential. The phone is not: scoops stream concurrently, and a
    /// dictated turn can be queued while a TYPED turn is still streaming.
    /// A count would then let the wrong reply consume the mark — the typed
    /// answer gets read aloud and the dictated one stays silent. Each mark
    /// therefore names the scoop it was sent to, and binds to a specific
    /// assistant message as soon as that scoop opens its next one.
    private struct PendingReply {
        let scoopJid: String
        /// nil until the answering `message_start` arrives.
        var messageId: String?
    }

    private var pending: [PendingReply] = []

    /// A runaway leader that never completes a turn must not grow this
    /// without bound; the oldest mark is dropped rather than retained.
    private static let maxPending = 8

    /// The engine is injectable so the coordination is testable without a
    /// live audio session. The default router keeps the system voice as a
    /// no-model, non-English, failure, and timeout fallback.
    init(speaker: SpeechSpeaking? = nil) {
        self.speaker =
            speaker
            ?? KokoroSpeaker(
                modelDirectory: KokoroDevelopmentModels.directoryURL(),
                resourceDownloader: nil)
    }

    /// A dictated submission just went out to `scoopJid` — its answer should
    /// be spoken.
    func markSubmission(scoopJid: String) {
        pending.append(PendingReply(scoopJid: scoopJid, messageId: nil))
        if pending.count > Self.maxPending { pending.removeFirst() }
        logger.notice("dictated turn marked (\(self.pending.count, privacy: .public) pending)")
    }

    /// Bind the oldest unbound mark for `scoopJid` to the assistant message
    /// that just opened. The first message a scoop starts after a dictated
    /// submission IS its answer, which is what separates it from a typed
    /// turn that was already streaming when the dictation went out.
    func bindReply(scoopJid: String, messageId: String) {
        guard
            let idx = pending.firstIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == nil
            })
        else { return }
        pending[idx].messageId = messageId
    }

    /// Whether the completing message answers a dictated turn, retiring the
    /// mark when it does. Only a BOUND mark matches, so a reply that was
    /// already in flight when the user dictated can never claim it.
    func consumeSubmission(scoopJid: String, messageId: String) -> Bool {
        guard
            let idx = pending.firstIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == messageId
            })
        else { return false }
        pending.remove(at: idx)
        return true
    }

    /// Drop the most recent mark — the send it was armed for never left.
    func rollbackSubmission(scoopJid: String) {
        guard
            let idx = pending.lastIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == nil
            })
        else { return }
        pending.remove(at: idx)
    }

    /// Drop every pending mark — a disconnect or a new session must not let
    /// a stale mark speak the first reply of the next conversation.
    func reset() {
        pending.removeAll()
        speaker.stop()
    }

    func prewarm() async {
        await speaker.prewarm()
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
        guard !text.isEmpty else {
            logger.info("spoken reply skipped: nothing speakable in the reply")
            return
        }
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
    func prewarm() async
    func speak(_ text: String, lang: String?)
    func stop()
    func hasVoice(for lang: String) -> Bool
}

extension SpeechSpeaking {
    func prewarm() async {}
}

/// `AVSpeechSynthesizer` behind the seam.
///
/// `NSObject` because `AVSpeechSynthesizerDelegate` requires it — the
/// delegate is how we learn the reply finished and can hand the audio route
/// back to whatever was playing before.
@MainActor
final class AVSpeechSpeaker: NSObject, SpeechSpeaking, AVSpeechSynthesizerDelegate {
    struct VoiceCandidate: Equatable {
        enum Quality: Int {
            case `default`
            case enhanced
            case premium
        }

        let identifier: String
        let language: String
        let quality: Quality
    }

    /// Created on the first spoken reply, never at launch. Constructing a
    /// synthesizer wakes the system speech services on the main actor, and
    /// most sessions never dictate at all.
    private var synthesizer: AVSpeechSynthesizer?
    private let audioSession: any AudioSessionCoordinating
    private var sessionActive = false
    private let logger = Logger(subsystem: "com.sliccy.follower", category: "voice-reply")

    override init() {
        audioSession = AudioSessionCoordinator.shared
        super.init()
    }

    init(audioSession: any AudioSessionCoordinating) {
        self.audioSession = audioSession
        super.init()
    }

    func speak(_ text: String, lang: String?) {
        guard activateSession() else { return }
        let utterance = AVSpeechUtterance(string: text)
        if let lang, let voice = Self.voice(for: lang) {
            utterance.voice = voice
        }
        // A small relative slowdown improves clarity across languages, while
        // neutral pitch preserves each installed voice's designed prosody.
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
        utterance.pitchMultiplier = 1.0
        let synthesizer = self.synthesizer ?? makeSynthesizer()
        // Barge-in: a new reply replaces the one still playing rather than
        // queueing behind it.
        if synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        logger.notice(
            "speaking reply: \(text.count, privacy: .public) chars, lang \(lang ?? "default", privacy: .public)"
        )
        synthesizer.speak(utterance)
    }

    func stop() {
        if let synthesizer, synthesizer.isSpeaking {
            synthesizer.stopSpeaking(at: .immediate)
        }
        releaseSession()
    }

    func hasVoice(for lang: String) -> Bool {
        Self.voice(for: lang) != nil
    }

    private func makeSynthesizer() -> AVSpeechSynthesizer {
        let created = AVSpeechSynthesizer()
        created.delegate = self
        synthesizer = created
        return created
    }

    /// Enumerate on every lookup so newly installed voices are immediately
    /// eligible without a stale cache after the system's voices-change event.
    private static func voice(for lang: String) -> AVSpeechSynthesisVoice? {
        let voices = AVSpeechSynthesisVoice.speechVoices()
        let candidates = voices.map {
            VoiceCandidate(
                identifier: $0.identifier,
                language: $0.language,
                quality: quality(of: $0))
        }
        guard let selected = rankedVoice(for: lang, from: candidates) else { return nil }
        return voices.first { $0.identifier == selected.identifier }
    }

    /// Select from supplied value types so ranking needs no live speech service.
    /// Exact BCP-47 matches precede base-subtag fallbacks, then quality ranks
    /// premium > enhanced > default. Voice identifier is the stable final
    /// tiebreak.
    static func rankedVoice(
        for lang: String,
        from voices: [VoiceCandidate]
    ) -> VoiceCandidate? {
        let replyBase = baseLanguage(of: lang)
        let exact = voices.filter {
            $0.language.caseInsensitiveCompare(lang) == .orderedSame
        }
        let matching: [VoiceCandidate]
        if exact.isEmpty {
            matching = voices.filter { baseLanguage(of: $0.language) == replyBase }
        } else {
            matching = exact
        }
        return matching.min {
            if $0.quality != $1.quality { return $0.quality.rawValue > $1.quality.rawValue }
            return $0.identifier < $1.identifier
        }
    }

    private static func baseLanguage(of language: String) -> String {
        language.split(separator: "-").first.map(String.init)?.lowercased() ?? language.lowercased()
    }

    private static func quality(of voice: AVSpeechSynthesisVoice) -> VoiceCandidate.Quality {
        switch voice.quality {
        case .premium:
            return .premium
        case .enhanced:
            return .enhanced
        case .default:
            return .default
        @unknown default:
            return .default
        }
    }

    /// Sliccy answering is MEDIA, not a notification: `.playback` so the reply
    /// is heard with the ring switch flipped and routes to the speaker on its
    /// own. Dictation leaves the session on `.record` and deactivated, so the
    /// category has to be reclaimed for every reply — and taking `.playback`
    /// rather than `.playAndRecord` also drops the microphone, which nothing
    /// needs while the phone is the one talking.
    private func activateSession() -> Bool {
        do {
            try audioSession.beginPlayback(preferredSampleRate: nil)
            sessionActive = true
            return true
        } catch {
            logger.error("spoken reply audio session failed: \(error.localizedDescription)")
            return false
        }
    }

    /// Hand the route back so ducked audio returns to full volume and the
    /// next push-to-talk hold can claim the microphone.
    private func releaseSession() {
        guard sessionActive else { return }
        audioSession.endPlayback()
        sessionActive = false
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance
    ) {
        MainActor.assumeIsolated { releaseSession() }
    }

    nonisolated func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer, didCancel utterance: AVSpeechUtterance
    ) {
        MainActor.assumeIsolated { releaseSession() }
    }
}
