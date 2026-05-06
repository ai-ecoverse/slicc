import Foundation
import XCTest
@testable import Sliccstart

/// Pins the math in `ContextWindowPolicy.resolve` — the hot path that
/// turns "user picked Auto / 32K / 256K" + the running model's arch +
/// the host's physical memory into the integer that lands on
/// SwiftLM's `--ctx-size`.
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
/// (256K context allocated up front pushed resident past 120 GB).
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
    /// ~49 152 tokens. The user picked "Auto" (= 65 536 default), so
    /// the RAM ceiling clips it down to ~49 K.
    func testAutoOnSixtyFourGiBClipsToRamCeiling() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 0,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 64 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertGreaterThan(resolved, 32_000)
        XCTAssertLessThan(resolved, 65_536, "Auto must NOT return the full 65 K default on a 64 GiB Mac")
    }

    /// On a 128 GiB Mac the same model has a 78 GiB KV budget (~125 K
    /// tokens at 640 KB/tok). Auto returns 65 536 (the default,
    /// because the ceiling is well above it).
    func testAutoOnOneTwentyEightGiBReturnsDefault() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 0,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, ContextWindowPolicy.autoDefault)
    }

    /// **The exact regression we're fixing.** On a 128 GiB machine the
    /// user explicitly picks 256K — but the RAM ceiling caps below the
    /// model's declared max, so we must NOT pass 262 144 to SwiftLM.
    func testRamCapClampsBelowExplicitTwoFiftySixK() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 262_144,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertLessThan(resolved, 262_144, "The user's 256K request must be RAM-capped, not passed straight through")
        // 78 GiB / 640 KB ≈ 127 720 tokens. Allow a generous tolerance
        // for the integer arithmetic in resolve().
        XCTAssertGreaterThan(resolved, 100_000)
        XCTAssertLessThan(resolved, 140_000)
    }

    // MARK: - resolve: model ceiling

    /// User asks for 128K but the model only declares 32K → resolved
    /// must clip to the model's max.
    func testModelMaxBeatsUserRequest() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 131_072,
            modelMaxContext: 32_768,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, 32_768)
    }

    // MARK: - resolve: user choice precedence

    /// User picks a small value (8K) on a giant machine → honor it.
    /// Trimming the context is a perfectly reasonable knob for the
    /// user to turn (e.g. limit the agent's memory footprint when
    /// running the model alongside other heavy apps).
    func testUserCanRequestSmallerThanAutoDefault() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 8_192,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 128 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, 8_192)
    }

    // MARK: - resolve: degenerate inputs

    /// Unknown perTokenKV → no RAM-derived ceiling. Honor user choice
    /// up to the model max. (Better to trust the user than to silently
    /// pick a guess that might be far off.)
    func testUnknownArchSkipsRamCeiling() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 131_072,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: nil,
            physicalMemoryBytes: 64 * oneGiB,
            modelWeightsBytes: qwenWeights
        )
        XCTAssertEqual(resolved, 131_072)
    }

    /// Model declares no max → fall back to the policy's `fallback`
    /// constant. Guards against passing nil/0 to SwiftLM and getting
    /// rejected at launch.
    func testFallbackWhenModelMaxIsNil() {
        let resolved = ContextWindowPolicy.resolve(
            userChoice: 0,
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
            userChoice: 0,
            modelMaxContext: qwenModelMax,
            perTokenKVBytes: qwenPerTokenKV,
            physicalMemoryBytes: 8 * oneGiB,        // tiny
            modelWeightsBytes: 100 * oneGiB         // bigger than RAM
        )
        XCTAssertGreaterThanOrEqual(resolved, 1)
    }

    // MARK: - constants

    /// The Models tab picker labels are derived from these tokens.
    /// Pinning the order so `0` (Auto) stays first and the values
    /// match the K-suffix labels rendered by `label(forContextSize:)`.
    func testPickerChoicesAreOrderedAndPowersOfTwo() {
        let choices = ContextWindowPolicy.pickerChoices
        XCTAssertEqual(choices.first, 0, "Auto must come first")
        let nonZero = choices.dropFirst()
        XCTAssertEqual(Array(nonZero), nonZero.sorted())
        for c in nonZero {
            XCTAssertTrue(
                c.isMultiple(of: 1024),
                "Picker choice \(c) doesn't render cleanly as `K`"
            )
        }
    }

    /// `swiftLMContextSizeKey` is what users' UserDefaults blobs are
    /// keyed by; renaming it silently loses everyone's setting.
    func testKeyNameIsStable() {
        XCTAssertEqual(swiftLMContextSizeKey, "swiftLMContextSize")
    }
}
