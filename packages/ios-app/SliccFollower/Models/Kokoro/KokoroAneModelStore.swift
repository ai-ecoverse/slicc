@preconcurrency import CoreML
import Foundation






struct KokoroAneComputeUnits: Sendable, Equatable {
    var albert: MLComputeUnits
    var postAlbert: MLComputeUnits
    var alignment: MLComputeUnits
    var prosody: MLComputeUnits
    var noise: MLComputeUnits
    var vocoder: MLComputeUnits
    var tail: MLComputeUnits

    init(
        albert: MLComputeUnits = .cpuAndNeuralEngine,
        postAlbert: MLComputeUnits = .cpuAndNeuralEngine,
        alignment: MLComputeUnits = .cpuAndNeuralEngine,
        prosody: MLComputeUnits = .all,
        noise: MLComputeUnits = .all,
        vocoder: MLComputeUnits = .cpuAndNeuralEngine,
        tail: MLComputeUnits = .all
    ) {
        self.albert = albert
        self.postAlbert = postAlbert
        self.alignment = alignment
        self.prosody = prosody
        self.noise = noise
        self.vocoder = vocoder
        self.tail = tail
    }

    
    static let `default` = KokoroAneComputeUnits()

    
    static let cpuAndGpu = KokoroAneComputeUnits(
        albert: .cpuAndGPU, postAlbert: .cpuAndGPU, alignment: .cpuAndGPU,
        prosody: .cpuAndGPU, noise: .cpuAndGPU, vocoder: .cpuAndGPU, tail: .cpuAndGPU
    )

    
    
    
    static let allAne = KokoroAneComputeUnits(
        albert: .cpuAndNeuralEngine, postAlbert: .cpuAndNeuralEngine,
        alignment: .cpuAndNeuralEngine, prosody: .cpuAndNeuralEngine,
        noise: .cpuAndNeuralEngine, vocoder: .cpuAndNeuralEngine,
        tail: .cpuAndNeuralEngine
    )

    
    
    static let cpuOnly = KokoroAneComputeUnits(
        albert: .cpuOnly, postAlbert: .cpuOnly, alignment: .cpuOnly,
        prosody: .cpuOnly, noise: .cpuOnly, vocoder: .cpuOnly, tail: .cpuOnly
    )

    
    
    
    init(preset: TtsComputeUnitPreset) {
        switch preset {
        case .default:
            self = .default
        case .allAne:
            self = .allAne
        case .cpuAndGpu:
            self = .cpuAndGpu
        case .cpuOnly:
            self = .cpuOnly
        }
    }

    func units(for stage: KokoroAneStage) -> MLComputeUnits {
        switch stage {
        case .albert: return albert
        case .postAlbert: return postAlbert
        case .alignment: return alignment
        case .prosody: return prosody
        case .noise: return noise
        case .vocoder: return vocoder
        case .tail: return tail
        }
    }
}





actor KokoroAneModelStore {

    private let logger = AppLogger(category: "KokoroAneModelStore")

    private var models: [KokoroAneStage: MLModel] = [:]
    private var vocab: KokoroAneVocab?
    private var voicePacks: [String: KokoroAneVoicePack] = [:]
    private var repoDirectory: URL?

    private let directory: URL
    private let computeUnits: KokoroAneComputeUnits
    private let variant: KokoroAneVariant
    private let resourceDownloader: any KokoroAneResourceDownloading

    init(
        directory: URL,
        computeUnits: KokoroAneComputeUnits = .default,
        variant: KokoroAneVariant = .english,
        resourceDownloader: any KokoroAneResourceDownloading = KokoroAneResourceDownloader()
    ) {
        self.directory = directory
        self.computeUnits = computeUnits
        self.variant = variant
        self.resourceDownloader = resourceDownloader
    }

    
    
    
    
    
    
    func loadIfNeeded() async throws {
        guard models.isEmpty else { return }

        let repoDir = try await resourceDownloader.ensureModels(
            variant: variant, directory: directory)

        logger.info("Loading 7 KokoroAne CoreML models from \(repoDir.path)...")
        let loadStart = Date()

        var pendingModels: [KokoroAneStage: MLModel] = [:]
        for stage in KokoroAneStage.allCases {
            let url = repoDir.appendingPathComponent(stage.bundleName)
            guard FileManager.default.fileExists(atPath: url.path) else {
                throw KokoroAneError.modelNotLoaded(stage.bundleName)
            }
            let cfg = MLModelConfiguration()
            cfg.computeUnits = computeUnits.units(for: stage)
            cfg.allowLowPrecisionAccumulationOnGPU = true
            let stageStart = Date()
            let model = try MLModel(contentsOf: url, configuration: cfg)
            let stageElapsed = Date().timeIntervalSince(stageStart) * 1000
            pendingModels[stage] = model
            logger.info("  loaded \(stage.bundleName) in \(String(format: "%.0f", stageElapsed)) ms")
        }
        let elapsed = Date().timeIntervalSince(loadStart)
        logger.info("All 7 KokoroAne models loaded in \(String(format: "%.2f", elapsed))s")

        
        
        guard
            let vocabURL = ModelNames.KokoroAne.vocabularyFiles
                .map({ repoDir.appendingPathComponent($0) })
                .first(where: { FileManager.default.fileExists(atPath: $0.path) })
        else {
            throw KokoroAneError.vocabMissing(
                repoDir.appendingPathComponent(ModelNames.KokoroAne.huggingFaceVocab))
        }
        let loadedVocab = try KokoroAneVocab.load(from: vocabURL)
        logger.info("Loaded vocab (\(loadedVocab.map.count) entries)")

        
        
        self.models = pendingModels
        self.vocab = loadedVocab
        self.repoDirectory = repoDir

        
        
        _ = try await voicePack(variant.defaultVoice)
    }

    func model(for stage: KokoroAneStage) throws -> MLModel {
        guard let m = models[stage] else {
            throw KokoroAneError.modelNotLoaded(stage.bundleName)
        }
        return m
    }

    func vocabulary() throws -> KokoroAneVocab {
        guard let v = vocab else {
            throw KokoroAneError.modelNotLoaded("vocab.json")
        }
        return v
    }

    func voicePack(_ voice: String) async throws -> KokoroAneVoicePack {
        if let cached = voicePacks[voice] { return cached }
        guard let repoDir = repoDirectory else {
            throw KokoroAneError.modelNotLoaded("voice pack (repo not initialized)")
        }
        let url = try await resourceDownloader.ensureVoicePack(
            voice, repoDirectory: repoDir, variant: variant)
        let pack = try KokoroAneVoicePack.load(from: url)
        voicePacks[voice] = pack
        logger.info("Loaded voice pack '\(voice)'")
        return pack
    }

    var isLoaded: Bool {
        models.count == KokoroAneStage.allCases.count && vocab != nil
    }

    func cleanup() {
        models.removeAll()
        voicePacks.removeAll()
        vocab = nil
        repoDirectory = nil
    }
}
