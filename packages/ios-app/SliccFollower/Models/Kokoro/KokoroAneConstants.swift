import Foundation

/// Compile-time constants for the laishere/kokoro 7-stage CoreML chain.
///
/// Source of truth: mobius/models/tts/kokoro/laishere-coreml/convert-coreml.py
/// (specifically `compute_shape_bounds(max_frames=2000)` and the per-stage
/// I/O contracts).
enum KokoroAneConstants {

    /// Default voice id for the English (`ANE/`) variant.
    static let defaultVoice = "af_heart"

    /// Output sample rate of the iSTFT in `KokoroTail.mlpackage`.
    static let sampleRate = 24_000

    /// BOS / EOS token id used by both `convert-coreml.py` and the iOS demo.
    static let bosTokenId: Int32 = 0
    static let eosTokenId: Int32 = 0

    /// ALBERT context window — input_ids cannot exceed this, so the IPA
    /// phoneme sequence (excluding BOS/EOS) must be ≤ 510.
    static let maxInputTokens = 512
    static let maxPhonemeLength = 510

    /// Voice pack rows × columns. The pack is stored flat as `[510, 256]` fp32:
    ///   * row index = `min(max(T_enc - 1, 0), 509)` (utterance-length bucket)
    ///   * cols `[0..<128]`   = `style_timbre` (→ Noise + Vocoder)
    ///   * cols `[128..<256]` = `style_s`      (→ PostAlbert + Prosody)
    static let voicePackRows = 510
    static let voicePackCols = 256

    /// `--max-frames` baked into the converted models. Sentences whose `T_a`
    /// exceeds this must be skipped or chunked.
    static let maxAcousticFrames = 2_000

    /// Default playback speed factor for PostAlbert.
    static let defaultSpeed: Float = 1.0
}

/// Language variant of the laishere/kokoro 7-stage CoreML chain.
///
/// The 7-stage chain is language-agnostic by construction (input ids, voice
/// slices, and per-stage I/O contracts are identical across variants). Only
/// the embedding vocab, HF subdirectory, voice-file layout, and the default
/// voice id differ.
///
/// | Variant      | HF subdir | Vocab | Default voice | Voice layout       |
/// |--------------|-----------|-------|---------------|--------------------|
/// | `.english`   | `ANE/`    | 177   | `af_heart`    | flat (`<voice>.bin`)            |
/// | `.mandarin`  | `ANE-zh/` | 171   | `zf_001`      | nested (`voices/<voice>.bin`)   |
enum KokoroAneVariant: String, CaseIterable, Sendable {
    case english

    /// Default voice id shipped with the variant's bundle.
    var defaultVoice: String {
        switch self {
        case .english: return KokoroAneConstants.defaultVoice
        }
    }

    /// HuggingFace repo case for this variant.
    var repo: Repo {
        switch self {
        case .english: return .kokoroAne
        }
    }
}
