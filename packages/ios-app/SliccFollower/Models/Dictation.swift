import AVFoundation
import Foundation
import Speech

enum DictationPermission: Equatable {
    case granted
    case undetermined
    case denied
    case restricted
}

protocol DictationSession {

    @MainActor func stop() async -> String

    @MainActor func cancel()
}

protocol DictationEngine {

    var permission: DictationPermission { get }

    var statusLine: String { get }

    func requestPermission() async -> DictationPermission

    func start(
        onPartial: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) async throws -> DictationSession
}

@MainActor
final class AppleDictationEngine: DictationEngine {
    private let audioSession: any AudioSessionCoordinating

    convenience init() {
        self.init(audioSession: AudioSessionCoordinator.shared)
    }

    init(audioSession: any AudioSessionCoordinating) {
        self.audioSession = audioSession
    }

    var permission: DictationPermission {
        let speech = SFSpeechRecognizer.authorizationStatus()
        let mic = AVAudioApplication.shared.recordPermission
        if speech == .denied || mic == .denied { return .denied }
        if speech == .restricted { return .restricted }
        if speech == .authorized && mic == .granted { return .granted }
        return .undetermined
    }

    var statusLine: String {
        guard let recognizer = SFSpeechRecognizer() else {
            return "Speech recognition is unavailable for this language"
        }
        return recognizer.supportsOnDeviceRecognition
            ? "Transcribed on this device"
            : "Audio is sent to Apple for transcription"
    }

    func requestPermission() async -> DictationPermission {
        let speech = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { status in
                continuation.resume(returning: status)
            }
        }
        switch speech {
        case .denied: return .denied
        case .restricted: return .restricted
        case .notDetermined: return .undetermined
        case .authorized: break
        @unknown default: return .denied
        }
        let micGranted = await AVAudioApplication.requestRecordPermission()
        return micGranted ? .granted : .denied
    }

    func start(
        onPartial: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) async throws -> DictationSession {
        guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
            throw DictationError.recognizerUnavailable
        }
        let request = SFSpeechAudioBufferRecognitionRequest()
        request.shouldReportPartialResults = true

        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        try audioSession.beginRecording()
        let audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        do {
            let installed = Self.reinstallTap(on: AppleDictationInputTap(node: input)) { buffer in
                request.append(buffer)
            }
            guard installed else { throw DictationError.inputFormatUnavailable }
            audioEngine.prepare()
            try audioEngine.start()
        } catch {
            input.removeTap(onBus: 0)
            audioSession.endRecording()
            throw error
        }

        return AppleDictationSessionBox(
            audioEngine: audioEngine,
            audioSession: audioSession,
            request: request,
            recognizer: recognizer,
            onPartial: onPartial,
            onError: onError
        )
    }

    @discardableResult
    static func reinstallTap(
        on input: any DictationInputTapping,
        append: @escaping (AVAudioPCMBuffer) -> Void
    ) -> Bool {
        input.removeTap()
        let format = input.currentOutputFormat
        guard format.sampleRate > 0, format.channelCount > 0 else { return false }
        input.installTap(format: format) { buffer, _ in
            append(buffer)
        }
        return true
    }
}

@MainActor
protocol DictationInputTapping: AnyObject {
    var currentOutputFormat: AVAudioFormat { get }
    func removeTap()
    func installTap(format: AVAudioFormat, block: @escaping AVAudioNodeTapBlock)
}

@MainActor
private final class AppleDictationInputTap: DictationInputTapping {
    private let node: AVAudioInputNode

    init(node: AVAudioInputNode) {
        self.node = node
    }

    var currentOutputFormat: AVAudioFormat { node.outputFormat(forBus: 0) }

    func removeTap() {
        node.removeTap(onBus: 0)
    }

    func installTap(format: AVAudioFormat, block: @escaping AVAudioNodeTapBlock) {
        node.installTap(onBus: 0, bufferSize: 1024, format: format, block: block)
    }
}

enum DictationError: Error, LocalizedError {
    case recognizerUnavailable
    case inputFormatUnavailable

    var errorDescription: String? {
        switch self {
        case .recognizerUnavailable:
            "Speech recognition is unavailable right now"
        case .inputFormatUnavailable:
            "The microphone is switching routes — try again in a moment"
        }
    }
}

private final class AppleDictationSessionBox: DictationSession, @unchecked Sendable {
    private let audioEngine: AVAudioEngine
    private let audioSession: any AudioSessionCoordinating
    private let request: SFSpeechAudioBufferRecognitionRequest
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var latestTranscript = ""
    private var finished = false
    private var finalContinuation: CheckedContinuation<String, Never>?

    init(
        audioEngine: AVAudioEngine,
        audioSession: any AudioSessionCoordinating,
        request: SFSpeechAudioBufferRecognitionRequest,
        recognizer: SFSpeechRecognizer,
        onPartial: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) {
        self.audioEngine = audioEngine
        self.audioSession = audioSession
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.lock.lock()
                self.latestTranscript = text

                if isFinal { self.finished = true }
                let continuation = isFinal ? self.takeContinuationLocked() : nil
                self.lock.unlock()
                if let continuation {
                    continuation.resume(returning: text)
                } else if !isFinal {
                    Task { @MainActor in onPartial(text) }
                }
            }
            if let error {
                self.lock.lock()
                let transcript = self.latestTranscript
                let wasFinished = self.finished

                self.finished = true
                let continuation = self.takeContinuationLocked()
                self.lock.unlock()

                if let continuation {
                    continuation.resume(returning: transcript)
                } else if !wasFinished {
                    Task { @MainActor in onError(error.localizedDescription) }
                }
            }
        }
    }

    private func takeContinuationLocked() -> CheckedContinuation<String, Never>? {
        guard let continuation = finalContinuation else { return nil }
        finalContinuation = nil
        return continuation
    }

    func stop() async -> String {
        stopAudio()
        return await withCheckedContinuation { continuation in
            lock.lock()
            if finished {
                let transcript = latestTranscript
                lock.unlock()
                continuation.resume(returning: transcript)
                return
            }
            finalContinuation = continuation
            lock.unlock()
            request.endAudio()
        }
    }

    func cancel() {
        stopAudio()
        lock.lock()
        finished = true
        let continuation = finalContinuation
        finalContinuation = nil
        lock.unlock()
        continuation?.resume(returning: "")
        task?.cancel()
        task = nil
    }

    @MainActor
    private func stopAudio() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        audioSession.endRecording()
    }
}
