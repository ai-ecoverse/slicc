import AVFoundation
import Foundation
import Speech

// MARK: - Permission

/// Microphone + speech-recognition permission, collapsed to what the
/// push-to-talk gesture needs. iOS has two independent grants (mic capture
/// and speech recognition); the gesture only cares about the combined state.
/// `restricted` (Screen Time / a management profile) is distinct from
/// `denied` because the fix is different: there is no Settings toggle for the
/// user to flip, so the overlay must not send them hunting for one.
enum DictationPermission: Equatable {
    case granted
    case undetermined
    case denied
    case restricted
}

// MARK: - Engine contract

/// A live dictation session: exactly one of `stop`/`cancel` ends it.
/// Mirrors `SpeechSession` in `packages/webcomponents/src/composer/speech.ts`.
protocol DictationSession {
    /// Stop listening and resolve the final transcript ("" when nothing).
    func stop() async -> String
    /// Abort without a transcript (gesture cancelled, teardown).
    func cancel()
}

/// The audio stack behind the composer's push-to-talk gesture, mirroring the
/// web's `ComposerSpeech` contract: the gesture (hold-to-enable, captions)
/// lives in `PttController`, the recognizer behind this protocol. DEBUG
/// builds swap in a scripted fake (see `UITestHooks.speechEngine()`) so UI
/// tests never depend on a simulator microphone.
protocol DictationEngine {
    /// Current combined permission. Synchronous on iOS — both authorization
    /// statuses are cached by the system, unlike the web's async query.
    var permission: DictationPermission { get }
    /// Human-readable note for the recording overlay's engine status line —
    /// the privacy-relevant "where does my audio go" disclosure.
    var statusLine: String { get }
    /// Trigger the system permission prompts (speech recognition first, then
    /// microphone). Resolves to the resulting combined permission.
    func requestPermission() async -> DictationPermission
    /// Begin one dictation session. Partials stream the interim transcript
    /// for the closed-caption line; errors are non-fatal session notes.
    func start(
        onPartial: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) async throws -> DictationSession
}

// MARK: - Apple engine

/// `SFSpeechRecognizer` + `AVAudioEngine`. On-device recognition is the
/// default whenever the current locale's model supports it — the natural
/// analogue of the web's "enhanced" whisper engine, minus the 150 MB
/// download. Server-based recognition is the deliberate fallback, and the
/// status line discloses which one is active.
final class AppleDictationEngine: DictationEngine {
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
        // Privacy default: keep audio on the device whenever the locale's
        // model allows it; only then fall back to Apple's servers (which the
        // status line discloses).
        request.requiresOnDeviceRecognition = recognizer.supportsOnDeviceRecognition

        let audioSession = AVAudioSession.sharedInstance()
        try audioSession.setCategory(.record, mode: .measurement, options: .duckOthers)
        try audioSession.setActive(true, options: .notifyOthersOnDeactivation)

        let audioEngine = AVAudioEngine()
        let input = audioEngine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
            request.append(buffer)
        }
        audioEngine.prepare()
        try audioEngine.start()

        return AppleDictationSessionBox(
            audioEngine: audioEngine,
            request: request,
            recognizer: recognizer,
            onPartial: onPartial,
            onError: onError
        )
    }
}

enum DictationError: Error, LocalizedError {
    case recognizerUnavailable

    var errorDescription: String? {
        "Speech recognition is unavailable right now"
    }
}

/// One live `SFSpeechRecognizer` session. `stop()` ends audio capture and
/// waits for the recognizer's final result; `cancel()` tears everything down
/// without one. The recognition callback arrives on an arbitrary queue, so
/// all shared state lives behind a lock-free single-owner pattern: the
/// recognition task is the only writer of `latestTranscript` after `stop()`
/// hands ownership to the continuation.
private final class AppleDictationSessionBox: DictationSession, @unchecked Sendable {
    private let audioEngine: AVAudioEngine
    private let request: SFSpeechAudioBufferRecognitionRequest
    private var task: SFSpeechRecognitionTask?
    private let lock = NSLock()
    private var latestTranscript = ""
    private var finished = false
    private var finalContinuation: CheckedContinuation<String, Never>?

    init(
        audioEngine: AVAudioEngine,
        request: SFSpeechAudioBufferRecognitionRequest,
        recognizer: SFSpeechRecognizer,
        onPartial: @escaping @MainActor @Sendable (String) -> Void,
        onError: @escaping @MainActor @Sendable (String) -> Void
    ) {
        self.audioEngine = audioEngine
        self.request = request
        task = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self else { return }
            if let result {
                let text = result.bestTranscription.formattedString
                let isFinal = result.isFinal
                self.lock.lock()
                self.latestTranscript = text
                // A final result is terminal even when no stop() is waiting
                // yet: mark finished so a later stop() takes the fast path
                // instead of installing a continuation nothing will resume.
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
                // An error ends the recognition task — terminal like a
                // final result, whatever the ordering.
                self.finished = true
                let continuation = self.takeContinuationLocked()
                self.lock.unlock()
                // A stop() in flight settles with whatever was heard — an
                // error after endAudio() (e.g. "no speech detected") is a
                // normal empty finish, not something to surface.
                if let continuation {
                    continuation.resume(returning: transcript)
                } else if !wasFinished {
                    Task { @MainActor in onError(error.localizedDescription) }
                }
            }
        }
    }

    /// Must be called with `lock` held. Hands out the continuation exactly
    /// once; callers mark `finished` themselves (a terminal callback is
    /// terminal whether or not a stop() was already waiting).
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

    private func stopAudio() {
        audioEngine.stop()
        audioEngine.inputNode.removeTap(onBus: 0)
        try? AVAudioSession.sharedInstance().setActive(
            false, options: .notifyOthersOnDeactivation)
    }
}
