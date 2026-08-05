import Foundation
import XCTest

@testable import SliccFollower

@MainActor
final class KokoroResourceDownloaderTests: XCTestCase {
    private enum TestError: Error {
        case cacheMiss
        case http
    }

    private actor FakeHubDownloader: KokoroHubSnapshotDownloading {
        enum Behavior: Sendable {
            case cacheHit
            case coldFetch
            case offline
            case partial
            case interrupted
            case http
        }

        let behavior: Behavior
        private var modes: [Bool] = []

        init(_ behavior: Behavior) { self.behavior = behavior }

        func downloadSnapshot(
            to destination: URL, matching globs: [String], localFilesOnly: Bool,
            progressHandler: KokoroDownloadProgressHandler?
        ) async throws -> URL {
            modes.append(localFilesOnly)
            let progress = Progress(totalUnitCount: 100)
            if !localFilesOnly {
                progress.completedUnitCount = 35
                await progressHandler?(progress)
            }
            switch (behavior, localFilesOnly) {
            case (.cacheHit, true):
                try populate(destination)
            case (.coldFetch, false):
                try populate(destination)
            case (.partial, false):
                try populate(destination, missing: "KokoroTail.mlmodelc")
            case (.offline, false):
                throw URLError(.notConnectedToInternet)
            case (.interrupted, false):
                throw CancellationError()
            case (.http, false):
                throw TestError.http
            default:
                throw TestError.cacheMiss
            }
            if !localFilesOnly {
                progress.completedUnitCount = 100
                await progressHandler?(progress)
            }
            return destination
        }

        func requestedModes() -> [Bool] { modes }

        private func populate(_ destination: URL, missing: String? = nil) throws {
            for entry in KokoroAneResourceDownloader.downloadableEntries where entry != missing {
                let url = destination.appendingPathComponent(
                    KokoroAneResourceDownloader.repositoryPath(for: entry))
                if entry.hasSuffix(".mlmodelc") {
                    try FileManager.default.createDirectory(
                        at: url, withIntermediateDirectories: true)
                } else {
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data("{}".utf8).write(to: url)
                }
            }
        }
    }

    func testGlobsSelectEnglishSynthesisModelsAndRootG2PResources() {
        let expected = Set(
            KokoroAneResourceDownloader.modelBundles.map {
                "\(KokoroAneResourceDownloader.repositoryPath(for: $0))/*"
            } + [
                "vocab_index.json", "g2p_vocab.json", "voices/af_heart.json",
            ])
        XCTAssertEqual(Set(KokoroAneResourceDownloader.matchingGlobs), expected)
        XCTAssertTrue(
            KokoroAneResourceDownloader.matchingGlobs.contains(
                "ANE/KokoroVocoder.mlmodelc/*"))
        XCTAssertTrue(
            KokoroAneResourceDownloader.matchingGlobs.contains("G2PEncoder.mlmodelc/*"))
        XCTAssertTrue(
            HuggingFaceKokoroSnapshotDownloader.matchesFile(
                path: "ANE/KokoroVocoder.mlmodelc/weights/weight.bin", type: .file,
                globs: KokoroAneResourceDownloader.matchingGlobs))
        XCTAssertFalse(
            HuggingFaceKokoroSnapshotDownloader.matchesFile(
                path: "ANE/KokoroVocoder.mlmodelc/weights", type: .directory,
                globs: KokoroAneResourceDownloader.matchingGlobs))
    }

    func testManagedSessionIsWiFiOnlyAndFailsFastWithoutConnectivity() {
        let configuration = HuggingFaceKokoroSnapshotDownloader.makeSessionConfiguration()

        XCTAssertFalse(configuration.allowsCellularAccess)
        XCTAssertFalse(configuration.waitsForConnectivity)
    }

    func testCacheHitUsesLocalFilesOnlyWithoutNetworkFetch() async throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        let fake = FakeHubDownloader(.cacheHit)
        let downloader = KokoroAneResourceDownloader(hubDownloader: fake)

        let resolved = try await downloader.ensureModels(variant: .english, directory: directory)

        XCTAssertEqual(resolved, directory)
        let requestedModes = await fake.requestedModes()
        XCTAssertEqual(requestedModes, [true])
    }

    func testColdFetchChecksCacheThenDownloadsAndExcludesBackup() async throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        let fake = FakeHubDownloader(.coldFetch)
        let downloader = KokoroAneResourceDownloader(hubDownloader: fake)

        var fractions: [Double] = []
        _ = try await downloader.ensureModels(
            variant: .english,
            directory: directory,
            progressHandler: { fractions.append($0.fractionCompleted) })

        let requestedModes = await fake.requestedModes()
        XCTAssertEqual(requestedModes, [true, false])
        XCTAssertEqual(fractions, [0.35, 1])
        XCTAssertTrue(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("KokoroVocoder.mlmodelc").path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent("ANE/KokoroVocoder.mlmodelc").path))
        let values = try directory.resourceValues(forKeys: [.isExcludedFromBackupKey])
        XCTAssertEqual(values.isExcludedFromBackup, true)
    }

    func testOfflineFailureIsTyped() async {
        await assertFailure(.offline, expected: .offline("The Internet connection appears to be offline."))
    }

    func testPartialDownloadIsTypedAndNamesMissingEntry() async {
        guard let error = await provisioningError(for: .partial) else { return }
        guard case .incompleteDownload(let missing) = error else {
            return XCTFail("expected incomplete download, got \(error)")
        }
        XCTAssertEqual(missing, ["KokoroTail.mlmodelc"])
    }

    func testInterruptedDownloadIsTyped() async {
        await assertFailure(.interrupted, expected: .interrupted)
    }

    func testHTTPFailureIsTyped() async {
        guard let error = await provisioningError(for: .http) else { return }
        guard case .httpFailure = error else {
            return XCTFail("expected HTTP failure, got \(error)")
        }
    }

    func testCompleteLegacyOverrideShortCircuitsHub() async throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        for entry in KokoroAneResourceDownloader.downloadableEntries
        where entry != ModelNames.KokoroAne.huggingFaceVocab {
            try createEntry(entry, in: directory)
        }
        try createEntry(ModelNames.KokoroAne.legacyVocab, in: directory)
        let fake = FakeHubDownloader(.offline)
        let downloader = KokoroAneResourceDownloader(hubDownloader: fake)

        let resolved = try await downloader.ensureModels(variant: .english, directory: directory)
        XCTAssertEqual(resolved, directory)
        let requestedModes = await fake.requestedModes()
        XCTAssertEqual(requestedModes, [])
    }

    func testManagedSnapshotWithMarkerReentersLocalOnlyHubCheck() async throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        for entry in KokoroAneResourceDownloader.downloadableEntries {
            try createEntry(entry, in: directory)
        }
        try KokoroAneResourceDownloader.revision.write(
            to: directory.appendingPathComponent(KokoroAneResourceDownloader.completionMarker),
            atomically: true,
            encoding: .utf8)
        let fake = FakeHubDownloader(.cacheHit)
        let downloader = KokoroAneResourceDownloader(hubDownloader: fake)

        _ = try await downloader.ensureModels(variant: .english, directory: directory)

        let requestedModes = await fake.requestedModes()
        XCTAssertEqual(requestedModes, [true])
    }

    func testHuggingFaceVocabIndexShapeLoadsAcousticVocabulary() throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let url = directory.appendingPathComponent("vocab_index.json")
        try Data(#"{"vocab":{"a":43,"ɹ":123},"metadata":{"size":2}}"#.utf8).write(to: url)

        let vocabulary = try KokoroAneVocab.load(from: url)

        XCTAssertEqual(vocabulary.map["a"], 43)
        XCTAssertEqual(vocabulary.map["ɹ"], 123)
    }

    private func assertFailure(
        _ behavior: FakeHubDownloader.Behavior, expected: KokoroModelProvisioningError
    ) async {
        let error = await provisioningError(for: behavior)
        guard let error else { return XCTFail("expected provisioning failure") }
        switch (error, expected) {
        case (.offline, .offline), (.interrupted, .interrupted): break
        default: XCTFail("expected \(expected), got \(error)")
        }
    }

    private func provisioningError(
        for behavior: FakeHubDownloader.Behavior
    ) async -> KokoroModelProvisioningError? {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        do {
            _ = try await KokoroAneResourceDownloader(hubDownloader: FakeHubDownloader(behavior))
                .ensureModels(variant: .english, directory: directory)
            XCTFail("expected provisioning failure")
            return nil
        } catch let error as KokoroModelProvisioningError {
            return error
        } catch {
            XCTFail("unexpected error: \(error)")
            return nil
        }
    }

    private func temporaryDirectory() -> (URL, () -> Void) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        return (directory, { try? FileManager.default.removeItem(at: directory) })
    }

    private func createEntry(_ entry: String, in directory: URL) throws {
        let url = directory.appendingPathComponent(entry)
        if entry.hasSuffix(".mlmodelc") {
            try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        } else {
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
            try Data().write(to: url)
        }
    }
}
