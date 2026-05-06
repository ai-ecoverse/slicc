import Foundation
import XCTest
@testable import Sliccstart

/// Pins the small pure-helper surface added by the local-models tab —
/// version pinning, suggested catalog shape, byte formatting, default
/// capability struct, and process/installer state defaults — so a future
/// refactor can't silently change a path the UI assembles or shift one of
/// the SwiftLM CLI defaults the chat panel relies on.
///
/// Anything filesystem- or network-sensitive is restricted to the
/// "absence" path (no installed binary, no cached snapshot) so the
/// suite stays hermetic and CI-stable.
final class LocalModelsHelpersTests: XCTestCase {

    // MARK: - SwiftLMVersion

    /// The pinned tag is bumped automatically by Renovate; the test only
    /// asserts the *shape* (non-empty, no `v` prefix, no whitespace) so
    /// it doesn't have to be touched on every release.
    func testSwiftLMVersionPinnedShape() {
        let pinned = SwiftLMVersion.pinned
        XCTAssertFalse(pinned.isEmpty)
        XCTAssertFalse(pinned.hasPrefix("v"), "Renovate `versioning=loose` strips no prefix; SwiftLM tags are bare like `b602`")
        XCTAssertNil(pinned.rangeOfCharacter(from: .whitespacesAndNewlines))
    }

    func testSwiftLMReleaseAssetNameMatchesPin() {
        let expected = "SwiftLM-\(SwiftLMVersion.pinned)-macos-arm64.tar.gz"
        XCTAssertEqual(SwiftLMVersion.releaseAssetName, expected)
    }

    func testSwiftLMReleaseURLPointsAtGithubReleases() {
        let url = SwiftLMVersion.releaseURL
        XCTAssertEqual(url.scheme, "https")
        XCTAssertEqual(url.host, "github.com")
        XCTAssertTrue(
            url.path.hasPrefix("/SharpAI/SwiftLM/releases/download/\(SwiftLMVersion.pinned)/"),
            "URL path drifted: \(url.path)"
        )
        XCTAssertTrue(url.path.hasSuffix(SwiftLMVersion.releaseAssetName))
    }

    // MARK: - SuggestedModels

    func testSuggestedCatalogIsNonEmptyAndContainsRecommendedModel() {
        let catalog = SuggestedModels.all
        XCTAssertFalse(catalog.isEmpty, "Models tab depends on a non-empty suggested catalog")
        XCTAssertTrue(
            catalog.contains(where: { $0.repoId == "mlx-community/Qwen3.6-35B-A3B-4bit" }),
            "Recommended model removed from catalog without updating tests"
        )
    }

    func testSuggestedCatalogEntriesHaveSensibleSizes() {
        for entry in SuggestedModels.all {
            XCTAssertFalse(entry.repoId.isEmpty, "empty repoId in catalog")
            XCTAssertTrue(entry.repoId.contains("/"), "HF repo IDs are `<org>/<name>`; got \(entry.repoId)")
            XCTAssertFalse(entry.summary.isEmpty)
            XCTAssertFalse(entry.note.isEmpty)
            XCTAssertGreaterThan(entry.approxSizeGB, 0, "size must be positive for \(entry.repoId)")
            XCTAssertLessThan(entry.approxSizeGB, 200, "implausible size for \(entry.repoId): \(entry.approxSizeGB) GB")
        }
    }

    // MARK: - HFCache helpers

    func testHubDirectoryEndsInHuggingfaceHub() {
        let dir = HFCache.hubDirectory
        // Don't pin the prefix (depends on `HF_HOME` / `HF_HUB_CACHE`),
        // just the trailing structure shared with the Python client.
        XCTAssertEqual(dir.lastPathComponent, "hub")
        XCTAssertEqual(dir.deletingLastPathComponent().lastPathComponent, "huggingface")
    }

    func testListInstalledReturnsArrayWithoutThrowing() {
        // Either there's a real cache (returns whatever happens to be
        // there) or there isn't (returns []) — both are valid; the test
        // only pins that the call doesn't crash and produces a sorted
        // array of well-formed `repoId`s.
        let installed = HFCache.listInstalled()
        XCTAssertEqual(installed, installed.sorted { $0.repoId < $1.repoId })
        for entry in installed {
            XCTAssertTrue(entry.repoId.contains("/"), "Malformed repoId: \(entry.repoId)")
            XCTAssertGreaterThanOrEqual(entry.sizeBytes, 0)
        }
    }

    func testListInstalledMLXModelsIsSubsetOfListInstalled() {
        let mlx = HFCache.listInstalledMLXModels()
        for entry in mlx {
            XCTAssertTrue(
                entry.repoId.hasPrefix("mlx-community/"),
                "Filter let through non-mlx repo: \(entry.repoId)"
            )
        }
    }

    func testDeleteIsNoOpForUnknownRepo() {
        // Pick a repo ID that won't exist on any test runner; delete
        // should silently succeed when the directory isn't present.
        XCTAssertNoThrow(try HFCache.delete(repoId: "mlx-community/__sliccstart-test-does-not-exist__"))
    }

    func testHumanByteSizeFormatsBytes() {
        XCTAssertFalse(Int64(0).humanByteSize.isEmpty)
        XCTAssertFalse(Int64(1024).humanByteSize.isEmpty)
        let oneGB: Int64 = 1_000_000_000
        let formatted = oneGB.humanByteSize
        XCTAssertTrue(
            formatted.contains("GB") || formatted.contains("MB"),
            "ByteCountFormatter output drifted: \(formatted)"
        )
    }

    // MARK: - ModelCapabilities

    func testUnknownCapabilitiesAreInert() {
        let unknown = ModelCapabilities.unknown
        XCTAssertFalse(unknown.supportsVision)
        XCTAssertNil(unknown.maxContextSize)
    }

    func testCapabilitiesProbeReturnsUnknownForMissingSnapshot() {
        let caps = ModelArchProbe.capabilities(for: "mlx-community/__sliccstart-test-does-not-exist__")
        XCTAssertEqual(caps, ModelCapabilities.unknown)
    }

    // MARK: - SwiftLMInstaller

    func testInstallerVersionDirectoryUnderSliccHome() {
        let installer = SwiftLMInstaller()
        let path = installer.versionDirectory.path
        XCTAssertTrue(path.contains("/.slicc/SwiftLM/\(SwiftLMVersion.pinned)"), "Drifted: \(path)")
        XCTAssertEqual(installer.binaryURL.lastPathComponent, "SwiftLM")
        XCTAssertEqual(installer.binaryURL.deletingLastPathComponent(), installer.versionDirectory)
    }

    func testInstallerNotInstalledOnFreshTestRunner() {
        // CI runners (and dev machines that haven't launched the Models
        // tab) won't have `~/.slicc/SwiftLM/<pinned>/SwiftLM`. The check
        // must say "not installed" rather than crashing.
        let installer = SwiftLMInstaller()
        if !FileManager.default.fileExists(atPath: installer.binaryURL.path) {
            XCTAssertFalse(installer.isInstalled)
        }
    }

    func testInstallErrorDescriptionsAreUserReadable() {
        let cases: [SwiftLMInstaller.InstallError] = [
            .downloadFailed(status: 404),
            .extractFailed(stderr: "tar: bad header"),
            .binaryMissing(URL(fileURLWithPath: "/tmp/nope")),
        ]
        for err in cases {
            let desc = err.errorDescription ?? ""
            XCTAssertFalse(desc.isEmpty, "missing description for \(err)")
        }
    }

    // MARK: - SwiftLMProcess

    @MainActor
    func testFreshProcessIsStopped() {
        let proc = SwiftLMProcess()
        XCTAssertEqual(proc.state, .stopped)
        XCTAssertFalse(proc.isRunning)
        XCTAssertNil(proc.loadedModel)
        XCTAssertEqual(proc.installerState, .idle)
    }

    @MainActor
    func testStopOnFreshProcessIsNoOp() {
        let proc = SwiftLMProcess()
        proc.stop()
        XCTAssertEqual(proc.state, .stopped)
        XCTAssertFalse(proc.isRunning)
    }

    func testLaunchErrorDescriptionsAreUserReadable() {
        let already = SwiftLMProcess.LaunchError.alreadyRunning.errorDescription ?? ""
        let port = SwiftLMProcess.LaunchError.portInUse(swiftLMPort).errorDescription ?? ""
        XCTAssertFalse(already.isEmpty)
        XCTAssertTrue(port.contains("\(swiftLMPort)"), "port in error message drifted: \(port)")
    }

    func testCliDefaultsAreLargeEnoughForReasoningModels() {
        // Defaults are tuned for the suggested catalog (Qwen 3.6 burns
        // 4–6k reasoning tokens before any user-visible content); pinning
        // the floor catches an accidental rollback to SwiftLM's stock
        // 2 048 max-tokens default.
        XCTAssertGreaterThanOrEqual(SwiftLMProcess.defaultMaxTokens, 16_384)
        XCTAssertGreaterThanOrEqual(SwiftLMProcess.fallbackContextSize, 16_384)
        XCTAssertEqual(SwiftLMProcess.corsOrigin, "*")
        XCTAssertEqual(swiftLMPort, 5413)
    }
}
