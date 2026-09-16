import Foundation

enum TranscriptLink: Equatable {

    case file(path: String, line: Int?)

    case phone(String)

    case code(String)

    static let scheme = "slicc-transcript"

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

enum PhoneMentions {

    struct Candidate: Equatable {
        let number: String
        let offset: Int
        let length: Int

        var range: Range<Int> { offset..<(offset + length) }
    }

    private static let detector: NSDataDetector? = {
        try? NSDataDetector(types: NSTextCheckingResult.CheckingType.phoneNumber.rawValue)
    }()

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
