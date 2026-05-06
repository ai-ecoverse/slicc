import Foundation

/// Pure helper that decides what to pass to SwiftLM's `--ctx-size` flag.
/// There is no user-visible knob — Sliccstart looks at the host's RAM,
/// the model's declared maximum, and the per-token KV-cache footprint,
/// and picks the largest window that still fits inside 75 % of physical
/// memory after the weights are accounted for. The UI lives with
/// whatever this returns.
///
/// Why this exists: SwiftLM allocates KV-cache slots up front for the
/// requested context window. Passing the model's full declared
/// `max_position_embeddings` (262 144 for Qwen 3.6 35B) caused a 120 GB
/// peak resident on a 128 GB Mac because the per-token KV cost is
/// dominated by `num_attention_heads × head_dim` — turbo-kv's
/// past-8K compression doesn't shrink the *slot pool*, only its
/// in-place encoding.
enum ContextWindowPolicy {

    /// Last-resort fallback when nothing about the model is known.
    /// Matches the historical `SwiftLMProcess.fallbackContextSize`.
    static let fallback = 32_768

    /// Per-token KV-cache cost in bytes, conservatively estimated.
    ///
    /// Worst case for a transformer (no GQA, fp16 KV cache):
    ///   2 (K + V) × num_layers × num_attention_heads × head_dim × 2 bytes
    ///
    /// We deliberately use `num_attention_heads`, not
    /// `num_key_value_heads`. SwiftLM may or may not honor GQA in its
    /// allocator, and the failure mode of underestimating is OOM at a
    /// hardcoded ctx-size — overestimating just gives the user a
    /// slightly smaller window than physically possible. The tradeoff
    /// favors safety.
    static func perTokenKVBytes(_ caps: ModelCapabilities) -> Int? {
        guard let layers = caps.numHiddenLayers,
              let heads = caps.numAttentionHeads,
              let head = caps.headDim,
              layers > 0, heads > 0, head > 0 else {
            return nil
        }
        return 2 * layers * heads * head * 2
    }

    /// Resolve the final ctx-size to pass to `--ctx-size`.
    ///
    /// Returns `min(modelCeiling, ramCeiling)` — the largest window
    /// that fits both the model's declared maximum and the host's
    /// 75 %-of-RAM KV-cache budget. When the model arch is unknown the
    /// RAM ceiling drops out (we have no per-token estimate) and we
    /// fall back to the model ceiling alone; when both are unknown we
    /// return `fallback`.
    ///
    ///   - modelCeiling = `modelMaxContext ?? fallback`
    ///   - ramCeiling   = `(0.75 × physicalMemory − modelWeightsBytes) / perTokenKV`
    static func resolve(
        modelMaxContext: Int?,
        perTokenKVBytes: Int?,
        physicalMemoryBytes: UInt64,
        modelWeightsBytes: UInt64
    ) -> Int {
        let modelCeiling = modelMaxContext ?? Self.fallback

        let ramCeiling: Int
        if let kvCost = perTokenKVBytes, kvCost > 0 {
            let ramBudget = (physicalMemoryBytes * 75) / 100
            let kvBudget: UInt64 = ramBudget > modelWeightsBytes
                ? ramBudget - modelWeightsBytes
                : 0
            ramCeiling = Int(min(UInt64(Int.max), kvBudget / UInt64(kvCost)))
        } else {
            ramCeiling = Int.max
        }

        // Floor at 1 token so SwiftLM doesn't reject the flag at parse
        // time on pathologically small machines (the
        // LocalModelsAvailability 64 GB gate already excludes them, but
        // this is the math floor).
        return max(1, min(modelCeiling, ramCeiling))
    }
}
