import XCTest

@testable import slicc_server

/// Egress-block detection for locked-down Electron apps (Signal parity with
/// node-server's `electron-controller.test.ts`). Signal denies the overlay's
/// document request at the network layer (`net::ERR_ACCESS_DENIED`) beneath the
/// layer `Page.setBypassCSP` / the Fetch proxy operate at, so the injector must
/// detect it from `Network.loadingFailed` and skip the doomed escalation.
final class ElectronOverlayEgressTests: XCTestCase {

    func testIsEgressBlockErrorMatchesAppLayerDenials() {
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_ACCESS_DENIED"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_NETWORK_ACCESS_DENIED"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_BLOCKED_BY_CLIENT"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_BLOCKED_BY_ADMINISTRATOR"))
        // A CSP block IS rescuable by setBypassCSP; transient/DNS failures aren't
        // egress blocks either.
        XCTAssertFalse(ElectronOverlayInjector.isEgressBlockError("net::ERR_BLOCKED_BY_CSP"))
        XCTAssertFalse(ElectronOverlayInjector.isEgressBlockError("net::ERR_NAME_NOT_RESOLVED"))
        XCTAssertFalse(ElectronOverlayInjector.isEgressBlockError("net::ERR_ABORTED"))
        XCTAssertFalse(ElectronOverlayInjector.isEgressBlockError(nil))
    }

    func testClassifyNetworkEventTracksOverlayDocumentRequestByToken() {
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.requestWillBeSent",
            params: [
                "requestId": "req-1",
                "type": "Document",
                "request": ["url": "https://www.sliccy.ai/electron?bridgeToken=tok-9&role=leader"],
            ],
            bridgeToken: "tok-9",
            overlayRequestIDs: []
        )
        XCTAssertEqual(signal, .trackOverlayRequest("req-1"))
    }

    func testClassifyNetworkEventIgnoresRequestWithoutOurToken() {
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.requestWillBeSent",
            params: [
                "requestId": "other",
                "type": "Document",
                "request": ["url": "https://example.com/x"],
            ],
            bridgeToken: "tok-9",
            overlayRequestIDs: []
        )
        XCTAssertEqual(signal, .ignore)
    }

    func testClassifyNetworkEventIgnoresNonDocumentRequest() {
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.requestWillBeSent",
            params: [
                "requestId": "r",
                "type": "XHR",
                "request": ["url": "https://www.sliccy.ai/electron?bridgeToken=tok-9"],
            ],
            bridgeToken: "tok-9",
            overlayRequestIDs: []
        )
        XCTAssertEqual(signal, .ignore)
    }

    func testClassifyNetworkEventFlagsEgressBlockOnTrackedFailure() {
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.loadingFailed",
            params: ["requestId": "req-1", "type": "Document", "errorText": "net::ERR_ACCESS_DENIED"],
            bridgeToken: "tok-9",
            overlayRequestIDs: ["req-1"]
        )
        XCTAssertEqual(signal, .egressBlocked)
    }

    func testClassifyNetworkEventIgnoresFailureOnUntrackedRequest() {
        // A network failure on a request we never tracked (the app's own frame)
        // must not flip the target to egress-blocked.
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.loadingFailed",
            params: ["requestId": "req-2", "type": "Document", "errorText": "net::ERR_ACCESS_DENIED"],
            bridgeToken: "tok-9",
            overlayRequestIDs: ["req-1"]
        )
        XCTAssertEqual(signal, .ignore)
    }

    func testClassifyNetworkEventIgnoresNonEgressFailure() {
        let signal = ElectronOverlayInjector.classifyNetworkEvent(
            method: "Network.loadingFailed",
            params: ["requestId": "req-1", "type": "Document", "errorText": "net::ERR_ABORTED"],
            bridgeToken: "tok-9",
            overlayRequestIDs: ["req-1"]
        )
        XCTAssertEqual(signal, .ignore)
    }

    func testEgressBlockedURLSeedingIsObservable() {
        let injector = ElectronOverlayInjector(_testingServePort: 0, cdpPort: 0)
        XCTAssertTrue(injector._testing_egressBlockedURLs().isEmpty)
        let url = "file:///Applications/Signal.app/Contents/Resources/app.asar/background.html"
        injector._testing_seedEgressBlockedURL(url)
        XCTAssertEqual(injector._testing_egressBlockedURLs(), [url])
        injector._testing_seedEgressBlockedURL(url)
        XCTAssertEqual(injector._testing_egressBlockedURLs(), [url])
    }
}
