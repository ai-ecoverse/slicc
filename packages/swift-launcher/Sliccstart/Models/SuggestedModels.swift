import Foundation

/// Curated catalog of MLX-quantized models the user can install with one
/// click from the Models tab. Pulled from the spec; expand as new releases
/// land. Repo IDs are direct HuggingFace identifiers.
struct SuggestedModel: Identifiable, Equatable, Hashable {
    let repoId: String
    /// Short headline shown above the description, e.g. `"26B MoE · 4-bit"`.
    let summary: String
    /// One-line note on when to pick this model.
    let note: String
    /// Approximate download size in GB. Surfaced in the UI so the user
    /// knows what they're committing to before clicking Install.
    let approxSizeGB: Double

    var id: String { repoId }
}

enum SuggestedModels {
    static let all: [SuggestedModel] = [
        SuggestedModel(
            repoId: "mlx-community/Qwen3.6-35B-A3B-4bit",
            summary: "35B MoE (A3B) · 4-bit · recommended",
            note: "Best at tool calls with the SLICC system prompt. MoE sparsity + MLX kernels keep it fast.",
            approxSizeGB: 18
        ),
        SuggestedModel(
            repoId: "mlx-community/Qwen3.6-27B-4bit",
            summary: "27B dense · 4-bit",
            note: "Smaller on disk than Qwen3.6-35B-A3B, but dense — every token activates all 27B params, so generation is markedly slower than the 35B-A3B MoE.",
            approxSizeGB: 14
        ),
        // Gemma 4 entries dropped:
        //  - mlx-community/gemma-4-26b-a4b-it-4bit narrates commands instead
        //    of calling tools when given the SLICC system prompt; reliable
        //    only with a minimal "you must call tools" prompt.
        //  - mlx-community/gemma-4-31b-mxfp4 ships without `chat_template`
        //    in tokenizer_config.json and swift-transformers rejects every
        //    chat completion with `missingChatTemplate`. Re-add once the
        //    mlx-community upload includes the template.
    ]
}
