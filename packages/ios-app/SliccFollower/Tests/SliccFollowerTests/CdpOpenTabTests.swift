import XCTest

@testable import SliccFollower

/// User-initiated tab opening must not depend on the CDP bridge the
/// data-channel handshake creates: the browser surface's "Open new tab…"
/// affordance renders in every connection state (#1916), and before the
/// bridge became lazy the tap silently did nothing until the first
/// `dataChannelOpened`.
final class CdpOpenTabTests: XCTestCase {

    @MainActor
    func testOpenTabWithoutConnectionCreatesLiveLocalTarget() async {
        let state = AppState()
        XCTAssertTrue(state.cdpTargets.isEmpty)

        state.cdpOpenTab(url: "about:blank")

        // The target-list refresh hops through a MainActor task.
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(state.cdpTargets.count, 1)
        guard let target = state.cdpTargets.first else {
            return XCTFail("expected a local target")
        }
        XCTAssertNotNil(
            state.cdpWebView(for: target.id),
            "the target is backed by a live WKWebView, not just a registry row")
    }

    @MainActor
    func testCloseTabWithoutConnectionRemovesTarget() async {
        let state = AppState()
        state.cdpOpenTab(url: "about:blank")
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }
        guard let target = state.cdpTargets.first else {
            return XCTFail("expected a local target to close")
        }

        state.cdpCloseTab(target.id)

        for _ in 0..<20 where !state.cdpTargets.isEmpty {
            await Task.yield()
        }
        XCTAssertTrue(state.cdpTargets.isEmpty)
        XCTAssertNil(state.cdpWebView(for: target.id))
    }
}
