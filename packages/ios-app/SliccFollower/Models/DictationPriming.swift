import Foundation














enum DictationPriming {

    
    
    
    static let primingNote =
        "◁This message has been sent through text to speech, consider possible "
        + "phonetic alternatives and transcription errors. Future dictated messages "
        + "will have the 🎙️ emoji appended. Your responses to dictated messages "
        + "will be read out loud, avoid urls, acronyms, numbers, formatting. Begin "
        + "every reply with the language you are replying in as a hidden HTML "
        + "comment, e.g. <!--lang:en--> for English or <!--lang:de--> for German; "
        + "it stays hidden from the user and selects a matching voice▷"

    static let micGlyph = "\u{1F399}\u{FE0F}"

    
    private static let noteRegex = try? NSRegularExpression(
        pattern: "\u{25C1}[\\s\\S]*?\u{25B7}")
    
    private static let micRegex = try? NSRegularExpression(
        pattern: "\u{1F399}\u{FE0F}?")
    
    
    private static let replyLangRegex = try? NSRegularExpression(
        pattern: "<!--\\s*lang:\\s*([A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*)\\s*-->",
        options: .caseInsensitive)

    
    
    static func applyMarkers(_ text: String, isFirst: Bool) -> String {
        let base = text.hasSuffix(" ") ? text : "\(text) "
        return isFirst ? "\(base)\(micGlyph)\(primingNote)" : "\(base)\(micGlyph)"
    }

    
    
    static func stripMarkers(_ text: String) -> String {
        var out = replaceAll(noteRegex, in: text, with: "")
        out = replaceAll(micRegex, in: out, with: "")
        while let last = out.last, last == " " || last == "\t" || last.isNewline {
            out.removeLast()
        }
        return out
    }

    
    static func replyLang(_ text: String) -> String? {
        guard let regex = replyLangRegex else { return nil }
        let range = NSRange(text.startIndex..., in: text)
        guard let match = regex.firstMatch(in: text, range: range),
            let tagRange = Range(match.range(at: 1), in: text)
        else { return nil }
        return String(text[tagRange])
    }

    
    static func stripReplyLangMarker(_ text: String) -> String {
        replaceAll(replyLangRegex, in: text, with: "")
    }

    

    private static var firstPending = true

    
    
    
    static var isFirstPending: Bool { firstPending }

    
    
    
    static func commitFirst() {
        firstPending = false
    }

    
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
