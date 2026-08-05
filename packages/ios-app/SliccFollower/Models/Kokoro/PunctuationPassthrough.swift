public enum TextFrontendSegment: Equatable, Sendable {
    case word(String)
    case acoustic(Character)
}

public enum PunctuationPassthrough {
    public static let vocabularyPunctuation: Set<Character> = [
        ";", ":", ",", ".", "!", "?", "—", "…", "\"", "(", ")", "“", "”",
    ]
    private static let spokenSymbols: [Character: String] = ["%": "percent"]

    public static func acousticToken(for character: Character) -> Character? {
        if character.isWhitespace { return " " }
        return vocabularyPunctuation.contains(character) ? character : nil
    }

    public static func segments(in text: String) -> [TextFrontendSegment] {
        var segments: [TextFrontendSegment] = []
        var word = ""
        var pendingUnsupportedBoundary = false
        var insideDecimalFraction = false
        let characters = Array(text)

        func flushWord() {
            guard !word.isEmpty else { return }
            segments.append(.word(word))
            word.removeAll(keepingCapacity: true)
        }

        for index in characters.indices {
            let character = characters[index]
            if character.isNumber, insideDecimalFraction {
                flushWord()
                segments.append(.word(String(character)))
            } else if character.isLetter || character.isNumber {
                if pendingUnsupportedBoundary {
                    segments.append(.acoustic(" "))
                    pendingUnsupportedBoundary = false
                }
                word.append(character)
                insideDecimalFraction = false
            } else if isDecimalPoint(character, at: index, in: characters) {
                flushWord()
                segments.append(.word("point"))
                pendingUnsupportedBoundary = false
                insideDecimalFraction = true
            } else if isIntraWordJoiner(character, at: index, in: characters) {
                word.append(isHyphen(character) ? "-" : character)
                insideDecimalFraction = false
            } else {
                let endedWord = !word.isEmpty
                flushWord()
                if let token = acousticToken(for: character) {
                    segments.append(.acoustic(token))
                    pendingUnsupportedBoundary = false
                } else if let spoken = spokenSymbols[character] {
                    segments.append(.word(spoken))
                    pendingUnsupportedBoundary = false
                } else if endedWord {
                    pendingUnsupportedBoundary = true
                }
                insideDecimalFraction = false
            }
        }
        flushWord()
        return segments
    }

    public static func phonemize(
        _ text: String,
        wordPhonemizer: (String) async throws -> String?
    ) async rethrows -> String {
        var output = ""
        var previousWasWord = false

        for segment in segments(in: text) {
            switch segment {
            case .word(let word):
                guard let phonemes = try await wordPhonemizer(word), !phonemes.isEmpty else {
                    continue
                }
                if previousWasWord { output.append(" ") }
                output.append(phonemes)
                previousWasWord = true
            case .acoustic(let token):
                output.append(token)
                previousWasWord = false
            }
        }
        return output
    }

    private static func isIntraWordJoiner(
        _ character: Character,
        at index: Int,
        in characters: [Character]
    ) -> Bool {
        guard character == "'" || character == "’" || isHyphen(character),
            index > characters.startIndex,
            index < characters.index(before: characters.endIndex)
        else { return false }
        let before = characters[characters.index(before: index)]
        let after = characters[characters.index(after: index)]
        return (before.isLetter || before.isNumber) && (after.isLetter || after.isNumber)
    }

    private static func isDecimalPoint(
        _ character: Character,
        at index: Int,
        in characters: [Character]
    ) -> Bool {
        guard character == ".", index > characters.startIndex,
            index < characters.index(before: characters.endIndex)
        else { return false }
        return characters[characters.index(before: index)].isNumber
            && characters[characters.index(after: index)].isNumber
    }

    private static func isHyphen(_ character: Character) -> Bool {
        character == "-" || character == "‐" || character == "‑"
    }
}
