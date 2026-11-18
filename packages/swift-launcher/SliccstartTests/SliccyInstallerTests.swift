import CryptoKit
import Darwin
import XCTest

@testable import Sliccstart

final class SliccyInstallerTests: XCTestCase {
    private var root: URL!
    private let payload = Data("fixture disk image".utf8)
    private var commands: [(String, [String])] = []
    private var downloads: [URL] = []
    private var metadata: [String: String] = [:]
    private var failureCommand: String?
    private var raceDestination = false

    override func setUpWithError() throws {
        root = FileManager.default.temporaryDirectory.appendingPathComponent("sliccy-install-test-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        commands = []
        downloads = []
        failureCommand = nil
        raceDestination = false
        metadata = [
            "CFBundleIdentifier": "ai.sliccy.mac", "CFBundleShortVersionString": SliccyRelease.version,
            "CFBundleExecutable": "Sliccy", "LSMinimumSystemVersion": "26.0",
        ]
    }

    override func tearDownWithError() throws { try? FileManager.default.removeItem(at: root) }

    private var directory: URL { root.appendingPathComponent("Applications") }
    private var destination: URL { directory.appendingPathComponent("Sliccy.app") }

    private func services() -> SliccyInstaller.Services {
        var services = SliccyInstaller.Services()
        services.existingApplication = { nil }
        services.download = { [self] url, to in
            downloads.append(url)
            try payload.write(to: to)
        }
        services.run = { [self] executable, args in
            commands.append((executable, args))
            if executable == failureCommand { throw SliccyInstallError.commandFailed(executable) }
            if args.first == "attach", let index = args.firstIndex(of: "-mountpoint") {
                let app = URL(fileURLWithPath: args[index + 1]).appendingPathComponent("Sliccy.app")
                try FileManager.default.createDirectory(at: app.appendingPathComponent("Contents/MacOS"), withIntermediateDirectories: true)
                try PropertyListSerialization.data(fromPropertyList: metadata, format: .xml, options: 0)
                    .write(to: app.appendingPathComponent("Contents/Info.plist"))
                try Data().write(to: app.appendingPathComponent("Contents/MacOS/Sliccy"))
                // Contents of a mounted quarantined image inherit quarantine.
                for path in [app.path, app.appendingPathComponent("Contents/MacOS/Sliccy").path] {
                    let value = "0083;00000000;Sliccstart;"
                    _ = value.withCString { setxattr(path, "com.apple.quarantine", $0, value.utf8.count, 0, 0) }
                }
            }
            if raceDestination, executable == "/usr/sbin/spctl", args.last?.contains(".sliccy-install-") == true {
                try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
                try Data("keep".utf8).write(to: destination.appendingPathComponent("marker"))
            }
        }
        return services
    }

    private func installer(
        services: SliccyInstaller.Services? = nil,
        hash: String? = nil,
        major: Int = 26,
        silicon: Bool = true
    ) -> SliccyInstaller {
        SliccyInstaller(
            directory: directory, temporaryDirectory: root,
            expectedSHA256: hash ?? SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined(),
            osVersion: .init(majorVersion: major, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: silicon, services: services ?? self.services()
        )
    }

    private func assertClean(file: StaticString = #filePath, line: UInt = #line) throws {
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path), file: file, line: line)
        let top = try FileManager.default.contentsOfDirectory(atPath: root.path)
        XCTAssertFalse(top.contains { $0.hasPrefix("sliccy-download-") }, file: file, line: line)
        if FileManager.default.fileExists(atPath: directory.path) {
            XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), [], file: file, line: line)
        }
    }

    func testInstallsOnlyPinnedVerifiedAppAndCleansUp() async throws {
        let installed = try await installer().install()
        XCTAssertEqual(installed, destination)
        XCTAssertEqual(downloads, [SliccyRelease.downloadURL])
        XCTAssertEqual(commands.filter { $0.0 == "/usr/bin/codesign" }.count, 2)
        for (_, args) in commands.filter({ $0.0 == "/usr/bin/codesign" }) {
            XCTAssertTrue(args.contains(SliccyRelease.signingRequirement))
            XCTAssertTrue(args.contains("--strict"))
            XCTAssertTrue(args.contains("--deep"))
        }
        XCTAssertEqual(commands.filter { $0.0 == "/usr/sbin/spctl" }.count, 2)
        XCTAssertEqual(commands.filter { $0.0 == "/usr/bin/lipo" }.count, 2)
        XCTAssertEqual(commands.last?.1.first, "detach")
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: root.path), ["Applications"])
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["Sliccy.app"])
        // A quarantined copy would launch translocated, where Sparkle refuses to update.
        for path in [installed.path, installed.appendingPathComponent("Contents/MacOS/Sliccy").path] {
            XCTAssertLessThan(getxattr(path, "com.apple.quarantine", nil, 0, 0, 0), 0, path)
        }
    }

    func testWrongDownloadHashNeverMountsOrInstalls() async throws {
        do {
            _ = try await installer(hash: "incorrect").install()
            XCTFail("accepted changed payload")
        } catch {}
        XCTAssertTrue(commands.isEmpty)
        try assertClean()
    }

    func testUnsupportedHostsNeverDownload() async throws {
        for (major, silicon) in [(25, true), (26, false)] {
            do {
                _ = try await installer(major: major, silicon: silicon).install()
                XCTFail("unsupported host")
            } catch {}
        }
        XCTAssertTrue(downloads.isEmpty)
        try assertClean()
    }

    func testExistingRegisteredAppIsPreservedBeforeDownloading() async throws {
        var service = services()
        let existing = root.appendingPathComponent("Existing Sliccy.app")
        try FileManager.default.createDirectory(at: existing, withIntermediateDirectories: true)
        service.existingApplication = { existing }
        do {
            _ = try await installer(services: service).install()
            XCTFail("existing app")
        } catch {}
        XCTAssertTrue(downloads.isEmpty)
        XCTAssertTrue(commands.isEmpty)
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testStaleNativeRegistrationDoesNotBlockDownload() async throws {
        var service = services()
        let missing = root.appendingPathComponent("missing/Sliccy.app")
        service.existingApplication = { missing }
        let installed = try await installer(services: service).install()
        XCTAssertEqual(installed, destination)
        XCTAssertEqual(downloads, [SliccyRelease.downloadURL])
    }

    func testExistingDestinationIsNeverReplaced() async throws {
        try FileManager.default.createDirectory(at: destination, withIntermediateDirectories: true)
        let marker = destination.appendingPathComponent("marker")
        try Data("keep".utf8).write(to: marker)
        do {
            _ = try await installer().install()
            XCTFail("existing destination")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: marker), Data("keep".utf8))
        XCTAssertTrue(downloads.isEmpty)
    }

    func testRacingDestinationIsNeverReplaced() async throws {
        raceDestination = true
        do {
            _ = try await installer().install()
            XCTFail("racing destination")
        } catch {}
        XCTAssertEqual(try Data(contentsOf: destination.appendingPathComponent("marker")), Data("keep".utf8))
        XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: directory.path), ["Sliccy.app"])
    }

    func testRejectsWrongIdentityVersionExecutableAndMinimumOS() async throws {
        for (key, badValue) in [
            ("CFBundleIdentifier", "com.slicc.sliccstart"), ("CFBundleShortVersionString", "0.2.0"),
            ("CFBundleExecutable", "../Other"), ("LSMinimumSystemVersion", "27.0"), ("LSMinimumSystemVersion", ""),
        ] {
            let original = metadata[key]
            metadata[key] = badValue
            commands = []
            do {
                _ = try await installer().install()
                XCTFail("accepted \(key)")
            } catch {}
            XCTAssertFalse(commands.contains { $0.0 == "/usr/bin/codesign" })
            XCTAssertEqual(commands.last?.1.first, "detach")
            try assertClean()
            metadata[key] = original
        }
    }

    func testInstalledValidationAcceptsLaterCompatibleReleaseButInstallerStaysPinned() async throws {
        metadata["CFBundleShortVersionString"] = "7.4.0"
        let mount = root.appendingPathComponent("metadata-check")
        try FileManager.default.createDirectory(at: mount, withIntermediateDirectories: true)
        let service = services()
        try await service.run("/usr/bin/hdiutil", ["attach", "-mountpoint", mount.path])
        let app = try await SliccyApplicationValidator.validate(
            mount.appendingPathComponent("Sliccy.app"), osVersion: .init(majorVersion: 27, minorVersion: 0, patchVersion: 0), run: service.run)
        XCTAssertEqual(app.version, "7.4.0")
        try FileManager.default.removeItem(at: mount)
        do {
            _ = try await installer().install()
            XCTFail("installer must require the pinned payload version")
        } catch {}
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testSignatureArchitectureAndGatekeeperFailuresNeverPublish() async throws {
        for failing in ["/usr/bin/codesign", "/usr/bin/lipo", "/usr/sbin/spctl"] {
            failureCommand = failing
            commands = []
            do {
                _ = try await installer().install()
                XCTFail("accepted failed check")
            } catch {}
            XCTAssertTrue(commands.contains { $0.0 == failing })
            XCTAssertEqual(commands.last?.1.first, "detach")
            try assertClean()
        }
    }

    func testCopiedAppMustPassVerificationAgainBeforePublishing() async throws {
        var service = services()
        let runner = service.run
        service.run = { executable, args in
            try await runner(executable, args)
            if executable == "/usr/bin/codesign", args.last?.contains(".sliccy-install-") == true {
                throw SliccyInstallError.commandFailed("codesign")
            }
        }
        do {
            _ = try await installer(services: service).install()
            XCTFail("copied app failed verification")
        } catch {}
        XCTAssertEqual(commands.filter { $0.0 == "/usr/bin/codesign" }.count, 2)
        XCTAssertEqual(commands.last?.1.first, "detach")
        try assertClean()
    }

    func testQuarantineReleaseFailureNeverPublishes() async throws {
        var service = services()
        service.releaseFromQuarantine = { _ in throw CocoaError(.fileWriteNoPermission) }
        do {
            _ = try await installer(services: service).install()
            XCTFail("quarantine release failure")
        } catch {}
        XCTAssertEqual(commands.last?.1.first, "detach")
        try assertClean()
    }

    func testMountFailureStillAttemptsCleanupWithoutForceDetach() async throws {
        failureCommand = "/usr/bin/hdiutil"
        do {
            _ = try await installer().install()
            XCTFail("mount failure")
        } catch {}
        XCTAssertEqual(commands.last?.1.first, "detach")
        XCTAssertFalse(commands.flatMap(\.1).contains("-force"))
        XCTAssertFalse(FileManager.default.fileExists(atPath: destination.path))
    }

    func testNetworkFailureCleansScratchBeforeRetry() async throws {
        var service = services()
        service.download = { _, _ in throw URLError(.notConnectedToInternet) }
        do {
            _ = try await installer(services: service).install()
            XCTFail("network failure")
        } catch {}
        XCTAssertTrue(commands.isEmpty)
        try assertClean()
        _ = try await installer().install()
        XCTAssertTrue(FileManager.default.fileExists(atPath: destination.path))
    }

    func testCancellationDuringDownloadCleansUp() async throws {
        let began = expectation(description: "download started")
        var service = services()
        service.download = { _, _ in
            began.fulfill()
            try await Task.sleep(nanoseconds: 30_000_000_000)
        }
        let subject = installer(services: service)
        let task = Task { try await subject.install() }
        await fulfillment(of: [began], timeout: 2)
        task.cancel()
        do {
            _ = try await task.value
            XCTFail("cancelled")
        } catch is CancellationError {} catch { XCTFail("\(error)") }
        try assertClean()
    }

    func testCancellationWhileMountedDetachesAndNeverPublishes() async throws {
        var service = services()
        let runner = service.run
        service.run = { executable, args in
            if executable == "/usr/bin/codesign" { throw CancellationError() }
            try await runner(executable, args)
        }
        do {
            _ = try await installer(services: service).install()
            XCTFail("cancelled")
        } catch {}
        XCTAssertEqual(commands.last?.1.first, "detach")
        try assertClean()
    }

    func testCommandFailureAndDeadlineAreBounded() async throws {
        do {
            try await SliccyInstallCommand("/usr/bin/false", arguments: []).execute()
            XCTFail("exit failure")
        } catch {}
        do {
            try await SliccyInstallCommand("/bin/sleep", arguments: ["30"], timeout: 0.05).execute()
            XCTFail("deadline")
        } catch {}
        try await SliccyInstallCommand.run("/usr/bin/true", arguments: [])
    }

    func testCommandCancellationBeforeLaunchDoesNotRunIt() async {
        let command = SliccyInstallCommand("/bin/sleep", arguments: ["30"])
        let task = Task {
            try Task.checkCancellation()
            try await command.execute()
        }
        task.cancel()
        do {
            try await task.value
            XCTFail("cancelled")
        } catch is CancellationError {} catch { XCTFail("\(error)") }
    }
}
