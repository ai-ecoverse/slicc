import Foundation
import XCTest

@testable import SliccFollower

/// Localized descriptions for the KokoroAne error surface — cheap coverage on
/// pure string formatting and a guard against accidental copy regressions.
final class KokoroAneErrorTests: XCTestCase {
    func testErrorDescriptionsAreStable() {
        let vocabURL = URL(fileURLWithPath: "/tmp/vocab.json")
        let voiceURL = URL(fileURLWithPath: "/tmp/voice.bin")

        let cases: [(KokoroAneError, String)] = [
            (.modelNotLoaded("PostAlbert"), "KokoroAne model 'PostAlbert' not loaded. Call initialize() first."),
            (.downloadFailed("offline"), "KokoroAne download failed: offline"),
            (.vocabMissing(vocabURL), "KokoroAne vocab.json not found at /tmp/vocab.json."),
            (
                .vocabParseFailed(vocabURL, "bad json"),
                "KokoroAne vocab.json at /tmp/vocab.json is malformed: bad json"
            ),
            (.voicePackMissing(voiceURL), "KokoroAne voice pack not found at /tmp/voice.bin."),
            (.invalidVoicePack("rows"), "KokoroAne voice pack is invalid: rows"),
            (.phonemeSequenceTooLong(600), "KokoroAne phoneme sequence has 600 characters (max 510)."),
            (.inputProcessingFailed("g2p"), "KokoroAne input processing failed: g2p"),
            (
                .acousticFramesExceedCap(have: 2500, cap: 2000),
                "KokoroAne PostAlbert produced T_a=2500 frames > MAX_FRAMES=2000. Chunk the input."
            ),
            (
                .unexpectedOutputShape(stage: "Noise", expected: "[1, T, 256]", got: "[1, 0]"),
                "KokoroAne stage 'Noise' returned unexpected shape (expected [1, T, 256], got [1, 0])."
            ),
            (.audioConversionFailed("float32"), "KokoroAne audio conversion failed: float32"),
        ]

        for (error, expected) in cases {
            XCTAssertEqual(error.errorDescription, expected, "description for \(error)")
        }

        let prediction = KokoroAneError.predictionFailed(
            stage: "Vocoder", underlying: NSError(domain: "test", code: 1))
        XCTAssertTrue(
            prediction.errorDescription?.hasPrefix("KokoroAne stage 'Vocoder' failed: ") == true)
    }
}
