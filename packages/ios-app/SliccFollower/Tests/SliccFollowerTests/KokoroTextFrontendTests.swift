import XCTest

@testable import SliccFollower

final class KokoroTextFrontendTests: XCTestCase {
    private struct Expectation {
        let input: String
        let phonemes: String
    }

    private let expectations = [
        Expectation(input: "Hello", phonemes: "hˈɛlO"),
        Expectation(input: "world", phonemes: "wˈɜɹld"),
        Expectation(input: "build", phonemes: "bˈɪld"),
        Expectation(input: "Cherry", phonemes: "ʧˈɛɹi"),
        Expectation(input: "package", phonemes: "pˈækɪʤ"),
        Expectation(input: "tests", phonemes: "tˈɛsts"),
        Expectation(input: "failed", phonemes: "fˈAld"),
        Expectation(input: "branch", phonemes: "bɹˈænʧ"),
        Expectation(input: "to", phonemes: "tu"),
        Expectation(input: "me", phonemes: "mi"),
        Expectation(input: "a", phonemes: "ə"),
        Expectation(input: "the", phonemes: "ðə"),
        Expectation(input: "of", phonemes: "əv"),
        Expectation(input: "for", phonemes: "fɔɹ"),
        Expectation(input: "you", phonemes: "ju"),
        Expectation(input: "and", phonemes: "ænd"),
        Expectation(input: "was", phonemes: "wəz"),
        Expectation(input: "to me", phonemes: "tu mi"),
        Expectation(input: "a test", phonemes: "ə tˈɛst"),
        Expectation(input: "the build", phonemes: "ðə bˈɪld"),
        Expectation(input: "QA", phonemes: "kjˌu ˈA"),
        Expectation(input: "CI", phonemes: "sˌI ˈI"),
        Expectation(input: "PR", phonemes: "pˌI ˈɑɹ"),
        Expectation(input: "API", phonemes: "ˌA pˌI ˈI"),
        Expectation(input: "I've", phonemes: "ˌIv"),
        Expectation(input: "don't", phonemes: "dˈOnt"),
        Expectation(input: "it's", phonemes: "ˈɪts"),
        Expectation(input: "well-known", phonemes: "wˈɛl nˈOn"),
        Expectation(input: "state-of-the-art", phonemes: "stˈAt əv ði ˈɑɹt"),
        Expectation(input: "real-time", phonemes: "ɹˈIl tˈIm"),
        Expectation(input: "1", phonemes: "wˈʌn"),
        Expectation(input: "12", phonemes: "twˈɛlv"),
        Expectation(input: "42", phonemes: "fˈɔɹɾi tˈu"),
        Expectation(input: "2026", phonemes: "twˈɛnti twˈɛnti sˈɪks"),
        Expectation(input: "3.5", phonemes: "θɹˈi pˈYnt fˈIv"),
        Expectation(input: "12.75", phonemes: "twˈɛlv pˈYnt sˈɛvən fˈIv"),
        Expectation(input: "0.5", phonemes: "zˈɪɹO pˈYnt fˈIv"),
        Expectation(input: "50%", phonemes: "fˈɪfti pəɹsˈɛnt"),
        Expectation(input: "100%", phonemes: "wˈʌn hˈʌndɹəd pəɹsˈɛnt"),
        Expectation(input: "7%", phonemes: "sˈɛvən pəɹsˈɛnt"),
        Expectation(input: ";", phonemes: ";"),
        Expectation(input: ":", phonemes: ":"),
        Expectation(input: ",", phonemes: ","),
        Expectation(input: ".", phonemes: "."),
        Expectation(input: "!", phonemes: "!"),
        Expectation(input: "?", phonemes: "?"),
        Expectation(input: "—", phonemes: "—"),
        Expectation(input: "…", phonemes: "…"),
        Expectation(input: "\"", phonemes: "\""),
        Expectation(input: "(", phonemes: "("),
        Expectation(input: ")", phonemes: ")"),
        Expectation(input: "“", phonemes: "“"),
        Expectation(input: "”", phonemes: "”"),
        Expectation(input: " ", phonemes: " "),
    ]

    func testVerifiedProbeNormalizationParity() async throws {
        let normalizer = try TextNormalization.bundled()
        let g2pFallbacks = ["Hello": "hˈɛlO", "Cherry": "ʧˈɛɹi"]
        for expectation in expectations {
            let actual = try await normalizer.render(expectation.input) { word in
                guard let phonemes = g2pFallbacks[word] else {
                    XCTFail("unexpected G2P fallback for \(word)")
                    return ""
                }
                return phonemes
            }
            XCTAssertEqual(actual, expectation.phonemes, "input: \(expectation.input)")
        }
        XCTAssertEqual(expectations.count, 54)
    }

    func testBothVerifiedMisakiLexiconsAreLoaded() throws {
        let lexicon = try MisakiUSLexicon.bundled()
        XCTAssertNotNil(lexicon.lookup("hello"), "gold lexicon")
        XCTAssertNotNil(lexicon.lookup("aahing"), "silver lexicon")
    }

    func testG2PAvailabilityReportsMissingVocabulary() async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }

        do {
            try await G2PModel(modelsDirectory: directory).ensureModelsAvailable()
            XCTFail("expected missing vocabulary error")
        } catch let error as G2PModel.G2PModelError {
            XCTAssertTrue(error.errorDescription?.contains("g2p_vocab.json not found") == true)
        }
    }

    func testG2PErrorsDescribeEachFailedStage() {
        XCTAssertEqual(
            G2PModel.G2PModelError.vocabLoadFailed("invalid").errorDescription,
            "Failed to load G2P g2p_vocab.json: invalid")
        XCTAssertEqual(
            G2PModel.G2PModelError.modelLoadFailed("missing").errorDescription,
            "Failed to load G2P CoreML model: missing")
        XCTAssertEqual(
            G2PModel.G2PModelError.encoderPredictionFailed.errorDescription,
            "G2P encoder prediction failed.")
        XCTAssertEqual(
            G2PModel.G2PModelError.decoderPredictionFailed.errorDescription,
            "G2P decoder prediction failed.")
    }
}
