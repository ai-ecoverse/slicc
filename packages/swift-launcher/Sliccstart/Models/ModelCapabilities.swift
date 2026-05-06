import Foundation
import os

private let log = Logger(subsystem: "com.slicc.sliccstart", category: "ModelCapabilities")

/// Capabilities Sliccstart can infer from a HuggingFace model's local
/// snapshot, without loading the weights. Used to pick the right SwiftLM
/// CLI flags before spawning the server.
struct ModelCapabilities: Equatable {
    /// True when the model is a vision-language model — SwiftLM has to be
    /// launched with `--vision` so it routes through `VLMModelFactory`
    /// instead of the text-only path.
    let supportsVision: Bool

    /// Max context window the model declares. Read from the snapshot's
    /// `config.json` (top-level `max_position_embeddings`, falling back to
    /// `text_config.max_position_embeddings` for multimodal configs).
    /// `nil` when neither key is present — caller should use a defensive
    /// default in that case.
    let maxContextSize: Int?

    /// Architecture parameters needed to estimate per-token KV-cache
    /// footprint before launch. All `nil` when we couldn't read the
    /// config — caller must fall back to a conservative default.
    let numHiddenLayers: Int?
    let numAttentionHeads: Int?
    let numKeyValueHeads: Int?
    let headDim: Int?

    static let unknown = ModelCapabilities(
        supportsVision: false,
        maxContextSize: nil,
        numHiddenLayers: nil,
        numAttentionHeads: nil,
        numKeyValueHeads: nil,
        headDim: nil
    )
}

/// Mirrors `ModelArchitectureProbe` in SwiftLM (Sources/MLXInferenceCore).
/// We can't depend on SwiftLM as a Swift package — it pulls in MLX Swift
/// forks via local-path dependencies — so the lookup is duplicated here
/// keyed on the same `model_type` / `processor_class` strings.
enum ModelArchProbe {
    /// `model_type` values whose presence implies vision support. Lifted
    /// directly from SwiftLM's `ModelArchitectureProbe.knownVisionModelTypes`.
    private static let visionModelTypes: Set<String> = [
        "paligemma",
        "qwen2_vl",
        "qwen2-vl",
        "qwen2_5_vl",
        "qwen2.5-vl",
        "qwen3_vl",
        "qwen3-vl",
        "qwen3_5",
        "qwen3.5",
        "qwen3_5_moe",
        "idefics3",
        "gemma3",
        "gemma4",
        "smolvlm",
        "fastvlm",
        "llava_qwen2",
        "pixtral",
        "mistral3",
        "lfm2_vl",
        "lfm2-vl",
        "glm_ocr",
    ]

    private static let visionProcessors: Set<String> = [
        "PaliGemmaProcessor",
        "Qwen2VLProcessor",
        "Qwen2_5_VLProcessor",
        "Qwen3VLProcessor",
        "Idefics3Processor",
        "Gemma3Processor",
        "Gemma4Processor",
        "SmolVLMProcessor",
        "FastVLMProcessor",
        "PixtralProcessor",
        "Mistral3Processor",
        "Lfm2VlProcessor",
        "Glm46VProcessor",
    ]

    /// Probe the cached snapshot for `repoId` (e.g. `mlx-community/gemma-4-26b-a4b-it-4bit`).
    /// Returns `.unknown` if the snapshot directory isn't found — callers
    /// should treat that as "no capabilities detected" rather than failing
    /// the launch.
    static func capabilities(for repoId: String) -> ModelCapabilities {
        guard let snapshot = snapshotDirectory(for: repoId) else {
            log.info("capabilities: no snapshot for \(repoId, privacy: .public)")
            return .unknown
        }

        let config = readJSON(at: snapshot.appendingPathComponent("config.json"))
        let preprocessor = readJSON(at: snapshot.appendingPathComponent("preprocessor_config.json"))

        let modelType = (config?["model_type"] as? String).map { normalize($0) }
        let processorClass = preprocessor?["processor_class"] as? String

        let supportsVision =
            (modelType.map { visionModelTypes.contains($0) } ?? false)
            || (processorClass.map { visionProcessors.contains($0) } ?? false)
            || config?["vision_config"] != nil
            || preprocessor?["image_processor_type"] != nil

        // Some configs put context length at the top level (text-only
        // models), others tuck it into `text_config` (Gemma 4, Qwen-VL).
        // Try both before giving up. Same pattern for the arch params
        // we use to estimate KV cache footprint.
        let textConfig = config?["text_config"] as? [String: Any]
        func intKey(_ key: String) -> Int? {
            (config?[key] as? Int) ?? (textConfig?[key] as? Int)
        }
        let maxContext = intKey("max_position_embeddings")

        return ModelCapabilities(
            supportsVision: supportsVision,
            maxContextSize: maxContext,
            numHiddenLayers: intKey("num_hidden_layers"),
            numAttentionHeads: intKey("num_attention_heads"),
            numKeyValueHeads: intKey("num_key_value_heads"),
            headDim: intKey("head_dim")
        )
    }

    /// Most recent snapshot directory under `models--<org>--<name>/snapshots/`.
    /// HF cache stores each commit hash in a separate folder; for a given
    /// `revision: "main"` the entry is symlinked from `refs/main`.
    private static func snapshotDirectory(for repoId: String) -> URL? {
        let safe = "models--" + repoId.replacingOccurrences(of: "/", with: "--")
        let repoRoot = HFCache.hubDirectory.appendingPathComponent(safe, isDirectory: true)
        let snapshotsRoot = repoRoot.appendingPathComponent("snapshots", isDirectory: true)
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(atPath: snapshotsRoot.path),
              let first = entries.first(where: { !$0.hasPrefix(".") }) else {
            return nil
        }
        return snapshotsRoot.appendingPathComponent(first, isDirectory: true)
    }

    /// SwiftLM lowercases and replaces `.` with `_`; we mirror so our set
    /// membership matches their canonicalisation.
    private static func normalize(_ raw: String) -> String {
        raw.lowercased().replacingOccurrences(of: ".", with: "_")
    }

    private static func readJSON(at url: URL) -> [String: Any]? {
        guard FileManager.default.fileExists(atPath: url.path),
              let data = try? Data(contentsOf: url),
              let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return parsed
    }
}
