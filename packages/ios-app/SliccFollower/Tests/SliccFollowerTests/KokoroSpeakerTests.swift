import Foundation
import XCTest

@testable import SliccFollower

@MainActor
final class KokoroSpeakerTests: XCTestCase {
    private struct Presence: KokoroModelPresenceChecking {
        let value: Bool
        func modelsPresent(in directory: URL) -> Bool { value }
    }

    private final class FakeSpeaker: SpeechSpeaking {
        var spoken: [(String, String?)] = []
        var stops = 0
        var onSpeak: (() -> Void)?

        func speak(_ text: String, lang: String?) {
            spoken.append((text, lang))
            onSpeak?()
        }

        func stop() { stops += 1 }
        func hasVoice(for lang: String) -> Bool { true }
    }

    private final class FakePlayer: KokoroAudioPlaying {
        var samples: [Float] = []
        var stops = 0
        var onPlay: (() -> Void)?

        func play(samples: [Float], completion: @escaping @MainActor () -> Void) throws {
            self.samples = samples
            onPlay?()
        }

        func stop() { stops += 1 }
    }

    private actor SuccessfulSynthesizer: KokoroSpeechSynthesizing {
        func synthesize(text: String, voice: String, speed: Float) async throws -> [Float] {
            [0.25, -0.25]
        }
    }

    private actor FailingSynthesizer: KokoroSpeechSynthesizing {
        struct Failure: Error {}
        func synthesize(text: String, voice: String, speed: Float) async throws -> [Float] {
            throw Failure()
        }
    }

    private actor HangingSynthesizer: KokoroSpeechSynthesizing {
        func synthesize(text: String, voice: String, speed: Float) async throws -> [Float] {
            try await Task.sleep(for: .seconds(60))
            return []
        }
    }

    func testRoutingDecisionTable() {
        XCTAssertEqual(KokoroSpeaker.route(language: "en", modelsPresent: true), .kokoro)
        XCTAssertEqual(KokoroSpeaker.route(language: "en-US", modelsPresent: false), .system)
        XCTAssertEqual(KokoroSpeaker.route(language: "de", modelsPresent: true), .system)
        XCTAssertEqual(KokoroSpeaker.route(language: nil, modelsPresent: true), .system)
    }

    func testAbsentModelsFallBackSynchronouslyWithoutConstructingKokoro() {
        let fallback = FakeSpeaker()
        var constructed = false
        let speaker = KokoroSpeaker(
            modelDirectory: URL(fileURLWithPath: "/missing", isDirectory: true),
            presenceChecker: Presence(value: false),
            fallback: fallback,
            synthesizerFactory: { _ in
                constructed = true
                return SuccessfulSynthesizer()
            },
            player: FakePlayer())

        speaker.speak("hello", lang: "en")

        XCTAssertFalse(constructed)
        XCTAssertEqual(fallback.spoken.first?.0, "hello")
        XCTAssertEqual(fallback.spoken.first?.1, "en")
    }

    func testNonEnglishAndUnknownLanguageUseSystemVoice() {
        let fallback = FakeSpeaker()
        let speaker = makeSpeaker(fallback: fallback, synthesizer: SuccessfulSynthesizer())

        speaker.speak("hallo", lang: "de")
        speaker.speak("language unknown", lang: nil)

        XCTAssertEqual(fallback.spoken.map(\.0), ["hallo", "language unknown"])
    }

    func testSuccessfulEnglishSynthesisPlaysKokoroAudio() async {
        let fallback = FakeSpeaker()
        let player = FakePlayer()
        let played = expectation(description: "Kokoro PCM played")
        player.onPlay = { played.fulfill() }
        let speaker = makeSpeaker(
            fallback: fallback, synthesizer: SuccessfulSynthesizer(), player: player)

        speaker.speak("hello", lang: "en-US")
        await fulfillment(of: [played], timeout: 1)

        XCTAssertEqual(player.samples, [0.25, -0.25])
        XCTAssertTrue(fallback.spoken.isEmpty)
    }

    func testSynthesisFailureFallsBackToSystemVoice() async {
        let fallback = FakeSpeaker()
        let spoke = expectation(description: "system fallback spoke")
        fallback.onSpeak = { spoke.fulfill() }
        let speaker = makeSpeaker(fallback: fallback, synthesizer: FailingSynthesizer())

        speaker.speak("hello", lang: "en")
        await fulfillment(of: [spoke], timeout: 1)

        XCTAssertEqual(fallback.spoken.first?.0, "hello")
    }

    func testSynthesisTimeoutFallsBackWithoutWaitingForInference() async {
        let fallback = FakeSpeaker()
        let spoke = expectation(description: "bounded system fallback spoke")
        fallback.onSpeak = { spoke.fulfill() }
        let speaker = makeSpeaker(
            fallback: fallback,
            synthesizer: HangingSynthesizer(),
            timeout: .milliseconds(10))

        speaker.speak("hello", lang: "en")
        await fulfillment(of: [spoke], timeout: 1)

        XCTAssertEqual(fallback.spoken.first?.0, "hello")
    }

    func testMissingManagedModelsFallBackWithoutProvisioning() {
        let fallback = FakeSpeaker()
        var constructed = false
        let speaker = KokoroSpeaker(
            modelDirectory: nil,
            managedModelDirectory: FileManager.default.temporaryDirectory,
            presenceChecker: Presence(value: false),
            fallback: fallback,
            synthesizerFactory: { _ in
                constructed = true
                return SuccessfulSynthesizer()
            },
            player: FakePlayer())

        speaker.speak("hello", lang: "en")

        XCTAssertFalse(constructed)
        XCTAssertEqual(fallback.spoken.first?.0, "hello")
    }

    func testCompleteMarkerlessManagedModelsFallBackToSystemVoice() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let fallback = FakeSpeaker()
        var constructed = false
        let speaker = KokoroSpeaker(
            modelDirectory: nil,
            managedModelDirectory: directory,
            presenceChecker: Presence(value: true),
            fallback: fallback,
            synthesizerFactory: { _ in
                constructed = true
                return SuccessfulSynthesizer()
            },
            player: FakePlayer())

        speaker.speak("hello", lang: "en")

        XCTAssertFalse(constructed)
        XCTAssertEqual(fallback.spoken.first?.0, "hello")
        XCTAssertEqual(fallback.spoken.first?.1, "en")
    }

    func testPresenceCheckerRequiresTheCompleteVerifiedAssetSet() throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        for entry in KokoroModelPresenceChecker.requiredEntries {
            let url = directory.appendingPathComponent(entry)
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            FileManager.default.createFile(atPath: url.path, contents: Data())
        }
        let checker = KokoroModelPresenceChecker()
        XCTAssertTrue(checker.modelsPresent(in: directory))
        try FileManager.default.removeItem(
            at: directory.appendingPathComponent(ModelNames.KokoroAne.huggingFaceVocab))
        XCTAssertFalse(checker.modelsPresent(in: directory))
        FileManager.default.createFile(
            atPath: directory.appendingPathComponent(ModelNames.KokoroAne.legacyVocab).path,
            contents: Data())
        XCTAssertTrue(checker.modelsPresent(in: directory))
    }

    func testDevelopmentDirectoryIsExplicitlyInjectedFromEnvironment() {
        XCTAssertNil(KokoroDevelopmentModels.directoryURL(environment: [:]))
        XCTAssertEqual(
            KokoroDevelopmentModels.directoryURL(environment: [
                KokoroDevelopmentModels.environmentVariable: "/tmp/kokoro"
            ])?.path,
            "/tmp/kokoro")
    }

    private func makeSpeaker(
        fallback: FakeSpeaker,
        synthesizer: any KokoroSpeechSynthesizing,
        player: FakePlayer? = nil,
        timeout: Duration = .seconds(20)
    ) -> KokoroSpeaker {
        KokoroSpeaker(
            modelDirectory: URL(fileURLWithPath: "/models", isDirectory: true),
            presenceChecker: Presence(value: true),
            fallback: fallback,
            synthesizerFactory: { _ in synthesizer },
            player: player ?? FakePlayer(),
            synthesisTimeout: timeout)
    }

}
