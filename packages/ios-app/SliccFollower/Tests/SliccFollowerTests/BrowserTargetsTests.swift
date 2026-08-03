import XCTest

@testable import SliccFollower

/// Which federated tabs reach the browser surface. The leader enumerates its
/// whole browser, so its own SLICC page arrives in the registry like any
/// other tab — listing it invites the user to "browse" the app they are
/// already attached to.
final class BrowserTargetsTests: XCTestCase {

    private func target(
        _ id: String, runtime: String = "leader", url: String
    ) -> TrayTargetEntry {
        TrayTargetEntry(
            targetId: "\(runtime):\(id)", localTargetId: id, runtimeId: runtime,
            title: id, url: url, isLocal: false)
    }

    private let joinUrl = "https://www.sliccy.ai/?ws=wss%3A%2F%2Fhub#tray=abc123"

    func testDropsOurOwnAdvertisedTargets() {
        let targets = [
            target("mine", runtime: "ios-me", url: "https://example.com/a"),
            target("theirs", url: "https://example.com/b"),
        ]
        let visible = BrowserTargets.visible(targets, ownRuntimeId: "ios-me", joinUrl: joinUrl)
        XCTAssertEqual(
            visible.map(\.localTargetId), ["theirs"],
            "our own tabs are the live local carousel, not preview cards")
    }

    func testDropsTheLeadersOwnSliccPage() {
        let targets = [
            target("app", url: joinUrl),
            target("docs", url: "https://www.sliccy.ai/docs/architecture"),
        ]
        let visible = BrowserTargets.visible(targets, ownRuntimeId: "ios-me", joinUrl: joinUrl)
        XCTAssertEqual(
            visible.map(\.localTargetId), ["docs"],
            "the app page goes; a real page on the same host stays")
    }

    func testSessionQueryAndFragmentDoNotDefeatTheMatch() {
        // The leader's own tab has advanced its `#tray=` fragment since the
        // follower dialed; scheme+host+path still identify it.
        XCTAssertTrue(
            BrowserTargets.isSliccAppPage(
                "https://www.sliccy.ai/?ws=wss%3A%2F%2Fother#tray=zzz", joinUrl: joinUrl))
        XCTAssertTrue(
            BrowserTargets.isSliccAppPage("https://www.sliccy.ai/index.html", joinUrl: joinUrl))
        XCTAssertTrue(
            BrowserTargets.isSliccAppPage("https://WWW.Sliccy.AI/", joinUrl: joinUrl))
    }

    func testLocalLeaderIsMatchedThroughTheJoinUrlNotAHardcodedHost() {
        let localJoin = "http://localhost:5710/?ws=ws%3A%2F%2Flocalhost%3A5710"
        XCTAssertTrue(
            BrowserTargets.isSliccAppPage("http://localhost:5710/", joinUrl: localJoin),
            "a CLI float's leader page is the app page too")
        XCTAssertFalse(
            BrowserTargets.isSliccAppPage("http://localhost:5710/preview/index.html", joinUrl: localJoin),
            "a served preview on the same origin is a real page")
    }

    func testHostedAppShellIsDroppedEvenWithoutAJoinUrl() {
        XCTAssertTrue(BrowserTargets.isSliccAppPage("https://sliccy.ai/", joinUrl: ""))
        XCTAssertFalse(
            BrowserTargets.isSliccAppPage("https://sliccy.ai/cloud", joinUrl: ""),
            "the dashboard is a page you may legitimately want to see")
    }

    func testNonHttpTargetsAreNeverMistakenForTheApp() {
        for url in ["about:blank", "", "data:text/html,<p>hi</p>"] {
            XCTAssertFalse(BrowserTargets.isSliccAppPage(url, joinUrl: joinUrl), url)
        }
    }
}
