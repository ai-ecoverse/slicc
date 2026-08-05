import Foundation

/// Per-stage wall-clock timings (milliseconds) for one synthesis call.
struct KokoroAneStageTimings: Sendable, Equatable {
    var albert: Double = 0
    var postAlbert: Double = 0
    var alignment: Double = 0
    var prosody: Double = 0
    var noise: Double = 0
    var vocoder: Double = 0
    var tail: Double = 0

    /// Sum of all stages, in milliseconds.
    var totalMs: Double {
        albert + postAlbert + alignment + prosody + noise + vocoder + tail
    }

    init() {}
}

/// Detailed result of a `KokoroAneManager.synthesizeDetailed` call.
struct KokoroAneSynthesisResult: Sendable {
    /// 24 kHz mono fp32 PCM samples (raw, not WAV-wrapped).
    let samples: [Float]
    /// Sample rate (24,000 Hz for the laishere chain).
    let sampleRate: Int
    /// `T_enc` — phoneme tokens including BOS/EOS.
    let encoderTokens: Int
    /// `T_a` — acoustic frames produced by PostAlbert / Alignment.
    let acousticFrames: Int
    /// Per-stage timings.
    let timings: KokoroAneStageTimings

    /// Convenience: audio duration in seconds.
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

/// One of the 7 stages in the laishere chain.
enum KokoroAneStage: String, CaseIterable, Sendable {
    case albert
    case postAlbert
    case alignment
    case prosody
    case noise
    case vocoder
    case tail

    /// `.mlmodelc` filename on disk and on HuggingFace.
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
