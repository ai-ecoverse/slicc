//
//  KokoroAneShims.swift
//  OnDeviceTTS
//
//  Thin replacements for the FluidAudio infrastructure symbols the vendored
//  KokoroAne sources reference (logging, model filenames, resource resolution).
//  Assets are provisioned anonymously from a revision-pinned Hugging Face
//  snapshot, or resolved directly from the developer override directory.
//

import Foundation
import HuggingFace
import OSLog

/// Unified OSLog subsystem for the whole package.
let ttsLogSubsystem = "com.ondevicetts"

// MARK: - Logging

struct AppLogger: Sendable {
    private let logger: Logger
    init(category: String) { logger = Logger(subsystem: ttsLogSubsystem, category: category) }
    func info(_ message: String) { logger.info("\(message, privacy: .public)") }
    func warning(_ message: String) { logger.warning("\(message, privacy: .public)") }
    func error(_ message: String) { logger.error("\(message, privacy: .public)") }
    func debug(_ message: String) { logger.debug("\(message, privacy: .public)") }
}

// MARK: - Asset filenames (we control both these and the S3 layout)

enum ModelNames {
    enum KokoroAne {
        static let huggingFaceVocab = "vocab_index.json"
        static let legacyVocab = "acoustic_vocab.json"
        static let vocabularyFiles = [huggingFaceVocab, legacyVocab]
    }
    enum G2P {
        static let vocabularyFile = "g2p_vocab.json"
        static let encoderFile = "G2PEncoder.mlmodelc"
        static let decoderFile = "G2PDecoder.mlmodelc"
    }
}

// MARK: - Repo (all English assets live in one flat folder)

enum Repo {
    case kokoro
    case kokoroAne
    case kokoroAneZh

    var folderName: String { "kokoro" }
}

// MARK: - Compute-unit preset (CLI parity; only used by ModelStore.init(preset:))

enum TtsComputeUnitPreset {
    case `default`
    case allAne
    case cpuAndGpu
    case cpuOnly
}

// MARK: - Revision-pinned resource provisioning

enum KokoroModelProvisioningError: Error, LocalizedError, Equatable, Sendable {
    case offline(String)
    case interrupted
    case httpFailure(String)
    case incompleteDownload(missing: [String])
    case storageFailure(String)

    var errorDescription: String? {
        switch self {
        case .offline(let detail): "Kokoro models are unavailable offline: \(detail)"
        case .interrupted: "Kokoro model download was interrupted"
        case .httpFailure(let detail): "Kokoro model download failed: \(detail)"
        case .incompleteDownload(let missing):
            "Kokoro model download is incomplete: \(missing.joined(separator: ", "))"
        case .storageFailure(let detail): "Kokoro model storage failed: \(detail)"
        }
    }
}

typealias KokoroDownloadProgressHandler = @MainActor @Sendable (Progress) -> Void

protocol KokoroHubSnapshotDownloading: Sendable {
    func downloadSnapshot(
        to destination: URL, matching globs: [String], localFilesOnly: Bool,
        progressHandler: KokoroDownloadProgressHandler?
    ) async throws -> URL
}

struct HuggingFaceKokoroSnapshotDownloader: KokoroHubSnapshotDownloading {
    private let injectedClient: HubClient?
    private let allowsCellularAccess: Bool

    init(
        client: HubClient? = nil,
        allowsCellularAccess: Bool = false
    ) {
        self.injectedClient = client
        self.allowsCellularAccess = allowsCellularAccess
    }

    func downloadSnapshot(
        to destination: URL, matching globs: [String], localFilesOnly: Bool,
        progressHandler: KokoroDownloadProgressHandler?
    ) async throws -> URL {
        let client = injectedClient ?? makeClient(for: destination)
        let effectiveGlobs: [String]
        if localFilesOnly {
            effectiveGlobs = globs
        } else {
            let entries = try await client.listFiles(
                in: HuggingFace.Repo.ID(
                    namespace: "FluidInference", name: "kokoro-82m-coreml"),
                kind: .model,
                revision: KokoroAneResourceDownloader.revision,
                recursive: true)
            effectiveGlobs = entries.filter {
                Self.matchesFile(path: $0.path, type: $0.type, globs: globs)
            }.map(\.path)
        }
        return try await client.downloadSnapshot(
            of: HuggingFace.Repo.ID(
                namespace: "FluidInference", name: "kokoro-82m-coreml"),
            kind: .model,
            to: destination,
            revision: KokoroAneResourceDownloader.revision,
            matching: effectiveGlobs,
            localFilesOnly: localFilesOnly,
            maxConcurrentDownloads: 4,
            progressHandler: progressHandler)
    }

    static func matchesFile(
        path: String, type: Git.TreeEntry.EntryType, globs: [String]
    ) -> Bool {
        type == .file && (globs.isEmpty || globs.contains { fnmatch($0, path, 0) == 0 })
    }

    private func makeClient(for destination: URL) -> HubClient {
        let configuration = Self.makeSessionConfiguration(
            allowsCellularAccess: allowsCellularAccess)
        let cache = HubCache(
            cacheDirectory: destination.appendingPathComponent(
                KokoroAneResourceDownloader.hubCacheDirectoryName, isDirectory: true))
        return HubClient(
            session: URLSession(configuration: configuration),
            host: HubClient.defaultHost,
            bearerToken: nil,
            cache: cache)
    }

    static func makeSessionConfiguration(
        allowsCellularAccess: Bool = false
    ) -> URLSessionConfiguration {
        let configuration = URLSessionConfiguration.default
        configuration.allowsCellularAccess = allowsCellularAccess
        configuration.waitsForConnectivity = false
        return configuration
    }
}

protocol KokoroAneResourceDownloading: Sendable {
    func ensureModels(variant: KokoroAneVariant, directory: URL) async throws -> URL
    func ensureModels(
        variant: KokoroAneVariant, directory: URL,
        progressHandler: KokoroDownloadProgressHandler?
    ) async throws -> URL
    func ensureVoicePack(
        _ voice: String, repoDirectory: URL, variant: KokoroAneVariant
    ) async throws -> URL
}

extension KokoroAneResourceDownloading {
    func ensureModels(
        variant: KokoroAneVariant, directory: URL,
        progressHandler: KokoroDownloadProgressHandler?
    ) async throws -> URL {
        try await ensureModels(variant: variant, directory: directory)
    }
}

actor KokoroAneResourceDownloader: KokoroAneResourceDownloading {
    static let revision = "c94edcb4b671856795458645cd389c0a9184e8bb"
    static let modelBundles = [
        "G2PEncoder.mlmodelc",
        "G2PDecoder.mlmodelc",
        "KokoroAlbert.mlmodelc",
        "KokoroPostAlbert.mlmodelc",
        "KokoroAlignment.mlmodelc",
        "KokoroProsody.mlmodelc",
        "KokoroNoise.mlmodelc",
        "KokoroVocoder.mlmodelc",
        "KokoroTail.mlmodelc",
    ]
    static let downloadableEntries =
        modelBundles + [
            ModelNames.KokoroAne.huggingFaceVocab,
            ModelNames.G2P.vocabularyFile,
            "voices/\(KokoroAneConstants.defaultVoice).json",
        ]
    static let matchingGlobs =
        modelBundles.map { "\(repositoryPath(for: $0))/*" } + [
            ModelNames.KokoroAne.huggingFaceVocab,
            ModelNames.G2P.vocabularyFile,
            "voices/\(KokoroAneConstants.defaultVoice).json",
        ]

    static func repositoryPath(for entry: String) -> String {
        entry.hasPrefix("Kokoro") && entry.hasSuffix(".mlmodelc") ? "ANE/\(entry)" : entry
    }

    static let completionMarker = ".provisioned"
    static let hubCacheDirectoryName = ".hub-cache"
    private let hubDownloader: any KokoroHubSnapshotDownloading
    private let fileManager: FileManager

    init(
        hubDownloader: any KokoroHubSnapshotDownloading = HuggingFaceKokoroSnapshotDownloader(),
        fileManager: FileManager = .default
    ) {
        self.hubDownloader = hubDownloader
        self.fileManager = fileManager
    }

    static func defaultModelsDirectory(fileManager: FileManager = .default) -> URL? {
        fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first?
            .appendingPathComponent("KokoroModels", isDirectory: true)
            .appendingPathComponent(revision, isDirectory: true)
    }

    func ensureModels(variant: KokoroAneVariant, directory: URL) async throws -> URL {
        try await ensureModels(variant: variant, directory: directory, progressHandler: nil)
    }

    func ensureModels(
        variant: KokoroAneVariant, directory: URL,
        progressHandler: KokoroDownloadProgressHandler?
    ) async throws -> URL {
        // Marker-free complete directories are developer packs; managed snapshots re-enter Hub's local-only check.
        if KokoroModelPresenceChecker.modelsPresent(in: directory, fileManager: fileManager),
            !fileManager.fileExists(atPath: markerURL(in: directory).path)
        {
            return directory
        }

        try prepare(directory)
        do {
            _ = try await hubDownloader.downloadSnapshot(
                to: directory, matching: Self.matchingGlobs, localFilesOnly: true,
                progressHandler: nil)
            try normalizeDownloadedLayout(in: directory)
            if downloadedEntriesPresent(in: directory) {
                try writeCompletionMarker(in: directory)
                return directory
            }
        } catch {
            if Task.isCancelled { throw KokoroModelProvisioningError.interrupted }
            if downloadedEntriesPresent(in: directory),
                fileManager.fileExists(atPath: markerURL(in: directory).path)
            {
                return directory
            }
        }

        do {
            _ = try await hubDownloader.downloadSnapshot(
                to: directory, matching: Self.matchingGlobs, localFilesOnly: false,
                progressHandler: progressHandler)
            try normalizeDownloadedLayout(in: directory)
        } catch {
            throw Self.classify(error)
        }

        let missing = missingDownloadedEntries(in: directory)
        guard missing.isEmpty else {
            throw KokoroModelProvisioningError.incompleteDownload(missing: missing)
        }
        try writeCompletionMarker(in: directory)
        return directory
    }

    func ensureVoicePack(
        _ voice: String, repoDirectory: URL, variant: KokoroAneVariant
    ) async throws -> URL {
        let url = repoDirectory.appendingPathComponent("voices/\(voice).json")
        guard fileManager.fileExists(atPath: url.path) else {
            throw KokoroAneError.voicePackMissing(url)
        }
        return url
    }

    private func prepare(_ directory: URL) throws {
        do {
            try fileManager.createDirectory(at: directory, withIntermediateDirectories: true)
            var durableDirectory = directory
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            try durableDirectory.setResourceValues(values)
        } catch {
            throw KokoroModelProvisioningError.storageFailure(error.localizedDescription)
        }
    }

    private func normalizeDownloadedLayout(in directory: URL) throws {
        do {
            for bundle in Self.modelBundles {
                let repositoryPath = Self.repositoryPath(for: bundle)
                guard repositoryPath != bundle else { continue }
                let source = directory.appendingPathComponent(repositoryPath, isDirectory: true)
                let destination = directory.appendingPathComponent(bundle, isDirectory: true)
                guard fileManager.fileExists(atPath: source.path),
                    !fileManager.fileExists(atPath: destination.path)
                else { continue }
                try fileManager.moveItem(at: source, to: destination)
            }
        } catch {
            throw KokoroModelProvisioningError.storageFailure(error.localizedDescription)
        }
    }

    private func downloadedEntriesPresent(in directory: URL) -> Bool {
        missingDownloadedEntries(in: directory).isEmpty
    }

    private func missingDownloadedEntries(in directory: URL) -> [String] {
        Self.downloadableEntries.filter {
            !fileManager.fileExists(atPath: directory.appendingPathComponent($0).path)
        }
    }

    private func markerURL(in directory: URL) -> URL {
        directory.appendingPathComponent(Self.completionMarker)
    }

    private func writeCompletionMarker(in directory: URL) throws {
        do {
            try Self.revision.write(
                to: markerURL(in: directory), atomically: true, encoding: .utf8)
        } catch {
            throw KokoroModelProvisioningError.storageFailure(error.localizedDescription)
        }
    }

    private static func classify(_ error: Error) -> KokoroModelProvisioningError {
        if let provisioningError = error as? KokoroModelProvisioningError {
            return provisioningError
        }
        if error is CancellationError { return .interrupted }
        if let urlError = error as? URLError {
            switch urlError.code {
            case .cancelled, .networkConnectionLost:
                return .interrupted
            case .notConnectedToInternet, .timedOut, .cannotFindHost, .cannotConnectToHost,
                .dnsLookupFailed, .internationalRoamingOff, .dataNotAllowed:
                return .offline(urlError.localizedDescription)
            default:
                return .httpFailure(urlError.localizedDescription)
            }
        }
        return .httpFailure(error.localizedDescription)
    }
}
