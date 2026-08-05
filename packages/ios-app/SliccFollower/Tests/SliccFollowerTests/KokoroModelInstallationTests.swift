import Foundation
import XCTest

@testable import SliccFollower

@MainActor
final class KokoroModelInstallationTests: XCTestCase {
    private actor FakeResourceDownloader: KokoroAneResourceDownloading {
        enum Behavior: Sendable {
            case success
            case waiting
            case failure(KokoroModelProvisioningError)
        }

        let behavior: Behavior
        private var callCount = 0

        init(_ behavior: Behavior) { self.behavior = behavior }

        func ensureModels(variant: KokoroAneVariant, directory: URL) async throws -> URL {
            try await ensureModels(variant: variant, directory: directory, progressHandler: nil)
        }

        func ensureModels(
            variant: KokoroAneVariant, directory: URL,
            progressHandler: KokoroDownloadProgressHandler?
        ) async throws -> URL {
            callCount += 1
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try Data("partial".utf8).write(to: directory.appendingPathComponent("partial"))
            let progress = Progress(totalUnitCount: 100)
            progress.completedUnitCount = 25
            await progressHandler?(progress)
            switch behavior {
            case .success:
                try await Task.sleep(for: .milliseconds(80))
                try Self.populate(directory)
                progress.completedUnitCount = 100
                await progressHandler?(progress)
                return directory
            case .waiting:
                try await Task.sleep(for: .seconds(60))
                return directory
            case .failure(let error):
                throw error
            }
        }

        func ensureVoicePack(
            _ voice: String, repoDirectory: URL, variant: KokoroAneVariant
        ) async throws -> URL {
            repoDirectory.appendingPathComponent("voices/\(voice).json")
        }

        func calls() -> Int { callCount }

        static func populate(_ directory: URL) throws {
            for entry in KokoroAneResourceDownloader.downloadableEntries {
                let url = directory.appendingPathComponent(entry)
                if entry.hasSuffix(".mlmodelc") {
                    try FileManager.default.createDirectory(
                        at: url, withIntermediateDirectories: true)
                } else {
                    try FileManager.default.createDirectory(
                        at: url.deletingLastPathComponent(), withIntermediateDirectories: true)
                    try Data("{}".utf8).write(to: url)
                }
            }
            try KokoroAneResourceDownloader.revision.write(
                to: directory.appendingPathComponent(
                    KokoroAneResourceDownloader.completionMarker),
                atomically: true,
                encoding: .utf8)
        }
    }

    private struct MissingModels: KokoroModelPresenceChecking {
        func modelsPresent(in directory: URL) -> Bool { false }
    }

    private final class FakeSystemSpeaker: SpeechSpeaking {
        var spoken: [(String, String?)] = []
        func speak(_ text: String, lang: String?) { spoken.append((text, lang)) }
        func stop() {}
        func hasVoice(for lang: String) -> Bool { true }
    }

    func testRequestStartsDownloadImmediately() async {
        // One-click contract: the button copy carries the size/Wi-Fi
        // disclosure, so requestInstallation IS the consent — no separate
        // confirm step exists between the tap and the download.
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        let installation = makeInstallation(
            directory: directory, downloader: FakeResourceDownloader(.success))

        XCTAssertEqual(installation.state, .notInstalled)
        XCTAssertNil(installation.downloadStartedAt)
        installation.requestInstallation()

        guard case .downloading = installation.state else {
            return XCTFail("expected .downloading immediately, got \(installation.state)")
        }
        XCTAssertNotNil(installation.downloadStartedAt)
        await waitUntil { installation.state == .downloading(fraction: 0.25) }
        await waitUntil { installation.state == .installed }
        XCTAssertNil(installation.downloadStartedAt)
    }

    func testCancellationReturnsToNotInstalledAndRemovesPartialFiles() async {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        let installation = makeInstallation(
            directory: directory, downloader: FakeResourceDownloader(.waiting))
        installation.requestInstallation()
        await waitUntil { installation.state == .downloading(fraction: 0.25) }

        installation.cancelDownload()

        XCTAssertEqual(installation.state, .notInstalled)
        XCTAssertNil(installation.downloadStartedAt)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
        XCTAssertFalse(
            FileManager.default.fileExists(
                atPath: directory.appendingPathComponent(
                    KokoroAneResourceDownloader.completionMarker
                ).path))
    }

    func testRemovingInstalledModelsDeletesSnapshotAndMarker() throws {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        try FakeResourceDownloader.populate(directory)
        let installation = makeInstallation(
            directory: directory, downloader: FakeResourceDownloader(.success))
        XCTAssertEqual(installation.state, .installed)

        installation.removeInstallation()

        XCTAssertEqual(installation.state, .notInstalled)
        XCTAssertFalse(FileManager.default.fileExists(atPath: directory.path))
    }

    func testDeveloperPackIsInstalledWithoutDownloadAndCannotBeRemoved() async {
        let fake = FakeResourceDownloader(.success)
        let installation = KokoroModelInstallation(
            developmentDirectory: URL(fileURLWithPath: "/developer-pack", isDirectory: true),
            managedDirectory: nil,
            resourceDownloader: fake)

        XCTAssertEqual(installation.state, .installed)
        installation.requestInstallation()
        installation.removeInstallation()
        XCTAssertEqual(installation.state, .installed)
        let callCount = await fake.calls()
        XCTAssertEqual(callCount, 0)
    }

    func testTypedOfflineFailureKeepsEnglishReplyOnSystemFallback() async {
        let (directory, cleanup) = temporaryDirectory()
        defer { cleanup() }
        let installation = makeInstallation(
            directory: directory,
            downloader: FakeResourceDownloader(.failure(.offline("Wi-Fi unavailable"))))
        installation.requestInstallation()
        await waitUntil {
            installation.state == .failed(.offline("Wi-Fi unavailable"))
        }

        let system = FakeSystemSpeaker()
        let speaker = KokoroSpeaker(
            modelDirectory: nil,
            managedModelDirectory: directory,
            resourceDownloader: nil,
            presenceChecker: MissingModels(),
            fallback: system)
        VoiceReply(speaker: speaker).speakReply(markdown: "<!--lang:en-->Still speaking.")

        XCTAssertEqual(system.spoken.first?.0, "Still speaking.")
        XCTAssertEqual(system.spoken.first?.1, "en")
    }

    private func makeInstallation(
        directory: URL, downloader: any KokoroAneResourceDownloading
    ) -> KokoroModelInstallation {
        KokoroModelInstallation(
            developmentDirectory: nil,
            managedDirectory: directory,
            resourceDownloader: downloader)
    }

    private func waitUntil(
        _ condition: @escaping @MainActor () -> Bool,
        file: StaticString = #filePath,
        line: UInt = #line
    ) async {
        for _ in 0..<100 {
            if condition() { return }
            try? await Task.sleep(for: .milliseconds(10))
        }
        XCTFail("condition did not become true", file: file, line: line)
    }

    private func temporaryDirectory() -> (URL, () -> Void) {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        return (directory, { try? FileManager.default.removeItem(at: directory) })
    }
}
