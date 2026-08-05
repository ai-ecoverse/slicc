import XCTest

@testable import SliccFollower

/// User-initiated tab opening must not depend on the CDP bridge the
/// data-channel handshake creates: the browser surface's "Open new tab"
/// affordance renders in every connection state (#1916), and before the
/// bridge became lazy the tap silently did nothing until the first
/// `dataChannelOpened`.
final class CdpOpenTabTests: XCTestCase {

    @MainActor
    func testOpenTabWithoutConnectionCreatesLiveLocalTarget() async {
        let state = AppState()
        XCTAssertTrue(state.cdpTargets.isEmpty)

        let id = state.cdpOpenTab(url: "about:blank")

        // The target-list refresh hops through a MainActor task.
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(
            state.cdpTargets.map(\.id), [id],
            "the returned id names the created target, so the UI can select it")
        XCTAssertNotNil(
            state.cdpWebView(for: id),
            "the target is backed by a live WKWebView, not just a registry row")
    }

    @MainActor
    func testCloseTabWithoutConnectionRemovesTarget() async {
        let state = AppState()
        let id = state.cdpOpenTab(url: "about:blank")
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }

        state.cdpCloseTab(id)

        for _ in 0..<20 where !state.cdpTargets.isEmpty {
            await Task.yield()
        }
        XCTAssertTrue(state.cdpTargets.isEmpty)
        XCTAssertNil(state.cdpWebView(for: id))
    }

    @MainActor
    func testClosingViewedTabFallsBackToOverview() async {
        let state = AppState()
        let id = state.cdpOpenTab(url: "about:blank")
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }
        state.browserViewingTabId = id

        state.cdpCloseTab(id)

        for _ in 0..<20 where state.browserViewingTabId != nil {
            await Task.yield()
        }
        XCTAssertNil(
            state.browserViewingTabId,
            "a dead target must not be presented full screen — the surface falls back to the overview")
    }

    @MainActor
    func testNavigateKeepsTargetAlive() async {
        let state = AppState()
        let id = state.cdpOpenTab(url: "about:blank")
        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }

        state.cdpNavigate(id, to: "about:blank")

        for _ in 0..<20 where state.cdpTargets.isEmpty {
            await Task.yield()
        }
        XCTAssertEqual(state.cdpTargets.map(\.id), [id])
        XCTAssertNotNil(state.cdpWebView(for: id))
    }
}
