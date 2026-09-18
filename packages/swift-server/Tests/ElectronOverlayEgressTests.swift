import XCTest

@testable import slicc_server






final class ElectronOverlayEgressTests: XCTestCase {

    func testIsEgressBlockErrorMatchesAppLayerDenials() {
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_ACCESS_DENIED"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_NETWORK_ACCESS_DENIED"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_BLOCKED_BY_CLIENT"))
        XCTAssertTrue(ElectronOverlayInjector.isEgressBlockError("net::ERR_BLOCKED_BY_ADMINISTRATOR"))
        
        
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

    func testStatusBootstrapEmbedsEmptyAppUrlAndMessage() {
        let script = buildElectronOverlayStatusBootstrapScript(
            bundleSource: "/* bundle */",
            statusMessage: "This app blocks the panel."
        )
        XCTAssertTrue(script.contains("/* bundle */"))
        
        XCTAssertTrue(script.contains("appUrl:\"\""))
        XCTAssertTrue(script.contains("statusMessage:\"This app blocks the panel.\""))
        
        XCTAssertTrue(script.contains("window.top!==window.self"))
    }

    func testStatusBootstrapEscapesQuotesInMessage() {
        let script = buildElectronOverlayStatusBootstrapScript(
            bundleSource: "",
            statusMessage: "quote \" and backslash \\"
        )
        XCTAssertTrue(script.contains("statusMessage:\"quote \\\" and backslash \\\\\""))
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
