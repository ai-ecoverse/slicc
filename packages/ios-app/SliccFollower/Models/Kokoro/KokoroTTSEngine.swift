import Foundation

protocol KokoroSpeechSynthesizing: Sendable {
    func prepare() async throws
    func synthesize(text: String, voice: String, speed: Float) async throws -> [Float]
}

extension KokoroSpeechSynthesizing {
    func prepare() async throws {}
}

/// Local-only wrapper around the verified seven-stage CoreML Kokoro pipeline.
actor KokoroTTSEngine: KokoroSpeechSynthesizing {
    private let store: KokoroAneModelStore
    private let g2p: G2PModel
    private var textNormalizer: TextNormalization?
    private var didWarmUp = false

    init(modelsDirectory: URL) {
        #if targetEnvironment(simulator)
            store = KokoroAneModelStore(
                directory: modelsDirectory, computeUnits: .cpuOnly, variant: .english)
        #else
            store = KokoroAneModelStore(
                directory: modelsDirectory, computeUnits: .default, variant: .english)
        #endif
        g2p = G2PModel(modelsDirectory: modelsDirectory)
    }

    func prepare() async throws {
        guard !didWarmUp else { return }
        try await store.loadIfNeeded()
        try await g2p.ensureModelsAvailable()
        didWarmUp = true
    }

    func synthesize(text: String, voice: String, speed: Float) async throws -> [Float] {
        try await prepare()
        let phonemes = try await phonemize(text)
        let vocabulary = try await store.vocabulary()
        let inputIDs = try vocabulary.encode(phonemes)
        let pack = try await store.voicePack(voice)
        let (styleS, styleTimbre) = pack.slice(for: inputIDs.count)
        return try await KokoroAneSynthesizer.synthesize(
            inputIds: inputIDs,
            styleS: styleS,
            styleTimbre: styleTimbre,
            speed: speed,
            store: store
        ).samples
    }

    private func phonemize(_ text: String) async throws -> String {
        let normalizer: TextNormalization
        if let textNormalizer {
            normalizer = textNormalizer
        } else {
            normalizer = try .bundled()
            textNormalizer = normalizer
        }
        return try await normalizer.render(text) { word in
            try await self.g2p.phonemize(word: word)?.joined() ?? ""
        }
    }
}
