import AVFoundation
import Foundation
import OSLog

protocol KokoroModelPresenceChecking: Sendable {
    func modelsPresent(in directory: URL) -> Bool
}

struct KokoroModelPresenceChecker: KokoroModelPresenceChecking {
    static let requiredEntries = KokoroAneResourceDownloader.downloadableEntries

    func modelsPresent(in directory: URL) -> Bool {
        Self.modelsPresent(in: directory, fileManager: .default)
    }

    static func modelsPresent(in directory: URL, fileManager: FileManager) -> Bool {
        let requiredWithoutAcousticVocab = requiredEntries.filter {
            $0 != ModelNames.KokoroAne.huggingFaceVocab
        }
        let corePresent = requiredWithoutAcousticVocab.allSatisfy {
            fileManager.fileExists(atPath: directory.appendingPathComponent($0).path)
        }
        let acousticVocabPresent = ModelNames.KokoroAne.vocabularyFiles.contains {
            fileManager.fileExists(atPath: directory.appendingPathComponent($0).path)
        }
        return corePresent && acousticVocabPresent
    }
}

enum KokoroDevelopmentModels {
    static let environmentVariable = "SLICC_KOKORO_MODELS_DIR"

    static func directoryURL(environment: [String: String] = ProcessInfo.processInfo.environment)
        -> URL?
    {
        guard let path = environment[environmentVariable], !path.isEmpty else { return nil }
        return URL(fileURLWithPath: path, isDirectory: true)
    }
}

@MainActor
protocol KokoroAudioPlaying: AnyObject {
    func play(samples: [Float], completion: @escaping @MainActor () -> Void) throws
    func stop()
}

@MainActor
final class KokoroPCMPlayer: KokoroAudioPlaying {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let audioSession: any AudioSessionCoordinating
    private var configured = false
    private var sessionActive = false

    convenience init() {
        self.init(audioSession: AudioSessionCoordinator.shared)
    }

    init(audioSession: any AudioSessionCoordinating) {
        self.audioSession = audioSession
    }

    func play(samples: [Float], completion: @escaping @MainActor () -> Void) throws {
        guard !samples.isEmpty else { throw PlayerError.emptyAudio }
        guard samples.allSatisfy(\.isFinite) else { throw PlayerError.nonFiniteAudio }
        guard
            let format = AVAudioFormat(
                commonFormat: .pcmFormatFloat32,
                sampleRate: 24_000,
                channels: 1,
                interleaved: false),
            let buffer = AVAudioPCMBuffer(
                pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
            let channel = buffer.floatChannelData?[0]
        else { throw PlayerError.bufferCreation }

        buffer.frameLength = AVAudioFrameCount(samples.count)
        samples.withUnsafeBufferPointer { source in
            guard let baseAddress = source.baseAddress else { return }
            channel.update(from: baseAddress, count: samples.count)
        }
        node.stop()
        try audioSession.beginPlayback(preferredSampleRate: format.sampleRate)
        sessionActive = true
        do {
            try configureIfNeeded(format: format)
            node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    self?.engine.stop()
                    self?.releaseSession()
                    completion()
                }
            }
            engine.prepare()
            try engine.start()
            node.play()
        } catch {
            node.stop()
            engine.stop()
            releaseSession()
            throw error
        }
    }

    func stop() {
        node.stop()
        engine.stop()
        releaseSession()
    }

    private func configureIfNeeded(format: AVAudioFormat) throws {
        guard !configured else { return }
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: format)
        configured = true
    }

    private func releaseSession() {
        guard sessionActive else { return }
        audioSession.endPlayback()
        sessionActive = false
    }

    enum PlayerError: LocalizedError {
        case emptyAudio
        case nonFiniteAudio
        case bufferCreation

        var errorDescription: String? {
            switch self {
            case .emptyAudio: "Kokoro returned no audio"
            case .nonFiniteAudio: "Kokoro returned invalid audio"
            case .bufferCreation: "Could not create the 24 kHz PCM buffer"
            }
        }
    }
}

/// English Kokoro with a system-voice fallback behind `SpeechSpeaking`.
@MainActor
final class KokoroSpeaker: SpeechSpeaking {
    enum Route: Equatable {
        case kokoro
        case system
    }

    enum FailureStage: Equatable {
        case synthesis
        case playback
    }

    typealias SynthesizerFactory = (URL) -> any KokoroSpeechSynthesizing

    private let modelDirectory: URL?
    private let managedModelDirectory: URL?
    private let resourceDownloader: (any KokoroAneResourceDownloading)?
    private let presenceChecker: any KokoroModelPresenceChecking
    private let fallback: any SpeechSpeaking
    private let synthesizerFactory: SynthesizerFactory
    private let player: any KokoroAudioPlaying
    private let synthesisTimeout: Duration
    private let onFailure: ((FailureStage) -> Void)?
    private let logger = Logger(subsystem: "com.sliccy.follower", category: "kokoro-speaker")

    private var activeRequest: UUID?
    private var synthesisTask: Task<Void, Never>?
    private var timeoutTask: Task<Void, Never>?
    private var cachedSynthesizer: (directory: URL, value: any KokoroSpeechSynthesizing)?
    private var prewarmTask: Task<Void, Error>?
    private var isPrewarmed = false

    init(
        modelDirectory: URL?,
        managedModelDirectory: URL? = KokoroAneResourceDownloader.defaultModelsDirectory(),
        resourceDownloader: (any KokoroAneResourceDownloading)? = nil,
        presenceChecker: any KokoroModelPresenceChecking = KokoroModelPresenceChecker(),
        fallback: (any SpeechSpeaking)? = nil,
        synthesizerFactory: @escaping SynthesizerFactory = { KokoroTTSEngine(modelsDirectory: $0) },
        player: (any KokoroAudioPlaying)? = nil,
        synthesisTimeout: Duration = .seconds(20),
        onFailure: ((FailureStage) -> Void)? = nil
    ) {
        self.modelDirectory = modelDirectory
        self.managedModelDirectory = managedModelDirectory
        self.resourceDownloader = resourceDownloader
        self.presenceChecker = presenceChecker
        self.fallback = fallback ?? AVSpeechSpeaker()
        self.synthesizerFactory = synthesizerFactory
        self.player = player ?? KokoroPCMPlayer()
        self.synthesisTimeout = synthesisTimeout
        self.onFailure = onFailure
    }

    func prewarm() async {
        guard !isPrewarmed, let directory = installedModelDirectory() else { return }
        let synthesizer = synthesizer(for: directory)
        let task: Task<Void, Error>
        if let prewarmTask {
            task = prewarmTask
        } else {
            task = Task { try await synthesizer.prepare() }
            prewarmTask = task
        }
        do {
            try await task.value
            isPrewarmed = true
        } catch {
            logger.error("Kokoro pre-warm failed; first speech will retry")
        }
        prewarmTask = nil
    }

    func speak(_ text: String, lang: String?) {
        stopActiveRequest()
        fallback.stop()
        guard let lang, Self.route(language: lang, modelsPresent: true) == .kokoro else {
            fallback.speak(text, lang: lang)
            return
        }

        if let modelDirectory {
            guard presenceChecker.modelsPresent(in: modelDirectory) else {
                fallback.speak(text, lang: lang)
                return
            }
            startSynthesis(text: text, lang: lang, modelDirectory: modelDirectory)
            return
        }

        guard let managedModelDirectory else {
            fallback.speak(text, lang: lang)
            return
        }
        if managedModelsPresent(in: managedModelDirectory) {
            startSynthesis(text: text, lang: lang, modelDirectory: managedModelDirectory)
            return
        }
        guard let resourceDownloader else {
            fallback.speak(text, lang: lang)
            return
        }

        let request = UUID()
        activeRequest = request
        synthesisTask = Task { [weak self] in
            do {
                let resolvedDirectory = try await resourceDownloader.ensureModels(
                    variant: .english, directory: managedModelDirectory)
                guard !Task.isCancelled, self?.activeRequest == request else { return }
                guard self?.managedModelsPresent(in: resolvedDirectory) == true else {
                    throw KokoroModelProvisioningError.incompleteDownload(missing: [])
                }
                self?.startSynthesis(
                    text: text, lang: lang, modelDirectory: resolvedDirectory, request: request)
            } catch is CancellationError {
                return
            } catch {
                self?.fallbackIfActive(
                    request: request, text: text, lang: lang, error: error, stage: .synthesis)
            }
        }
    }

    private func managedModelsPresent(in directory: URL) -> Bool {
        presenceChecker.modelsPresent(in: directory)
            && FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(
                    KokoroAneResourceDownloader.completionMarker
                ).path)
    }

    private func installedModelDirectory() -> URL? {
        if let modelDirectory {
            return presenceChecker.modelsPresent(in: modelDirectory) ? modelDirectory : nil
        }
        guard let managedModelDirectory, managedModelsPresent(in: managedModelDirectory) else {
            return nil
        }
        return managedModelDirectory
    }

    private func synthesizer(for directory: URL) -> any KokoroSpeechSynthesizing {
        if let cachedSynthesizer, cachedSynthesizer.directory == directory {
            return cachedSynthesizer.value
        }
        let synthesizer = synthesizerFactory(directory)
        cachedSynthesizer = (directory, synthesizer)
        isPrewarmed = false
        return synthesizer
    }

    private func startSynthesis(
        text: String, lang: String, modelDirectory: URL, request: UUID = UUID()
    ) {
        activeRequest = request
        let synthesizer = synthesizer(for: modelDirectory)
        startTimeout(request: request, text: text, lang: lang)
        synthesisTask = Task { [weak self] in
            do {
                let samples = try await synthesizer.synthesize(
                    text: text, voice: KokoroAneConstants.defaultVoice, speed: 1.0)
                guard !Task.isCancelled else { return }
                self?.play(samples, request: request, fallbackText: text, lang: lang)
            } catch is CancellationError {
                return
            } catch {
                self?.fallbackIfActive(
                    request: request, text: text, lang: lang, error: error, stage: .synthesis)
            }
        }
    }

    private func startTimeout(request: UUID, text: String, lang: String?) {
        let timeout = synthesisTimeout
        timeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(for: timeout)
            } catch {
                return
            }
            self?.timeoutIfActive(request: request, text: text, lang: lang)
        }
    }

    func stop() {
        stopActiveRequest()
        fallback.stop()
    }

    /// The system synthesizer can always use its default voice when an exact
    /// language voice is absent, so production replies never degrade to silence.
    func hasVoice(for lang: String) -> Bool { true }

    static func route(language: String?, modelsPresent: Bool) -> Route {
        guard let language, baseLanguage(of: language) == "en", modelsPresent else {
            return .system
        }
        return .kokoro
    }

    private static func baseLanguage(of language: String) -> String {
        language.replacingOccurrences(of: "_", with: "-")
            .split(separator: "-").first.map(String.init)?.lowercased()
            ?? language.lowercased()
    }

    private func play(
        _ samples: [Float], request: UUID, fallbackText: String, lang: String?
    ) {
        guard activeRequest == request else { return }
        timeoutTask?.cancel()
        timeoutTask = nil
        do {
            try player.play(samples: samples) { [weak self] in
                guard self?.activeRequest == request else { return }
                self?.activeRequest = nil
                self?.synthesisTask = nil
            }
        } catch {
            fallbackIfActive(
                request: request, text: fallbackText, lang: lang, error: error, stage: .playback)
        }
    }

    private func fallbackIfActive(
        request: UUID, text: String, lang: String?, error: Error, stage: FailureStage
    ) {
        guard activeRequest == request else { return }
        onFailure?(stage)
        switch stage {
        case .synthesis:
            logger.error(
                "Kokoro synthesis failed; using system voice: \(String(describing: error), privacy: .public)")
        case .playback:
            logger.error(
                "Kokoro playback failed; using system voice: \(String(describing: error), privacy: .public)")
        }
        finishRequest()
        fallback.speak(text, lang: lang)
    }

    private func timeoutIfActive(request: UUID, text: String, lang: String?) {
        guard activeRequest == request else { return }
        logger.error("Kokoro synthesis timed out; using system voice")
        synthesisTask?.cancel()
        finishRequest()
        fallback.speak(text, lang: lang)
    }

    private func stopActiveRequest() {
        synthesisTask?.cancel()
        timeoutTask?.cancel()
        player.stop()
        finishRequest()
    }

    private func finishRequest() {
        activeRequest = nil
        synthesisTask = nil
        timeoutTask = nil
    }
}
