import AVFoundation
import Foundation
import OSLog











@MainActor
final class VoiceReply {
    static let shared = VoiceReply()

    private let logger = Logger(subsystem: "com.sliccy.follower", category: "voice-reply")
    private let speaker: SpeechSpeaking

    
    
    
    
    
    
    
    
    
    private struct PendingReply {
        let scoopJid: String
        
        var messageId: String?
    }

    private var pending: [PendingReply] = []

    
    
    private static let maxPending = 8

    
    
    
    init(speaker: SpeechSpeaking? = nil) {
        self.speaker =
            speaker
            ?? KokoroSpeaker(
                modelDirectory: KokoroDevelopmentModels.directoryURL(),
                resourceDownloader: nil)
    }

    
    
    func markSubmission(scoopJid: String) {
        pending.append(PendingReply(scoopJid: scoopJid, messageId: nil))
        if pending.count > Self.maxPending { pending.removeFirst() }
        logger.notice("dictated turn marked (\(self.pending.count, privacy: .public) pending)")
    }

    
    
    
    
    func bindReply(scoopJid: String, messageId: String) {
        guard
            let idx = pending.firstIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == nil
            })
        else { return }
        pending[idx].messageId = messageId
    }

    
    
    
    func consumeSubmission(scoopJid: String, messageId: String) -> Bool {
        guard
            let idx = pending.firstIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == messageId
            })
        else { return false }
        pending.remove(at: idx)
        return true
    }

    
    func rollbackSubmission(scoopJid: String) {
        guard
            let idx = pending.lastIndex(where: {
                $0.scoopJid == scoopJid && $0.messageId == nil
            })
        else { return }
        pending.remove(at: idx)
    }

    
    
    func reset() {
        pending.removeAll()
        speaker.stop()
    }

    func prewarm() async {
        await speaker.prewarm()
    }

    
    
    
    
    
    
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

    
    func stopSpeaking() {
        speaker.stop()
    }

    

    
    
    static let maxSpeechCharacters = 20000
    
    static let maxSpokenInlineCodeCharacters = 40

    
    
    
    static func speechText(fromMarkdown markdown: String) -> String {
        var text = markdown
        text = replace(#"```[\s\S]*?```"#, in: text, with: " ")
        text = replace(#"~~~[\s\S]*?~~~"#, in: text, with: " ")
        
        
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
            
            if let lastSpace = clipped.lastIndex(of: " ") {
                clipped = String(clipped[clipped.startIndex..<lastSpace])
            }
            text = clipped + "…"
        }
        return text
    }

    
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
        
        
        utterance.rate = AVSpeechUtteranceDefaultSpeechRate * 0.92
        utterance.pitchMultiplier = 1.0
        let synthesizer = self.synthesizer ?? makeSynthesizer()
        
        
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
