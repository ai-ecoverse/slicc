import Foundation

/// UserDefaults key for the user-chosen SwiftLM context window size, in
/// tokens. `0` means "auto" — use the policy's default. Read at model
/// launch by `SwiftLMProcess.start()` via `ContextWindowPolicy`.
let swiftLMContextSizeKey = "swiftLMContextSize"

/// Pure helper that resolves the value to pass to SwiftLM's `--ctx-size`
/// flag, hard-capped at 75 % of physical RAM after subtracting the
/// model's weight footprint.
///
/// Why this exists: SwiftLM allocates KV-cache slots up front for the
/// requested context window. Passing the model's full declared
/// `max_position_embeddings` (262 144 for Qwen 3.6 35B) caused a 120 GB
/// peak resident on a 128 GB Mac because the per-token KV cost is
/// dominated by `num_attention_heads × head_dim` — turbo-kv's
/// past-8K compression doesn't shrink the *slot pool*, only its
/// in-place encoding. The cap here pre-empts that explosion, the user
/// override lets advanced users push it back up if they have headroom.
enum ContextWindowPolicy {

    /// Default ctx-size when the user picks "Auto" and the policy can't
    /// derive a tighter value. Generous enough for typical SLICC agent
    /// loops (~40 K-token prompts after a few tool rounds), conservative
    /// enough to fit comfortably on every machine that passes the 64 GB
    /// `LocalModelsAvailability` floor.
    static let autoDefault = 65_536

    /// Last-resort fallback when nothing about the model is known and
    /// `--ctx-size` would otherwise be omitted. Matches the historical
    /// `SwiftLMProcess.fallbackContextSize`.
    static let fallback = 32_768

    /// Discrete choices surfaced in the Models tab picker. `0` = auto.
    /// Real cap at run time is the lesser of the user's choice, the
    /// model's declared maximum, and the RAM-derived ceiling.
    static let pickerChoices: [Int] = [0, 8_192, 16_384, 32_768, 65_536, 131_072, 262_144]

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
    /// Precedence:
    ///   1. RAM ceiling = `(0.75 × physicalMemory − modelWeightsBytes) / perTokenKV`.
    ///   2. Model ceiling = `modelMaxContext` (the declared
    ///      `max_position_embeddings`).
    ///   3. User choice if non-zero, else the auto default.
    ///
    /// The returned value is `min(userChoice ?? auto, modelCeiling, ramCeiling)`.
    /// When `perTokenKVBytes` is unknown the RAM ceiling is treated as
    /// "no constraint" (we'd rather honor the user's request than
    /// silently downgrade based on a guess).
    static func resolve(
        userChoice: Int,
        modelMaxContext: Int?,
        perTokenKVBytes: Int?,
        physicalMemoryBytes: UInt64,
        modelWeightsBytes: UInt64
    ) -> Int {
        let modelCeiling = modelMaxContext ?? Self.fallback

        let ramCeiling: Int
        if let kvCost = perTokenKVBytes, kvCost > 0 {
            let ramBudget = (physicalMemoryBytes * 75) / 100
            // Leave at least a token of room for arithmetic safety on
            // pathologically small machines (the LocalModelsAvailability
            // gate already excludes them, but this is the math floor).
            let kvBudget: UInt64 = ramBudget > modelWeightsBytes
                ? ramBudget - modelWeightsBytes
                : 0
            ramCeiling = Int(min(UInt64(Int.max), kvBudget / UInt64(kvCost)))
        } else {
            ramCeiling = Int.max
        }

        let ceiling = min(modelCeiling, ramCeiling)
        let requested = userChoice > 0 ? userChoice : Self.autoDefault
        // If the ceiling itself is below 1, we have no choice but to
        // ask for at least 1; SwiftLM would reject 0. Caller can
        // surface this as an OOM-likely warning.
        return max(1, min(requested, ceiling))
    }
}
