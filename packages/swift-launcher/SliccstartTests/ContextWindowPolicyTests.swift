import Foundation
import XCTest
@testable import Sliccstart

/// Pins the math in `ContextWindowPolicy.resolve` — the hot path that
/// turns the running model's arch + the host's physical memory into
/// the integer that lands on SwiftLM's `--ctx-size`. There is no user
/// override; the policy alone owns the decision.
///
/// Hardcoded numbers come from real Apple Silicon configurations the
/// suggested catalog targets:
///   - Qwen 3.6 35B-A3B-4bit: 40 layers, 16 attn heads, head_dim 256,
///     declared `max_position_embeddings` 262 144.
///       perTokenKV = 2 × 40 × 16 × 256 × 2 = 655 360 bytes (640 KB).
///   - 64 GiB Mac (the gate floor) → 75 % budget = 48 GiB.
///   - 128 GiB Mac (development workstation) → 75 % budget = 96 GiB.
///
/// These are the inputs that previously crashed the user's machine
/// (256 K context allocated up front pushed resident past 120 GB).
/// The tests below pin the resolved ctx-size so a future "let's pass
/// the model's full max again" refactor regresses loudly.
final class ContextWindowPolicyTests: XCTestCase {

    private let oneGiB: UInt64 = 1024 * 1024 * 1024
    private let qwenPerTokenKV = 2 * 40 * 16 * 256 * 2  // 655 360
    private let qwenWeights: UInt64 = 18 * 1024 * 1024 * 1024  // 18 GiB
    private let qwenModelMax = 262_144

    // MARK: - perTokenKVBytes

    func testPerTokenKVBytesForQwen35B() {
        let caps = ModelCapabilities(
            supportsVision: false,
            maxContextSize: qwenModelMax,
            numHiddenLayers: 40,
            numAttentionHeads: 16,
            numKeyValueHeads: 2,
            headDim: 256
        )
        XCTAssertEqual(ContextWindowPolicy.perTokenKVBytes(caps), 655_360)
    }

    func testPerTokenKVBytesIsNilWhenArchUnknown() {
        XCTAssertNil(ContextWindowPolicy.perTokenKVBytes(.unknown))
    }

    func testPerTokenKVBytesUsesAttentionHeadsNotKVHeads() {
        // We deliberately overestimate by ignoring GQA — see policy
        // docs. Pin the choice so a future "optimize for GQA" change
        // can't silently halve the safety margin.
        let caps = ModelCapabilities(
            supportsVision: false,
            maxContextSize: 4096,
            numHiddenLayers: 1,
            numAttentionHeads: 16,
            numKeyValueHeads: 2,   // 8× smaller — would shrink result
            headDim: 1
        )
        // 2 × 1 × 16 × 1 × 2 = 64 — used the 16, not the 2.
        XCTAssertEqual(ContextWindowPolicy.perTokenKVBytes(caps), 64)
    }

    // MARK: - resolve: RAM ceiling

    /// On a 64 GiB Mac with Qwen 3.6 35B (18 GiB weights), 75 % budget
    /// is 48 GiB minus 18 GiB = 30 GiB for KV. At 640 KB/token that's
    /// ~49 152 tokens — well below the model's declared 256 K. Resolve
    /// must return the RAM-derived value, not the model max.
    func testRamCeilingClipsBelowModelMaxOnSixtyFourGiB() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 64 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertGreaterThan(resolved, 32_000)
        XCTAssertLessThan(resolved, 65_536, "RAM ceiling must clip below the 256K model max on a 64 GiB Mac")
    }

    /// **The exact regression we're fixing.** On a 128 GiB Mac with the
    /// same model, the RAM budget is 78 GiB → ~125 K tokens. Resolve
    /// must NOT pass the model's full 262 144 to SwiftLM, even though
    /// "use the largest window that fits" would be tempting.
    func testRamCeilingClampsTwoFiftySixKOnOneTwentyEightGiB() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertLessThan(resolved, qwenModelMax, "Must not pass the full 256 K window — that's the bug")
        // 78 GiB / 640 KB ≈ 127 720 tokens. Allow a generous tolerance
        // for the integer arithmetic in resolve().
        XCTAssertGreaterThan(resolved, 100_000)
        XCTAssertLessThan(resolved, 140_000)
    }

    // MARK: - resolve: model ceiling

    /// On a giant machine the RAM ceiling is far above the model's
    /// declared max — so the model max wins. Pins the precedence: we
    /// never exceed what the model itself says it supports, no matter
    /// how much RAM is available.
    func testModelMaxBeatsHugeRamCeiling() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: 32_768,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 1024 * oneGiB,    // 1 TiB — way more than needed
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, 32_768)
    }

    // MARK: - resolve: degenerate inputs

    /// Unknown perTokenKV → no RAM-derived ceiling, fall back to the
    /// model's declared maximum. (We refuse to invent a guess based
    /// on "what the model probably looks like.")
    func testUnknownArchUsesModelMaxAsCeiling() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: nil,
            physicalMemoryBytes: 64 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, qwenModelMax)
    }

    /// Model declares no max → fall back to the policy's `fallback`
    /// constant. Guards against passing nil/0 to SwiftLM and getting
    /// rejected at launch.
    func testFallbackWhenModelMaxIsNil() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: nil,
            perTokenKVBytes: nil,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: 0
        )
        XCTAssertEqual(resolved, ContextWindowPolicy.fallback)
    }

    /// Pathological: weights exceed the entire 75 % budget → KV budget
    /// is zero. We can't actually run the model in that case, but the
    /// policy must still return a positive integer so SwiftLM can
    /// surface the OOM rather than bail at arg parsing.
    func testReturnsAtLeastOneEvenWhenBudgetIsExhausted() {
        let resolved = ContextWindowPolicy.resolve(
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 8 * oneGiB,        // tiny
            modelWeightsBytes: 100 * oneGiB         // bigger than RAM
        )
        XCTAssertGreaterThanOrEqual(resolved, 1)
    }
}
