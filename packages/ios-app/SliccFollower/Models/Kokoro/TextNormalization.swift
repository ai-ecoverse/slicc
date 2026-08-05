import Foundation

private final class MisakiResourceBundleToken: NSObject {}

private var misakiResourceBundle: Bundle {
    #if SWIFT_PACKAGE
        Bundle.module
    #else
        Bundle(for: MisakiResourceBundleToken.self)
    #endif
}

public enum TextResolution: Equatable, Sendable {
    case phonemes(String)
    case fallback(String)
}

public enum MisakiLexiconError: LocalizedError {
    case missingResource(String)
    case invalidDictionary(String)

    public var errorDescription: String? {
        switch self {
        case .missingResource(let name): "Missing bundled Misaki resource: \(name)"
        case .invalidDictionary(let name): "Invalid bundled Misaki dictionary: \(name)"
        }
    }
}

public struct MisakiUSLexicon: Sendable {
    private let gold: [String: String]
    private let silver: [String: String]

    public init(goldData: Data, silverData: Data) throws {
        gold = try Self.decode(goldData, name: "us_gold.json")
        silver = try Self.decode(silverData, name: "us_silver.json")
    }

    public static func bundled() throws -> Self {
        let names = ["us_gold", "us_silver"]
        let urls = try names.map { name in
            guard let url = misakiResourceBundle.url(forResource: name, withExtension: "json") else {
                throw MisakiLexiconError.missingResource("\(name).json")
            }
            return url
        }
        return try Self(goldData: Data(contentsOf: urls[0]), silverData: Data(contentsOf: urls[1]))
    }

    public func lookup(_ word: String) -> String? {
        gold[word] ?? silver[word]
    }

    private static func decode(_ data: Data, name: String) throws -> [String: String] {
        guard let source = try JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            throw MisakiLexiconError.invalidDictionary(name)
        }
        var result: [String: String] = [:]
        result.reserveCapacity(source.count)
        for (word, value) in source {
            if let phonemes = value as? String {
                result[word] = phonemes
            } else if let variants = value as? [String: Any],
                let phonemes = variants["DEFAULT"] as? String
            {
                result[word] = phonemes
            }
        }
        return result
    }
}

public struct TextNormalization: Sendable {
    private enum Piece {
        case word(String)
        case letter(Character)
    }

    private let lexicon: MisakiUSLexicon

    public init(lexicon: MisakiUSLexicon) {
        self.lexicon = lexicon
    }

    public static func bundled() throws -> Self {
        try Self(lexicon: .bundled())
    }

    public func resolve(token: String) -> [TextResolution] {
        let pieces = pieces(for: token)
        return pieces.enumerated().map { index, piece in
            if let phonemes = pronunciation(for: piece, at: index, in: pieces) {
                return .phonemes(phonemes)
            }
            switch piece {
            case .word(let word): return .fallback(word)
            case .letter(let letter): return .fallback(String(letter))
            }
        }
    }

    public func render(
        _ text: String,
        fallback: (String) async throws -> String
    ) async rethrows -> String {
        var output = ""
        var previousWasWord = false
        for segment in PunctuationPassthrough.segments(in: text) {
            switch segment {
            case .acoustic(let character):
                output.append(character)
                previousWasWord = false
            case .word(let token):
                var parts: [String] = []
                for resolution in resolve(token: token) {
                    switch resolution {
                    case .phonemes(let phonemes): parts.append(phonemes)
                    case .fallback(let word): parts.append(try await fallback(word))
                    }
                }
                if previousWasWord, !parts.isEmpty { output.append(" ") }
                output += parts.joined(separator: " ")
                previousWasWord = !parts.isEmpty
            }
        }
        return output
    }

    private func pieces(for token: String) -> [Piece] {
        let normalized = token.replacingOccurrences(of: "’", with: "'")
        return normalized.split(separator: "-").flatMap { component -> [Piece] in
            let word = String(component)
            if let number = numberWords(word) { return number.map(Piece.word) }
            if word.count > 1, word.allSatisfy({ $0.isASCII && $0.isUppercase && $0.isLetter }) {
                return word.map(Piece.letter)
            }
            return [.word(word)]
        }
    }

    private func pronunciation(for piece: Piece, at index: Int, in pieces: [Piece]) -> String? {
        switch piece {
        case .letter(let letter):
            let raw =
                ["C": "sˈI", "P": "pˈI"][String(letter)]
                ?? lexicon.lookup(String(letter))
            guard let raw else { return nil }
            let stress = index == pieces.index(before: pieces.endIndex) ? "ˈ" : "ˌ"
            return raw.replacingOccurrences(of: "ˈ", with: stress)
        case .word(let word):
            let lower = word.lowercased()
            if lower == "the" {
                let next = pieces.indices.contains(index + 1) ? basePronunciation(pieces[index + 1]) : nil
                return next.map(startsWithVowelSound) == true ? "ði" : "ðə"
            }
            // The frozen baseline uses Kokoro's older pronunciation; current Misaki returns ɹˈiᵊl.
            if lower == "real" { return "ɹˈIl" }
            return lexicon.lookup(word).map { normalizeLexiconPronunciation($0, for: word) }
        }
    }

    private func basePronunciation(_ piece: Piece) -> String? {
        switch piece {
        case .letter(let letter): return lexicon.lookup(String(letter))
        case .word(let word): return lexicon.lookup(word)
        }
    }

    private func normalizeLexiconPronunciation(_ pronunciation: String, for word: String) -> String {
        if word.count == 1, word == word.lowercased(), pronunciation == "A" { return "ə" }
        var result = pronunciation
        if word.count <= 2, word == word.lowercased(), word.allSatisfy(\.isLetter) {
            result.removeAll(where: { $0 == "ˌ" })
        }
        if !result.contains(where: { $0 == "ˈ" || $0 == "ˌ" }) {
            result = result.replacingOccurrences(of: "ʌ", with: "ə")
            if word.contains("'") || word.contains("’") {
                result = addingPrimaryStress(to: result)
            }
        }
        return result
    }

    private func addingPrimaryStress(to pronunciation: String) -> String {
        guard let vowel = pronunciation.firstIndex(where: { Self.vowelPhonemes.contains($0) }) else {
            return pronunciation
        }
        return pronunciation[..<vowel] + "ˈ" + pronunciation[vowel...]
    }

    private func startsWithVowelSound(_ phonemes: String) -> Bool {
        phonemes.first(where: { $0 != "ˈ" && $0 != "ˌ" }).map {
            Self.vowelPhonemes.contains($0)
        } ?? false
    }

    private func numberWords(_ text: String) -> [String]? {
        guard !text.isEmpty, text.allSatisfy({ $0.isASCII && $0.isNumber }) else { return nil }
        guard let value = Int(text) else { return text.compactMap(Self.digitWord) }
        if (2001...2099).contains(value) { return Self.cardinal(value / 100) + Self.cardinal(value % 100) }
        if value <= 9_999 { return Self.cardinal(value) }
        return text.compactMap(Self.digitWord)
    }

    private static let vowelPhonemes = "AIOWYaiuæɑɒɔəɛɜɪʊʌᵻ"
    private static let units = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]
    private static let teens = ["ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen", "nineteen"]
    private static let tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"]

    private static func digitWord(_ character: Character) -> String? {
        character.wholeNumberValue.map { units[$0] }
    }

    private static func cardinal(_ value: Int) -> [String] {
        if value < 10 { return [units[value]] }
        if value < 20 { return [teens[value - 10]] }
        if value < 100 { return [tens[value / 10]] + (value % 10 == 0 ? [] : [units[value % 10]]) }
        if value < 1_000 {
            return [units[value / 100], "hundred"] + (value % 100 == 0 ? [] : cardinal(value % 100))
        }
        return cardinal(value / 1_000) + ["thousand"] + (value % 1_000 == 0 ? [] : cardinal(value % 1_000))
    }
}
