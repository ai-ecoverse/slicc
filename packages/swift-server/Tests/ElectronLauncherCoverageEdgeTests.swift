import XCTest

@testable import slicc_server

final class ElectronLauncherCoverageEdgeTests: XCTestCase {
    func testTargetScoreTreatsMissingTitleAsEmpty() {
        XCTAssertEqual(
            scoreOverlayTarget(
                ElectronInspectableTarget(
                    type: "page",
                    title: nil,
                    url: "https://example.test/",
                    webSocketDebuggerURL: "ws://example.test/page"
                )),
            0
        )
    }

    func testPollOverlayLoadedSupportsZeroInterval() async {
        let loaded = await ElectronOverlayInjector.pollOverlayLoaded(
            budgetNanoseconds: 1,
            intervalNanoseconds: 0,
            probe: { false }
        )
        XCTAssertFalse(loaded)
    }

    func testTargetSelectionGroupsExplicitPortsIndependently() {
        let first = ElectronInspectableTarget(
            type: "page",
            title: "One",
            url: "https://example.com:8443/one",
            webSocketDebuggerURL: "ws://one"
        )
        let second = ElectronInspectableTarget(
            type: "page",
            title: "Two",
            url: "https://example.com:9443/two",
            webSocketDebuggerURL: "ws://two"
        )
        XCTAssertEqual(selectBestOverlayTargets([first, second]), [first, second])
    }

    func testThinOverlayURLFallsBackForMalformedOrigin() {
        let malformed = ThinBridgeConfig(
            hostedLeaderOrigin: "http://[",
            bridgeWsUrl: "ws://localhost:5710/cdp",
            bridgeToken: "token"
        )
        XCTAssertEqual(
            buildThinOverlayAppURL(options: .init(config: malformed, role: .leader)),
            "http://[/electron"
        )

        let missingConfig = ElectronOverlayInjector(
            _testingServePort: 5711,
            thinBootstraps: nil
        )
        XCTAssertThrowsError(try missingConfig.loadBootstrapScripts()) { error in
            guard case ElectronLaunchError.overlayConfigUnresolved = error else {
                return XCTFail("unexpected error: \(error)")
            }
        }
    }
}
