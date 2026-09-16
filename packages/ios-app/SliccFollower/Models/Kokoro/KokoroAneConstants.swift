import Foundation

enum KokoroAneConstants {

    static let defaultVoice = "af_heart"

    static let sampleRate = 24_000

    static let bosTokenId: Int32 = 0
    static let eosTokenId: Int32 = 0

    static let maxInputTokens = 512
    static let maxPhonemeLength = 510

    static let voicePackRows = 510
    static let voicePackCols = 256

    static let maxAcousticFrames = 2_000

    static let defaultSpeed: Float = 1.0
}

enum KokoroAneVariant: String, CaseIterable, Sendable {
    case english

    var defaultVoice: String {
        switch self {
        case .english: return KokoroAneConstants.defaultVoice
        }
    }

    var repo: Repo {
        switch self {
        case .english: return .kokoroAne
        }
    }
}
