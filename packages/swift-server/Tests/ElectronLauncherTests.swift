import Foundation
import XCTest
@testable import slicc_server

final class ElectronLauncherTests: XCTestCase {
    func testResolveAppPathUsesBundleExecutableNameWhenPresent() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Sample.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        let executableURL = macOSDirectory.appendingPathComponent("Sample")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        XCTAssertEqual(try launcher.resolveAppPath(bundleURL.path), executableURL.path)
    }

    func testResolveAppPathFallsBackToElectronExecutable() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Slack.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        let helperURL = macOSDirectory.appendingPathComponent("Slack Helper")
        FileManager.default.createFile(atPath: helperURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperURL.path)

        let executableURL = macOSDirectory.appendingPathComponent("Electron")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        XCTAssertEqual(try launcher.resolveAppPath(bundleURL.path), executableURL.path)
    }

    func testSelectBestOverlayTargetsKeepsBestTargetPerOrigin() {
        let targets = [
            ElectronInspectableTarget(
                type: "page",
                title: "Microsoft Teams",
                url: "https://teams.example/#deepLink=default&isMinimized=false",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/1"
            ),
            ElectronInspectableTarget(
                type: "page",
                title: "Calendar | Adobe | Microsoft Teams",
                url: "https://teams.example/calendar",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/2"
            ),
            ElectronInspectableTarget(
                type: "page",
                title: "Standalone",
                url: "file:///tmp/index.html",
                webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/3"
            )
        ]

        XCTAssertEqual(
            selectBestOverlayTargets(targets).map(\.webSocketDebuggerURL),
            [
                "ws://127.0.0.1:9223/devtools/page/2",
                "ws://127.0.0.1:9223/devtools/page/3"
            ]
        )
    }

    // MARK: - Overlay state-machine decisions
    //
    // These exercise the pure decision helpers that drive the per-target
    // `OverlayTargetSession` state machine — added when swift-server picked up
    // the CSP-bypass + iframe-load-verification flow from node-server. They
    // cover the "bypassed-state guard" (second connect skips probe+reload) and
    // the "probe not loaded → reload-with-bypass" path that fixes the blank
    // overlay inside CSP-bearing Electron apps like AEM Desktop.

    func testOpenActionInjectsAndProbesOnFirstConnection() {
        XCTAssertEqual(
            ElectronOverlayInjector.openAction(alreadyCSPBypassed: false),
            .injectThenProbe
        )
    }

    func testBypassedStateGuardSkipsProbeAndReload() {
        // Once a target URL has been recorded as CSP-bypassed, subsequent
        // reconnects must not trigger another probe/reload cycle — that is
        // the loop guard mirroring node-server's `cspBypassedTargets`.
        XCTAssertEqual(
            ElectronOverlayInjector.openAction(alreadyCSPBypassed: true),
            .injectOnly
        )
    }

    func testProbeLoadedSignalsDone() {
        XCTAssertEqual(ElectronOverlayInjector.postProbeAction(loaded: true), .done)
    }

    func testProbeNotLoadedTriggersReloadWithBypass() {
        XCTAssertEqual(
            ElectronOverlayInjector.postProbeAction(loaded: false),
            .reloadWithBypass
        )
    }

    func testPostReloadWithoutEscalationDoesNothingExtra() {
        XCTAssertEqual(
            ElectronOverlayInjector.postReloadAction(loaded: false, escalationRequested: false),
            .noEscalationRequested
        )
        XCTAssertEqual(
            ElectronOverlayInjector.postReloadAction(loaded: true, escalationRequested: false),
            .noEscalationRequested
        )
    }

    func testPostReloadEscalatesToFetchProxyWhenStillBlocked() {
        XCTAssertEqual(
            ElectronOverlayInjector.postReloadAction(loaded: false, escalationRequested: true),
            .escalateToFetchProxy
        )
    }

    func testPostReloadIsDoneWhenIframeLoadsAfterBypassedReload() {
        XCTAssertEqual(
            ElectronOverlayInjector.postReloadAction(loaded: true, escalationRequested: true),
            .done
        )
    }

    // MARK: - Bypassed-URL bookkeeping

    func testBypassedURLSeedingIsObservable() {
        // The injector exposes a tiny test-only surface so we can verify the
        // bypassed-URL set is the shared bookkeeping point that drives the
        // open-action decision across reconnects.
        let injector = ElectronOverlayInjector(cdpPort: 0, servePort: 0)
        XCTAssertTrue(injector._testing_bypassedURLs().isEmpty)

        let url = "file:///Applications/AEM%20Desktop.app/Contents/Resources/app.asar/src/renderer/index.html"
        injector._testing_seedBypassedURL(url)
        XCTAssertEqual(injector._testing_bypassedURLs(), [url])

        // A second seed of the same URL stays a set membership (no duplicate),
        // matching the underlying `Set` semantics.
        injector._testing_seedBypassedURL(url)
        XCTAssertEqual(injector._testing_bypassedURLs(), [url])
    }

    // MARK: - Fetch-proxy origin helper

    func testOverlayOriginIncludesExplicitPort() {
        XCTAssertEqual(
            OverlayTargetSession.overlayOrigin(for: "https://example.com:8443/path?q=1#x"),
            "https://example.com:8443"
        )
    }

    func testOverlayOriginOmitsImplicitPort() {
        XCTAssertEqual(
            OverlayTargetSession.overlayOrigin(for: "https://example.com/index.html"),
            "https://example.com"
        )
    }

    func testOverlayOriginReturnsNilForFileURL() {
        // file:// URLs have no host, so they cannot anchor a Fetch.enable
        // pattern. The injector's open flow handles CSP via setBypassCSP +
        // reload for these targets instead of the Fetch-proxy escalation.
        XCTAssertNil(OverlayTargetSession.overlayOrigin(for: "file:///tmp/index.html"))
    }

    private func makeTempDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
