import Foundation
import Logging
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
        // pattern on their own. The injector falls back to the overlay
        // iframe's http origin (see `fetchProxyOrigin`) for these targets
        // so the escalation path doesn't silently bail.
        XCTAssertNil(OverlayTargetSession.overlayOrigin(for: "file:///tmp/index.html"))
    }

    // MARK: - Fetch-proxy origin fallback for file:// parents

    func testFetchProxyOriginUsesParentOriginWhenHttp() {
        // Matches node-server byte-for-byte: pattern keyed on the parent
        // page's http origin so we intercept the page's own resources to
        // strip CSP headers from the response.
        XCTAssertEqual(
            OverlayTargetSession.fetchProxyOrigin(
                targetURL: "https://teams.example/calendar",
                servePort: 5711
            ),
            "https://teams.example"
        )
    }

    func testFetchProxyOriginFallsBackToIframeHttpOriginForFileURL() {
        // For file:// renderers (e.g. AEM Desktop) the parent has no http
        // origin, so the previous build's escalation bailed silently. The
        // fix is to use the overlay iframe's own http origin so the iframe
        // load (http://localhost:<servePort>/electron) is at least covered
        // by Fetch interception.
        XCTAssertEqual(
            OverlayTargetSession.fetchProxyOrigin(
                targetURL: "file:///Applications/AEM%20Desktop.app/Contents/Resources/app.asar/src/renderer/index.html",
                servePort: 5711
            ),
            "http://localhost:5711"
        )
    }

    func testFetchProxyOriginUsesServePortInFallback() {
        // The fallback must thread the actual served port through —
        // OverlayTargetSession's `servePort` value, not a hardcoded one.
        XCTAssertEqual(
            OverlayTargetSession.fetchProxyOrigin(
                targetURL: "file:///opt/app/index.html",
                servePort: 5730
            ),
            "http://localhost:5730"
        )
    }

    // MARK: - Bypassed-state recording timing
    //
    // The reload-with-bypass path must NOT mark the URL as bypassed before
    // the iframe is confirmed loaded — if the CDP session disconnects
    // mid-reload (AEM Desktop's renderer recreates its execution context
    // during bootstrap, which closes our WS), the next reconnect would see
    // `alreadyBypassed=true` and `openAction` would skip the probe+reload
    // entirely, leaving the iframe permanently blocked.

    func testBypassedRecordedAfterImmediateLoadSuccess() {
        XCTAssertTrue(ElectronOverlayInjector.shouldRecordBypassedAfter(probeAction: .done))
    }

    func testBypassedNotRecordedAfterReloadDecision() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldRecordBypassedAfter(probeAction: .reloadWithBypass),
            "Recording bypassed=true before the reload completes would skip the reload on a mid-flight reconnect"
        )
    }

    func testBypassedRecordedAfterPostReloadDoneOnly() {
        XCTAssertTrue(ElectronOverlayInjector.shouldRecordBypassedAfter(postReloadAction: .done))
    }

    func testBypassedNotRecordedAfterPostReloadEscalation() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldRecordBypassedAfter(postReloadAction: .escalateToFetchProxy),
            "Escalation means the iframe is still blocked — don't record until Fetch-proxy confirms load"
        )
    }

    func testBypassedNotRecordedAfterNoEscalation() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldRecordBypassedAfter(postReloadAction: .noEscalationRequested)
        )
    }

    // MARK: - Disconnect-during-probe must fail in-flight continuations
    //
    // The original bug: `runReceiveLoop`'s catch path called `onClose()` but
    // not `stop()`, so the in-flight `sendCommand(awaitResponse:true)`
    // continuation (e.g. inside `probeOverlayLoaded`) never resolved →
    // `runConnectFlow` hung forever → the reload-with-bypass + Fetch-proxy
    // escalation never fired → iframe stayed CSP-blocked. The fix is to call
    // `stop()` on disconnect, which resumes every pending waiter with `nil`.

    func testStopResumesPendingWaitersWithNil() async {
        let session = OverlayTargetSession(
            target: ElectronInspectableTarget(
                type: "page",
                title: nil,
                url: "file:///tmp/x.html",
                webSocketDebuggerURL: "ws://127.0.0.1:9999/devtools/page/1"
            ),
            bootstrapScript: "/* noop */",
            servePort: 5711,
            session: .shared,
            logger: Logger(label: "test"),
            probeDelayNanoseconds: 1_000_000,
            commandTimeoutNanoseconds: 60_000_000_000,
            isAlreadyBypassed: { _ in false },
            recordBypassed: { _ in },
            onClose: { _ in }
        )

        let waiterTask = Task<[String: Any]?, Never> {
            await session._testing_awaitSyntheticWaiter()
        }

        // Wait until the waiter is registered (Task.yield isn't enough here
        // because withCheckedContinuation runs on its own executor).
        let registered = await waitFor(timeout: 1.0) {
            session._testing_pendingWaiterCount() == 1
        }
        XCTAssertTrue(registered, "synthetic waiter never registered")

        session.stop()

        let result = await waiterTask.value
        XCTAssertNil(result, "stop() must resume the pending waiter with nil")
        XCTAssertEqual(session._testing_pendingWaiterCount(), 0)
    }

    func testStopIsIdempotent() async {
        let session = OverlayTargetSession(
            target: ElectronInspectableTarget(
                type: "page",
                title: nil,
                url: "file:///tmp/x.html",
                webSocketDebuggerURL: "ws://127.0.0.1:9999/devtools/page/1"
            ),
            bootstrapScript: "/* noop */",
            servePort: 5711,
            session: .shared,
            logger: Logger(label: "test"),
            probeDelayNanoseconds: 1_000_000,
            commandTimeoutNanoseconds: 60_000_000_000,
            isAlreadyBypassed: { _ in false },
            recordBypassed: { _ in },
            onClose: { _ in }
        )
        session.stop()
        session.stop()
        XCTAssertEqual(session._testing_pendingWaiterCount(), 0)
    }

    private func waitFor(timeout seconds: Double, predicate: @Sendable () -> Bool) async -> Bool {
        let deadline = Date().addingTimeInterval(seconds)
        while Date() < deadline {
            if predicate() { return true }
            try? await Task.sleep(nanoseconds: 5_000_000)
        }
        return predicate()
    }

    private func makeTempDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }
}
