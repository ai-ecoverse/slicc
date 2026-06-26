import Foundation
import Logging
import XCTest
@testable import slicc_server

/// Thread-safe call counter for `@Sendable` probe closures in the
/// `pollOverlayLoaded` tests.
private final class ProbeCallCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var stored = 0

    @discardableResult
    func increment() -> Int {
        lock.lock()
        defer { lock.unlock() }
        stored += 1
        return stored
    }

    var value: Int {
        lock.lock()
        defer { lock.unlock() }
        return stored
    }
}

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

    // MARK: - First-attempt overlay probe poll/retry (#1085)
    //
    // The single-shot first probe could fire while the overlay iframe was still
    // at `about:blank` (cross-origin nav not yet committed), yielding a false
    // "blocked" that tripped a spurious CSP-bypass reload — which on swift then
    // starved the injector's own CDP session once the /cdp bridge connected.
    // `pollOverlayLoaded` re-probes on a fixed cadence and returns the instant
    // the committed cross-origin navigation is observed.

    func testPollOverlayLoadedReturnsAsSoonAsProbeSucceeds() async {
        let attempts = ProbeCallCounter()
        let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
            budgetNanoseconds: 1_000_000_000,
            intervalNanoseconds: 1_000_000,
            probe: {
                // Not loaded for the first two attempts (still about:blank),
                // then the cross-origin navigation commits.
                attempts.increment() >= 3
            }
        )
        XCTAssertTrue(loaded)
        XCTAssertEqual(attempts.value, 3, "must stop polling the instant the iframe reports loaded")
    }

    func testPollOverlayLoadedReturnsFalseWhenBudgetExhausted() async {
        let attempts = ProbeCallCounter()
        let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
            budgetNanoseconds: 60_000_000,
            intervalNanoseconds: 20_000_000,
            probe: {
                _ = attempts.increment()
                return false
            }
        )
        XCTAssertFalse(loaded, "a frame that never commits must classify as not-loaded so escalation fires")
        // Probes at t≈0/20/40/60ms then the budget is exhausted: at least the
        // first probe runs, and the loop bounds the count to the budget.
        XCTAssertGreaterThanOrEqual(attempts.value, 1)
        XCTAssertLessThanOrEqual(attempts.value, 5)
    }

    func testPollOverlayLoadedShortCircuitsWhenShouldStop() async {
        let attempts = ProbeCallCounter()
        let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
            budgetNanoseconds: 1_000_000_000,
            intervalNanoseconds: 1_000_000,
            shouldStop: { true },
            probe: {
                _ = attempts.increment()
                return true
            }
        )
        XCTAssertFalse(loaded, "cancellation/teardown must abort the poll before probing")
        XCTAssertEqual(attempts.value, 0)
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
        let injector = ElectronOverlayInjector(_testingServePort: 0, cdpPort: 0)
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

    func testOverlayOriginReturnsNilForCustomScheme() {
        // Custom schemes like `app://` (Electron `protocol.registerSchemesAsPrivileged`)
        // parse with a host component, so without the http/https gate
        // `URL.host` would return e.g. "renderer" and we'd key `Fetch.enable`
        // on `app://renderer` — a pattern CDP cannot intercept. The fix
        // forces these to fall back to `http://localhost:<servePort>` via
        // `fetchProxyOrigin` so the overlay iframe load is still covered.
        XCTAssertNil(OverlayTargetSession.overlayOrigin(for: "app://renderer/index.html"))
        XCTAssertNil(OverlayTargetSession.overlayOrigin(for: "chrome-extension://abc/popup.html"))
    }

    func testFetchProxyOriginFallsBackForCustomScheme() {
        // Companion: `fetchProxyOrigin` must thread the localhost fallback
        // for any non-http parent, not just file://. Matches node-server's
        // `resolveFetchProxyOrigin`.
        XCTAssertEqual(
            OverlayTargetSession.fetchProxyOrigin(
                targetURL: "app://renderer/index.html",
                servePort: 5711
            ),
            "http://localhost:5711"
        )
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

    // MARK: - Bootstrap-script frame/origin guard
    //
    // `Page.addScriptToEvaluateOnNewDocument` runs in EVERY new document
    // including our own overlay iframe at `http://localhost:<servePort>`.
    // Without the guard the Slicc webapp inside the iframe re-runs the
    // bootstrap and injects another launcher inside itself, nesting up to
    // N levels — exactly the "Slicc buttons inside the Slicc iframe"
    // regression observed on AEM Desktop. node-server doesn't hit this
    // because it doesn't register an all-frames script.

    func testBootstrapScriptGuardsAgainstSubframes() {
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "/* bundle */",
            appURL: "http://localhost:5711/electron"
        )
        XCTAssertTrue(
            script.contains("window.top!==window.self"),
            "bootstrap must early-return when not running in the top frame"
        )
    }

    func testBootstrapScriptGuardsAgainstOverlayOrigin() {
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "/* bundle */",
            appURL: "http://localhost:5711/electron"
        )
        XCTAssertTrue(
            script.contains("location.origin===new URL(\"http://localhost:5711/electron\").origin"),
            "bootstrap must early-return when running inside the overlay iframe's own origin"
        )
    }

    func testBootstrapScriptWrapsInjectionInIIFE() {
        // Both guards must precede the injection call so `return` aborts
        // the call without running it.
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "/* bundle */",
            appURL: "http://localhost:5711/electron"
        )
        XCTAssertTrue(script.contains("(function(){"))
        XCTAssertTrue(script.contains("})();"))
    }

    func testBootstrapScriptEscapesAppURLInOriginGuard() {
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "/* bundle */",
            appURL: "http://example.com/path\"with-quote"
        )
        XCTAssertTrue(
            script.contains("\\\"with-quote"),
            "app URL must be JS-escaped wherever it appears in the bootstrap"
        )
    }

    // MARK: - Idempotent new-document registration
    //
    // `Page.addScriptToEvaluateOnNewDocument` is only meaningful once per
    // session — registering twice would install a duplicate hook and waste
    // CDP work. The pure helper drives the skip decision.

    func testShouldSkipNewDocumentRegistrationWhenAlreadyRegistered() {
        XCTAssertTrue(
            ElectronOverlayInjector.shouldSkipNewDocumentRegistration(currentIdentifier: "1")
        )
    }

    func testShouldNotSkipNewDocumentRegistrationOnFirstCall() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldSkipNewDocumentRegistration(currentIdentifier: nil)
        )
    }

    // MARK: - Overlay eviction re-injection (#1125 parity)
    //
    // An in-page SPA route change (or DOM-root re-render) can evict
    // `#slicc-electron-overlay-root` while the `__SLICC_ELECTRON_OVERLAY__`
    // marker persists. The Swift injector reaches node-server parity by
    // re-injecting on `Page.navigatedWithinDocument` / main-frame
    // `Page.frameNavigated` and via a periodic presence re-check — both gated on
    // the eviction probe so re-injection is idempotent, never loops while the
    // host element is attached, and reuses the existing role bootstrap.

    func testOverlayEvictedProbeOnlyReportsEvictedWhenMarkerPresentButRootGone() {
        let expression = ElectronOverlayInjector.overlayEvictedProbeExpression()
        XCTAssertTrue(expression.contains("__SLICC_ELECTRON_OVERLAY__"))
        XCTAssertTrue(expression.contains("getElementById('slicc-electron-overlay-root')"))
        XCTAssertTrue(expression.contains("(hasMarker && !hasRoot) ? 'evicted' : 'ok'"))
        // An exception must classify as 'ok' so probe errors never re-inject.
        XCTAssertTrue(expression.contains("return 'ok'"))
    }

    func testShouldReinjectOnlyForEvictedProbeResult() {
        XCTAssertTrue(ElectronOverlayInjector.shouldReinjectForEvictionProbe("evicted"))
        XCTAssertFalse(ElectronOverlayInjector.shouldReinjectForEvictionProbe("ok"))
        XCTAssertFalse(ElectronOverlayInjector.shouldReinjectForEvictionProbe(""))
        XCTAssertFalse(ElectronOverlayInjector.shouldReinjectForEvictionProbe("err:Something"))
    }

    func testShouldAttemptEvictionReinjectOnlyWhenOpenAndNotReloading() {
        XCTAssertTrue(
            ElectronOverlayInjector.shouldAttemptEvictionReinject(closed: false, pendingReload: false)
        )
        XCTAssertFalse(
            ElectronOverlayInjector.shouldAttemptEvictionReinject(closed: true, pendingReload: false),
            "a closed session must never re-inject"
        )
        XCTAssertFalse(
            ElectronOverlayInjector.shouldAttemptEvictionReinject(closed: false, pendingReload: true),
            "a CSP-bypass reload owns injection, so the eviction re-check must defer to it"
        )
    }

    func testNavigatedWithinDocumentTriggersReinject() {
        XCTAssertTrue(
            ElectronOverlayInjector.shouldReinjectOnNavigationEvent(
                method: "Page.navigatedWithinDocument",
                params: nil
            )
        )
    }

    func testMainFrameFrameNavigatedTriggersReinject() {
        XCTAssertTrue(
            ElectronOverlayInjector.shouldReinjectOnNavigationEvent(
                method: "Page.frameNavigated",
                params: ["frame": ["id": "F1"]]
            ),
            "a main frame nav (no parentId) must drive an eviction re-check"
        )
    }

    func testSubframeFrameNavigatedDoesNotTriggerReinject() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldReinjectOnNavigationEvent(
                method: "Page.frameNavigated",
                params: ["frame": ["id": "F2", "parentId": "F1"]]
            ),
            "subframe navigations never touch the top-level overlay"
        )
    }

    func testUnrelatedEventDoesNotTriggerReinject() {
        XCTAssertFalse(
            ElectronOverlayInjector.shouldReinjectOnNavigationEvent(
                method: "Page.loadEventFired",
                params: nil
            )
        )
    }

    // MARK: - Overlay host removal expression
    //
    // On graceful session teardown we send a small Runtime.evaluate that
    // removes the overlay host so a slicc-server restart against the same
    // Electron app starts with a clean DOM. The expression prefers the
    // overlay's own `remove()` API and falls back to a direct DOM removal.

    func testOverlayHostRemovalExpressionCallsOverlayRemove() {
        let expression = ElectronOverlayInjector.overlayHostRemovalExpression()
        XCTAssertTrue(expression.contains("__SLICC_ELECTRON_OVERLAY__"))
        XCTAssertTrue(expression.contains(".remove"))
    }

    func testOverlayHostRemovalExpressionFallsBackToDOMRemoval() {
        let expression = ElectronOverlayInjector.overlayHostRemovalExpression()
        XCTAssertTrue(
            expression.contains("getElementById('slicc-electron-overlay-root')"),
            "expression must fall back to direct DOM removal so a stale bundle without remove() is still cleaned up"
        )
    }

    // MARK: - Overlay loaded probe expression
    //
    // Regression A (#1085): the probe walked the retired
    // `<slicc-electron-sidebar>` shadow path, always returned 'no-sidebar', and
    // triggered a startup double-reload loop. It must now find the iframe
    // inside the `<slicc-launcher>` open shadow root. Follow-up (#1085): a
    // CSP-blocked subframe swaps to a READABLE `chrome-error://chromewebdata/`
    // (not about:blank, does not throw), so success must hinge on the
    // cross-origin THROW — the ONLY `return 'ok'` lives in the catch; any
    // readable href yields the `'blank:'` diagnostic.

    func testOverlayLoadedProbeExpressionWalksLauncherShadowIframe() {
        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
        XCTAssertTrue(expression.contains("getElementById('slicc-electron-overlay-root')"))
        XCTAssertTrue(expression.contains("host.shadowRoot.querySelector('iframe')"))
    }

    func testOverlayLoadedProbeExpressionDoesNotWalkRetiredSidebar() {
        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
        XCTAssertFalse(
            expression.contains("slicc-electron-sidebar"),
            "probe must not walk the retired <slicc-electron-sidebar> path (Regression A)"
        )
    }

    func testOverlayLoadedProbeExpressionVerifiesNavigation() {
        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
        // Guard states plus the readable-href diagnostic.
        XCTAssertTrue(expression.contains("return 'no-host'"))
        XCTAssertTrue(expression.contains("return 'no-iframe'"))
        XCTAssertTrue(expression.contains("return 'no-src'"))
        XCTAssertTrue(expression.contains("return 'blank:'"))
        XCTAssertTrue(expression.contains("return 'ok'"))
    }

    func testOverlayLoadedProbeExpressionSuccessOnlyInCatch() {
        let expression = ElectronOverlayInjector.overlayLoadedProbeExpression()
        // The cross-origin THROW is the ONLY success signal: exactly one
        // `return 'ok'`, and it must follow the `catch` (a readable href —
        // including a CSP-blocked chrome-error swap — is classified not-loaded).
        let okCount = expression.components(separatedBy: "return 'ok'").count - 1
        XCTAssertEqual(okCount, 1, "the only success return must be the catch branch")
        XCTAssertFalse(
            expression.contains("=== 'about:blank'"),
            "classification must not hinge on about:blank — any readable href is not-loaded"
        )
        if let catchRange = expression.range(of: "catch"),
           let okRange = expression.range(of: "return 'ok'") {
            XCTAssertTrue(
                okRange.lowerBound > catchRange.lowerBound,
                "`return 'ok'` must live inside the catch branch"
            )
        } else {
            XCTFail("expression must contain a catch branch with `return 'ok'`")
        }
    }

    // MARK: - Pure helpers: target filter

    func testShouldInjectElectronOverlayTargetAcceptsHttpsPage() {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "Example",
            url: "https://example.com/",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/1"
        )
        XCTAssertTrue(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsNonPageType() {
        let target = ElectronInspectableTarget(
            type: "service_worker",
            title: nil,
            url: "https://example.com/sw.js",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/1"
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsMissingDebuggerURL() {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "no ws",
            url: "https://example.com/",
            webSocketDebuggerURL: nil
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsEmptyDebuggerURL() {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "empty ws",
            url: "https://example.com/",
            webSocketDebuggerURL: ""
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsEmptyURL() {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "blank",
            url: "   ",
            webSocketDebuggerURL: "ws://x"
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsDevtoolsScheme() {
        let target = ElectronInspectableTarget(
            type: "page",
            title: "dt",
            url: "devtools://devtools/bundled/inspector.html",
            webSocketDebuggerURL: "ws://x"
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(target))
    }

    func testShouldInjectElectronOverlayTargetRejectsChromeAndExtensionSchemes() {
        let chromeTarget = ElectronInspectableTarget(
            type: "page",
            title: "settings",
            url: "chrome://settings/",
            webSocketDebuggerURL: "ws://x"
        )
        let extensionTarget = ElectronInspectableTarget(
            type: "page",
            title: "popup",
            url: "chrome-extension://abc/popup.html",
            webSocketDebuggerURL: "ws://x"
        )
        XCTAssertFalse(shouldInjectElectronOverlayTarget(chromeTarget))
        XCTAssertFalse(shouldInjectElectronOverlayTarget(extensionTarget))
    }

    func testSelectBestOverlayTargetsReturnsEmptyForNoInput() {
        XCTAssertEqual(selectBestOverlayTargets([]), [])
    }

    func testSelectBestOverlayTargetsKeepsSingleInjectableTarget() {
        let only = ElectronInspectableTarget(
            type: "page",
            title: "Solo",
            url: "https://solo.example/",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/solo"
        )
        XCTAssertEqual(
            selectBestOverlayTargets([only]).map(\.webSocketDebuggerURL),
            ["ws://127.0.0.1:9223/devtools/page/solo"]
        )
    }

    func testSelectBestOverlayTargetsDropsNonInjectableTargets() {
        let pageTarget = ElectronInspectableTarget(
            type: "page",
            title: "Real",
            url: "https://example.com/",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/1"
        )
        let serviceWorker = ElectronInspectableTarget(
            type: "service_worker",
            title: nil,
            url: "https://example.com/sw.js",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/2"
        )
        XCTAssertEqual(
            selectBestOverlayTargets([pageTarget, serviceWorker]).map(\.webSocketDebuggerURL),
            ["ws://127.0.0.1:9223/devtools/page/1"]
        )
    }

    // MARK: - ElectronInspectableTarget Codable round-trip

    func testElectronInspectableTargetCodableRoundTrip() throws {
        let original = ElectronInspectableTarget(
            type: "page",
            title: "Example",
            url: "https://example.com/",
            webSocketDebuggerURL: "ws://127.0.0.1:9223/devtools/page/x"
        )
        let encoded = try JSONEncoder().encode(original)
        let decoded = try JSONDecoder().decode(ElectronInspectableTarget.self, from: encoded)
        XCTAssertEqual(decoded, original)
    }

    func testElectronInspectableTargetDecodesWebSocketDebuggerUrlCodingKey() throws {
        // The CodingKey maps webSocketDebuggerURL ↔ webSocketDebuggerUrl in JSON.
        let json = """
        {"type":"page","title":"Hi","url":"https://example.com","webSocketDebuggerUrl":"ws://x/y"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ElectronInspectableTarget.self, from: json)
        XCTAssertEqual(decoded.webSocketDebuggerURL, "ws://x/y")
        XCTAssertEqual(decoded.title, "Hi")
    }

    func testElectronInspectableTargetDecodesMissingOptionalFields() throws {
        let json = """
        {"type":"page","url":"https://example.com"}
        """.data(using: .utf8)!
        let decoded = try JSONDecoder().decode(ElectronInspectableTarget.self, from: json)
        XCTAssertNil(decoded.title)
        XCTAssertNil(decoded.webSocketDebuggerURL)
    }

    // MARK: - Error types: errorDescription coverage

    func testElectronAppAlreadyRunningErrorExposesMessage() {
        let error = ElectronAppAlreadyRunningError(message: "Slack is already running")
        XCTAssertEqual(error.errorDescription, "Slack is already running")
    }

    func testElectronLaunchErrorAppAlreadyRunningDescription() {
        let error = ElectronLaunchError.appAlreadyRunning("App running")
        XCTAssertEqual(error.errorDescription, "App running")
    }

    func testElectronLaunchErrorCDPNotAvailableDescription() {
        let error = ElectronLaunchError.cdpNotAvailable("no cdp")
        XCTAssertEqual(error.errorDescription, "no cdp")
    }

    func testElectronLaunchErrorRemoteDebuggingDisabledDescription() {
        let error = ElectronLaunchError.remotDebuggingDisabled("rdb off")
        XCTAssertEqual(error.errorDescription, "rdb off")
    }

    // MARK: - ElectronResolvedApp minimal shape

    func testElectronResolvedAppIsAppBundleFlag() {
        let bundleURL = URL(fileURLWithPath: "/Applications/Sample.app")
        let executableURL = bundleURL.appendingPathComponent("Contents/MacOS/Sample")
        let resolved = ElectronResolvedApp(
            inputURL: bundleURL,
            bundleURL: bundleURL,
            executableURL: executableURL,
            displayName: "Sample"
        )
        XCTAssertTrue(resolved.isAppBundle)
        XCTAssertEqual(resolved.displayName, "Sample")

        let bareExecutable = URL(fileURLWithPath: "/usr/local/bin/some-bin")
        let bareResolved = ElectronResolvedApp(
            inputURL: bareExecutable,
            bundleURL: nil,
            executableURL: bareExecutable,
            displayName: "some-bin"
        )
        XCTAssertFalse(bareResolved.isAppBundle)
    }

    // MARK: - ElectronLauncher.resolveApp & resolveExecutableURL paths

    func testResolveAppForAppBundleReturnsBundleURL() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Hello.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)
        let executableURL = macOSDirectory.appendingPathComponent("Hello")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        let resolved = try launcher.resolveApp(bundleURL.path)
        XCTAssertNotNil(resolved.bundleURL)
        XCTAssertTrue(resolved.isAppBundle)
        XCTAssertEqual(resolved.displayName, "Hello")
        XCTAssertEqual(resolved.executableURL.lastPathComponent, "Hello")
    }

    func testResolveAppForBareExecutablePathReturnsNilBundle() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let executableURL = tempDirectory.appendingPathComponent("bare-exe")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        let resolved = try launcher.resolveApp(executableURL.path)
        XCTAssertNil(resolved.bundleURL)
        XCTAssertFalse(resolved.isAppBundle)
        XCTAssertEqual(resolved.executableURL.lastPathComponent, "bare-exe")
    }

    func testResolveAppForBareExecutableInsideAppBundleRecoversBundleURL() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Wrap.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)
        let helperURL = macOSDirectory.appendingPathComponent("Wrap Helper")
        FileManager.default.createFile(atPath: helperURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperURL.path)

        let launcher = ElectronLauncher()
        let resolved = try launcher.resolveApp(helperURL.path)
        XCTAssertNotNil(resolved.bundleURL)
        XCTAssertEqual(resolved.bundleURL?.lastPathComponent, "Wrap.app")
        XCTAssertEqual(resolved.displayName, "Wrap")
    }

    func testResolveExecutableURLThrowsWhenBundleHasNoExecutable() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Empty.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        let launcher = ElectronLauncher()
        XCTAssertThrowsError(try launcher.resolveExecutableURL(in: bundleURL))
    }

    func testResolveExecutableURLSkipsHelperBinaries() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("WithHelpers.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)

        // Helpers plus a non-helper binary that does NOT match the bundle's
        // display name — exercises the directory-scan fallback that skips
        // helper/crash/gpu/etc. suffixes and picks the remaining real binary.
        for name in ["Main Helper (Renderer)", "Main Helper (GPU)", "Plugin Tool", "Real"] {
            let helperURL = macOSDirectory.appendingPathComponent(name)
            FileManager.default.createFile(atPath: helperURL.path, contents: Data())
            try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: helperURL.path)
        }

        let launcher = ElectronLauncher()
        let executable = try launcher.resolveExecutableURL(in: bundleURL)
        XCTAssertEqual(executable.lastPathComponent, "Real")
    }

    // MARK: - findRunningInstances / terminateRunningApp safety paths

    func testFindRunningInstancesReturnsEmptyForFakeBundle() throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("Unlikely.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)
        let executableURL = macOSDirectory.appendingPathComponent("Unlikely")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        let running = try launcher.findRunningInstances(appPath: bundleURL.path)
        XCTAssertTrue(running.isEmpty)
    }

    func testTerminateRunningAppIsNoOpWhenNothingMatches() async throws {
        let tempDirectory = try makeTempDirectory()
        defer { try? FileManager.default.removeItem(at: tempDirectory) }

        let bundleURL = tempDirectory.appendingPathComponent("AlsoUnlikely.app")
        let macOSDirectory = bundleURL.appendingPathComponent("Contents/MacOS", isDirectory: true)
        try FileManager.default.createDirectory(at: macOSDirectory, withIntermediateDirectories: true)
        let executableURL = macOSDirectory.appendingPathComponent("AlsoUnlikely")
        FileManager.default.createFile(atPath: executableURL.path, contents: Data())
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executableURL.path)

        let launcher = ElectronLauncher()
        try await launcher.terminateRunningApp(appPath: bundleURL.path)
    }

    // MARK: - ElectronOverlayInjector init + start + stop lifecycle

    func testElectronOverlayInjectorStartStopDoesNotCrash() async {
        let injector = ElectronOverlayInjector(
            cdpPort: 0,
            servePort: 0,
            projectRoot: FileManager.default.temporaryDirectory,
            probeDelayNanoseconds: 1_000_000,
            thinBridge: Self.thinBridge
        )
        // First call wires up the polling task; the second hits the
        // alreadyRunning guard.
        injector.start()
        injector.start()
        XCTAssertTrue(injector._testing_bypassedURLs().isEmpty)
        injector.stop()
        // Idempotent stop: subsequent calls must remain safe.
        injector.stop()
    }

    func testElectronOverlayInjectorRunsAtLeastOnePollCycleAgainstClosedPort() async {
        // cdpPort 1 will refuse the /json connection — the polling loop must
        // catch the error and continue, then cleanly shut down on stop().
        let injector = ElectronOverlayInjector(
            cdpPort: 1,
            servePort: 5711,
            projectRoot: FileManager.default.temporaryDirectory,
            probeDelayNanoseconds: 1_000_000,
            thinBridge: Self.thinBridge
        )
        injector.start()
        try? await Task.sleep(nanoseconds: 50_000_000)
        injector.stop()
        XCTAssertTrue(injector._testing_bypassedURLs().isEmpty)
    }

    // MARK: - Bootstrap script content + escaping

    func testBootstrapScriptIncludesBundleSourceAndInjectionCall() {
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "/* MARKER_BUNDLE_42 */",
            appURL: "http://localhost:5711/electron"
        )
        XCTAssertTrue(script.contains("/* MARKER_BUNDLE_42 */"))
        XCTAssertTrue(script.contains("window.__SLICC_ELECTRON_OVERLAY__"))
        XCTAssertTrue(script.contains("DOMContentLoaded"))
    }

    func testBootstrapScriptEscapesBackslashesInAppURL() {
        let script = buildElectronOverlayBootstrapScript(
            bundleSource: "",
            appURL: "http://example.com/back\\slash"
        )
        XCTAssertTrue(script.contains("back\\\\slash"))
    }

    // MARK: - OverlayTargetSession gracefulShutdown on already-closed session

    func testGracefulShutdownOnClosedSessionIsNoOp() async {
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
        await session.gracefulShutdown()
        XCTAssertEqual(session._testing_pendingWaiterCount(), 0)
    }

    // MARK: - Path B: thin-bridge launch URL + leader/follower election

    private static let thinBridge = ThinBridgeConfig(
        hostedLeaderOrigin: "https://www.sliccy.ai",
        bridgeWsUrl: "ws://localhost:5710/cdp",
        bridgeToken: "aabbccdd-1122-3344-5566-778899aabbcc"
    )

    func testBuildThinOverlayAppURLEmbedsBridgeAndLeaderRole() throws {
        let url = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: Self.thinBridge, role: .leader)
        )
        let components = try XCTUnwrap(URLComponents(string: url))
        XCTAssertEqual(components.scheme, "https")
        XCTAssertEqual(components.host, "www.sliccy.ai")
        XCTAssertEqual(components.path, "/electron")
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items[BridgeSecurity.wsQueryParam], Self.thinBridge.bridgeWsUrl)
        XCTAssertEqual(items[BridgeSecurity.tokenQueryParam], Self.thinBridge.bridgeToken)
        XCTAssertEqual(items[bridgeRoleQueryParam], bridgeRoleLeader)
        XCTAssertNil(items["tab"])
    }

    func testBuildThinOverlayAppURLEmitsFollowerRoleForAutoFollowTabs() throws {
        let url = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: Self.thinBridge, role: .follower)
        )
        let components = try XCTUnwrap(URLComponents(string: url))
        let items = Dictionary(uniqueKeysWithValues: (components.queryItems ?? []).map { ($0.name, $0.value ?? "") })
        XCTAssertEqual(items[bridgeRoleQueryParam], bridgeRoleFollower)
    }

    func testBuildThinOverlayAppURLEmitsTabOverrideOnlyWhenNonDefault() throws {
        let chatURL = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: Self.thinBridge, role: .leader, activeTab: "chat")
        )
        let chatItems = Dictionary(uniqueKeysWithValues:
            (URLComponents(string: chatURL)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }
        )
        XCTAssertNil(chatItems["tab"])

        let memoryURL = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: Self.thinBridge, role: .leader, activeTab: "memory")
        )
        let memoryItems = Dictionary(uniqueKeysWithValues:
            (URLComponents(string: memoryURL)?.queryItems ?? []).map { ($0.name, $0.value ?? "") }
        )
        XCTAssertEqual(memoryItems["tab"], "memory")
    }

    func testBuildThinOverlayAppURLHonorsCustomHostedOrigin() throws {
        let custom = ThinBridgeConfig(
            hostedLeaderOrigin: "https://slicc-tray-hub-staging.minivelos.workers.dev",
            bridgeWsUrl: Self.thinBridge.bridgeWsUrl,
            bridgeToken: Self.thinBridge.bridgeToken
        )
        let url = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: custom, role: .leader)
        )
        let components = try XCTUnwrap(URLComponents(string: url))
        XCTAssertEqual(components.host, "slicc-tray-hub-staging.minivelos.workers.dev")
        XCTAssertEqual(components.path, "/electron")
    }

    func testBuildThinOverlayAppURLStripsTrailingSlashInHostedOrigin() throws {
        let custom = ThinBridgeConfig(
            hostedLeaderOrigin: "https://example.com/",
            bridgeWsUrl: Self.thinBridge.bridgeWsUrl,
            bridgeToken: Self.thinBridge.bridgeToken
        )
        let url = buildThinOverlayAppURL(
            options: ThinOverlayURLOptions(config: custom, role: .leader)
        )
        let components = try XCTUnwrap(URLComponents(string: url))
        XCTAssertEqual(components.path, "/electron")
        XCTAssertEqual(components.host, "example.com")
    }

    func testResolveHostedLeaderOriginDefaultsToProductionSliccy() {
        XCTAssertEqual(resolveHostedLeaderOrigin(environment: [:]), "https://www.sliccy.ai")
    }

    func testResolveHostedLeaderOriginPrefersExplicitOverWorkerBase() {
        let result = resolveHostedLeaderOrigin(environment: [
            "SLICC_HOSTED_LEADER_ORIGIN": "https://primary.example",
            "WORKER_BASE_URL": "https://fallback.example"
        ])
        XCTAssertEqual(result, "https://primary.example")
    }

    func testResolveHostedLeaderOriginFallsBackToWorkerBase() {
        let result = resolveHostedLeaderOrigin(environment: [
            "WORKER_BASE_URL": "https://staging.example"
        ])
        XCTAssertEqual(result, "https://staging.example")
    }

    func testResolveHostedLeaderOriginStripsTrailingSlashes() {
        let result = resolveHostedLeaderOrigin(environment: [
            "SLICC_HOSTED_LEADER_ORIGIN": "https://example.com///"
        ])
        XCTAssertEqual(result, "https://example.com")
    }

    // MARK: - ElectronOverlayInjector thin-mode leader/follower election

    private static let leaderMark = "LEADER_BOOTSTRAP_MARKER"
    private static let followerMark = "FOLLOWER_BOOTSTRAP_MARKER"

    private func makeThinInjector() -> ElectronOverlayInjector {
        ElectronOverlayInjector(
            _testingServePort: 5711,
            thinBootstraps: ThinBootstrapSet(leader: Self.leaderMark, follower: Self.followerMark),
            probeDelayNanoseconds: 1_000_000
        )
    }

    private func thinTarget(url: String, debuggerURL: String = "ws://127.0.0.1:9999/devtools/page/x") -> ElectronInspectableTarget {
        ElectronInspectableTarget(type: "page", title: nil, url: url, webSocketDebuggerURL: debuggerURL)
    }

    func testThinModePinsFirstTargetAsLeaderAndElectsSubsequentAsFollower() throws {
        let injector = makeThinInjector()
        XCTAssertNil(injector._testing_leaderTargetURL())

        let leader = thinTarget(url: "https://app.slack.com/")
        let follower = thinTarget(url: "https://teams.microsoft.com/", debuggerURL: "ws://127.0.0.1:9999/devtools/page/y")

        let bootstraps = try injector.loadBootstrapScripts()
        let leaderScript = injector.resolveBootstrapForTarget(leader, bootstraps: bootstraps)
        XCTAssertEqual(leaderScript, Self.leaderMark)
        XCTAssertEqual(injector._testing_leaderTargetURL(), leader.url)

        let followerScript = injector.resolveBootstrapForTarget(follower, bootstraps: bootstraps)
        XCTAssertEqual(followerScript, Self.followerMark)
        // Original leader must stay pinned even after second election.
        XCTAssertEqual(injector._testing_leaderTargetURL(), leader.url)
    }

    func testThinModeKeepsSameTargetAsLeaderAcrossReconnects() throws {
        let injector = makeThinInjector()
        let target = thinTarget(url: "https://app.slack.com/")

        let bootstraps = try injector.loadBootstrapScripts()
        let first = injector.resolveBootstrapForTarget(target, bootstraps: bootstraps)
        XCTAssertEqual(first, Self.leaderMark)

        // Same target URL re-resolved → still leader (idempotent election).
        let second = injector.resolveBootstrapForTarget(target, bootstraps: bootstraps)
        XCTAssertEqual(second, Self.leaderMark)
        XCTAssertEqual(injector._testing_leaderTargetURL(), target.url)
    }

    func testSeededLeaderForcesUnknownTargetToFollower() throws {
        let injector = makeThinInjector()
        injector._testing_seedLeaderTargetURL("https://leader.example/")
        XCTAssertEqual(injector._testing_leaderTargetURL(), "https://leader.example/")

        let other = thinTarget(url: "https://other.example/")
        let bootstraps = try injector.loadBootstrapScripts()
        let script = injector.resolveBootstrapForTarget(other, bootstraps: bootstraps)
        XCTAssertEqual(script, Self.followerMark)
        // Seeded leader stays pinned.
        XCTAssertEqual(injector._testing_leaderTargetURL(), "https://leader.example/")
    }

    func testLoadBootstrapScriptsProducesLeaderFollowerPairInThinMode() throws {
        let injector = ElectronOverlayInjector(
            cdpPort: 0,
            servePort: 5711,
            projectRoot: FileManager.default.temporaryDirectory,
            probeDelayNanoseconds: 1_000_000,
            thinBridge: Self.thinBridge
        )
        let bootstraps = try injector.loadBootstrapScripts()

        // Both variants embed the inline fallback bundle source (no
        // dist/ui in the temp project root) and the role-tagged URL.
        XCTAssertTrue(bootstraps.leader.contains("role=leader"))
        XCTAssertTrue(bootstraps.follower.contains("role=follower"))
        XCTAssertTrue(bootstraps.leader.contains(Self.thinBridge.bridgeToken))
        XCTAssertTrue(bootstraps.follower.contains(Self.thinBridge.bridgeToken))
    }

    /// Regression: the overlay bootstrap must ALWAYS point the iframe at the
    /// hosted-leader thin-bridge origin, never the retired bundled-UI URL
    /// (`http://localhost:<servePort>/electron`). Guards the Path A removal.
    func testLoadBootstrapScriptsNeverEmitsBundledServePortURL() throws {
        let injector = ElectronOverlayInjector(
            cdpPort: 0,
            servePort: 5711,
            projectRoot: FileManager.default.temporaryDirectory,
            probeDelayNanoseconds: 1_000_000,
            thinBridge: Self.thinBridge
        )
        let bootstraps = try injector.loadBootstrapScripts()
        for script in [bootstraps.leader, bootstraps.follower] {
            XCTAssertFalse(
                script.contains("localhost:5711/electron"),
                "overlay must never load the retired bundled-UI URL from the serve port"
            )
            XCTAssertTrue(
                script.contains(Self.thinBridge.hostedLeaderOrigin),
                "overlay must load from the hosted-leader thin-bridge origin"
            )
        }
    }

    // MARK: - Test helpers

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
