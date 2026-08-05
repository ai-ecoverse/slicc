import AVFoundation
import XCTest

@testable import SliccFollower

@MainActor
final class AudioSessionCoordinatorTests: XCTestCase {
    private final class Backend: AudioSessionBackend {
        struct Failure: Error {}

        var category: AVAudioSession.Category = .playAndRecord
        var mode: AVAudioSession.Mode = .voiceChat
        var categoryOptions: AVAudioSession.CategoryOptions = [.allowBluetooth]
        var preferredSampleRate = 48_000.0
        var active = false
        var failActivation = false

        func setCategory(
            _ category: AVAudioSession.Category,
            mode: AVAudioSession.Mode,
            options: AVAudioSession.CategoryOptions
        ) throws {
            self.category = category
            self.mode = mode
            categoryOptions = options
        }

        func setPreferredSampleRate(_ sampleRate: Double) throws {
            preferredSampleRate = sampleRate
        }

        func setActive(_ active: Bool, options: AVAudioSession.SetActiveOptions) throws {
            if active, failActivation { throw Failure() }
            self.active = active
        }
    }

    private final class InputTap: DictationInputTapping {
        var formats: [AVAudioFormat]
        var operations: [String] = []
        var installedSampleRates: [Double] = []

        init(formats: [AVAudioFormat]) {
            self.formats = formats
        }

        var currentOutputFormat: AVAudioFormat {
            operations.append("format")
            return formats.removeFirst()
        }

        func removeTap() {
            operations.append("remove")
        }

        func installTap(format: AVAudioFormat, block: @escaping AVAudioNodeTapBlock) {
            operations.append("install")
            installedSampleRates.append(format.sampleRate)
        }
    }

    func testPlaybackRestoresInheritedSessionConfiguration() throws {
        let backend = Backend()
        let coordinator = AudioSessionCoordinator(backend: backend)

        try coordinator.beginPlayback(preferredSampleRate: 24_000)
        XCTAssertEqual(backend.category, .playback)
        XCTAssertEqual(backend.mode, .spokenAudio)
        XCTAssertEqual(backend.preferredSampleRate, 24_000)
        XCTAssertTrue(backend.active)

        coordinator.endPlayback()
        XCTAssertEqual(backend.category, .playAndRecord)
        XCTAssertEqual(backend.mode, .voiceChat)
        XCTAssertEqual(backend.categoryOptions, [.allowBluetooth])
        XCTAssertEqual(backend.preferredSampleRate, 48_000)
        XCTAssertFalse(backend.active)
    }

    func testPlaybackSetupFailureRestoresInheritedSessionConfiguration() {
        let backend = Backend()
        backend.failActivation = true
        let coordinator = AudioSessionCoordinator(backend: backend)

        XCTAssertThrowsError(try coordinator.beginPlayback(preferredSampleRate: 24_000))
        XCTAssertEqual(backend.category, .playAndRecord)
        XCTAssertEqual(backend.mode, .voiceChat)
        XCTAssertEqual(backend.categoryOptions, [.allowBluetooth])
        XCTAssertEqual(backend.preferredSampleRate, 48_000)
        XCTAssertFalse(backend.active)
    }

    func testTapReinstallAfterPlaybackUsesCurrentInputFormat() throws {
        let first = AVAudioFormat(standardFormatWithSampleRate: 48_000, channels: 1)!
        let second = AVAudioFormat(standardFormatWithSampleRate: 44_100, channels: 1)!
        let input = InputTap(formats: [first, second])
        let coordinator = AudioSessionCoordinator(backend: Backend())

        AppleDictationEngine.reinstallTap(on: input) { _ in }
        try coordinator.beginPlayback(preferredSampleRate: 24_000)
        coordinator.endPlayback()
        AppleDictationEngine.reinstallTap(on: input) { _ in }

        XCTAssertEqual(
            input.operations,
            ["remove", "format", "install", "remove", "format", "install"])
        XCTAssertEqual(input.installedSampleRates, [48_000, 44_100])
    }

    /// The 0 Hz / 0-channel format an input node reports mid-route-change.
    private static func degenerateFormat() -> AVAudioFormat? {
        var description = AudioStreamBasicDescription()
        description.mFormatID = kAudioFormatLinearPCM
        description.mFormatFlags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked
        description.mSampleRate = 0
        description.mChannelsPerFrame = 0
        description.mBitsPerChannel = 32
        description.mFramesPerPacket = 1
        return AVAudioFormat(streamDescription: &description)
    }

    func testDegenerateInputFormatAbortsTapInstallation() throws {
        // Installing a tap with a 0 Hz format raises an uncatchable NSException
        // from `AUGraphNodeBaseV3::CreateRecordingTap`.
        guard let degenerate = Self.degenerateFormat(),
            degenerate.sampleRate == 0 || degenerate.channelCount == 0
        else {
            throw XCTSkip("this platform refuses to describe a degenerate format")
        }
        let input = InputTap(formats: [degenerate])

        let installed = AppleDictationEngine.reinstallTap(on: input) { _ in }

        XCTAssertFalse(installed)
        XCTAssertEqual(input.operations, ["remove", "format"])
        XCTAssertTrue(input.installedSampleRates.isEmpty)
    }

    func testRecordingAndPlaybackLeasesAreExclusive() throws {
        let coordinator = AudioSessionCoordinator(backend: Backend())
        try coordinator.beginRecording()

        XCTAssertThrowsError(try coordinator.beginPlayback(preferredSampleRate: 24_000)) {
            XCTAssertEqual(
                $0 as? AudioSessionCoordinatorError, .busy(holder: .recording))
        }
    }

    func testBusyErrorNamesThePlaybackLeaseHolder() throws {
        let coordinator = AudioSessionCoordinator(backend: Backend())
        try coordinator.beginPlayback(preferredSampleRate: 24_000)

        XCTAssertThrowsError(try coordinator.beginRecording()) {
            XCTAssertEqual($0 as? AudioSessionCoordinatorError, .busy(holder: .playback))
            XCTAssertEqual(
                ($0 as? AudioSessionCoordinatorError)?.errorDescription,
                "Another audio operation is still active (playback)")
        }
    }
}
