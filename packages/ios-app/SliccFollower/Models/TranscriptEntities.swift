import Foundation

// MARK: - Transcript action links

/// The private URL scheme the transcript uses to make a span actionable.
///
/// SwiftUI paints inline markdown as a single `Text`/`NSAttributedString`, and
/// the only per-span hook either layer offers is `.link`. So everything the
/// transcript wants to act on — a phone number, a confirmed file, a run of
/// inline code — is carried as a link in a scheme nothing else can open, and
/// `TranscriptText` (long press) and the `openURL` action (tap) decode it back
/// into an intent.
///
/// The scheme is deliberately NOT registered in `Info.plist`: it must never
/// escape to the system. `ChatView.transcriptLinkAction` swallows every one of
/// them, so a build that somehow leaks one gets a dead tap rather than a
/// mystery app switch.
enum TranscriptLink: Equatable {
    /// A file the leader confirmed exists. Opens the preview sheet.
    case file(path: String, line: Int?)
    /// A phone number. Opens Messages by default (`sms:`).
    case phone(String)
    /// Pre-formatted text — an inline `code` run. Copies on tap; Share
    /// lives in the long-press menu with every other span's.
    case code(String)

    static let scheme = "slicc-transcript"

    /// Longest run of inline code that gets its own action link.
    ///
    /// The text rides inside the URL, so an accidentally enormous `code` span
    /// (a whole file backticked on one line) would build a multi-kilobyte URL
    /// per render. Past this the run stays inert — the fenced code block above
    /// it is the affordance for anything that big.
    static let maximumCodeLength = 2048

    var url: URL? {
        var components = URLComponents()
        components.scheme = Self.scheme
        switch self {
        case .file(let path, let line):
            components.host = "file"
            components.queryItems =
                [URLQueryItem(name: "path", value: path)]
                + (line.map { [URLQueryItem(name: "line", value: String($0))] } ?? [])
        case .phone(let number):
            components.host = "phone"
            components.queryItems = [URLQueryItem(name: "number", value: number)]
        case .code(let text):
            guard text.count <= Self.maximumCodeLength else { return nil }
            components.host = "code"
            components.queryItems = [URLQueryItem(name: "text", value: text)]
        }
        return components.url
    }

    /// Decode a transcript link, or `nil` when `url` is not one of ours.
    static func decode(_ url: URL) -> TranscriptLink? {
        guard url.scheme?.lowercased() == scheme,
            let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { return nil }
        let items = components.queryItems ?? []
        func value(_ name: String) -> String? {
            items.first { $0.name == name }?.value
        }
        switch components.host {
        case "file":
            guard let path = value("path"), !path.isEmpty else { return nil }
            return .file(path: path, line: value("line").flatMap(Int.init))
        case "phone":
            guard let number = value("number"), !number.isEmpty else { return nil }
            return .phone(number)
        case "code":
            guard let text = value("text"), !text.isEmpty else { return nil }
            return .code(text)
        default:
            return nil
        }
    }

    /// Where a tapped phone number goes by default.
    ///
    /// Messages, not the dialer: a transcript number is far more often
    /// something to text a link to than something to ring, and `tel:` on a
    /// device with no cellular plan is a dead end. Calling stays one long
    /// press away in the share sheet.
    var systemURL: URL? {
        switch self {
        case .phone(let number):
            let digits = number.filter { $0.isNumber || $0 == "+" }
            guard !digits.isEmpty else { return nil }
            return URL(string: "sms:\(digits)")
        case .file, .code:
            return nil
        }
    }
}

// MARK: - Phone mentions

/// Phone numbers in prose, found with the system detector.
///
/// `NSDataDetector` is the same engine Messages and Mail use, so a number the
/// transcript linkifies is exactly the set of numbers the rest of the phone
/// treats as a number — including the locale-specific shapes a hand-rolled
/// regex would miss. There is no web counterpart to mirror here: the browser
/// gets this from the platform too, it just does not surface it.
enum PhoneMentions {
    /// A number found in prose. Character offsets, matching
    /// `FileMentions.Candidate` so one annotation pass can treat both alike.
    struct Candidate: Equatable {
        let number: String
        let offset: Int
        let length: Int

        var range: Range<Int> { offset..<(offset + length) }
    }

    private static let detector: NSDataDetector? = {
        try? NSDataDetector(types: NSTextCheckingResult.CheckingType.phoneNumber.rawValue)
    }()

    /// The shortest run of digits believed to be a number.
    ///
    /// The detector will happily claim a bare `12345` — a port, an issue
    /// number, a line count — and a transcript is full of those. Real numbers
    /// carry an area or country code, so the floor buys back most of the false
    /// positives at no cost to the ones worth tapping.
    static let minimumDigits = 7

    static func scan(_ text: String) -> [Candidate] {
        guard let detector, !text.isEmpty else { return [] }
        return detector.matches(in: text, range: NSRange(text.startIndex..., in: text))
            .compactMap { match in
                guard match.resultType == .phoneNumber, let number = match.phoneNumber,
                    let range = Range(match.range, in: text),
                    number.filter(\.isNumber).count >= minimumDigits
                else { return nil }
                return Candidate(
                    number: number,
                    offset: text.distance(from: text.startIndex, to: range.lowerBound),
                    length: text.distance(from: range.lowerBound, to: range.upperBound))
            }
    }

}
