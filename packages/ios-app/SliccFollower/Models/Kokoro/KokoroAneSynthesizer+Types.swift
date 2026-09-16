import Foundation

struct KokoroAneStageTimings: Sendable, Equatable {
    var albert: Double = 0
    var postAlbert: Double = 0
    var alignment: Double = 0
    var prosody: Double = 0
    var noise: Double = 0
    var vocoder: Double = 0
    var tail: Double = 0

    var totalMs: Double {
        albert + postAlbert + alignment + prosody + noise + vocoder + tail
    }

    init() {}
}

struct KokoroAneSynthesisResult: Sendable {

    let samples: [Float]

    let sampleRate: Int

    let encoderTokens: Int

    let acousticFrames: Int

    let timings: KokoroAneStageTimings

    var durationSeconds: Double {
        Double(samples.count) / Double(sampleRate)
    }

    init(
        samples: [Float],
        sampleRate: Int,
        encoderTokens: Int,
        acousticFrames: Int,
        timings: KokoroAneStageTimings
    ) {
        self.samples = samples
        self.sampleRate = sampleRate
        self.encoderTokens = encoderTokens
        self.acousticFrames = acousticFrames
        self.timings = timings
    }
}

enum KokoroAneStage: String, CaseIterable, Sendable {
    case albert
    case postAlbert
    case alignment
    case prosody
    case noise
    case vocoder
    case tail

    var bundleName: String {
        switch self {
        case .albert: return "KokoroAlbert.mlmodelc"
        case .postAlbert: return "KokoroPostAlbert.mlmodelc"
        case .alignment: return "KokoroAlignment.mlmodelc"
        case .prosody: return "KokoroProsody.mlmodelc"
        case .noise: return "KokoroNoise.mlmodelc"
        case .vocoder: return "KokoroVocoder.mlmodelc"
        case .tail: return "KokoroTail.mlmodelc"
        }
    }
}
