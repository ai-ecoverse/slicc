import Foundation
import WidgetKit
import XCTest

@testable import SliccWidgetKit

final class WidgetHostTests: XCTestCase {
    /// The groups are load-bearing: get one wrong and the widget silently
    /// renders the empty state forever, because a missing container and an
    /// unwritten snapshot look identical from inside the extension.
    func testHostsUseTheGroupsTheirEntitlementsDeclare() {
        XCTAssertEqual(WidgetHost.follower.appGroup, "group.ai.sliccy.follower")
        XCTAssertEqual(WidgetHost.sliccstart.appGroup, "S8LB56P782.com.slicc.sliccstart.fileprovider")
    }

    func testTapRoutesCarryTheUnitAndNothingElse() {
        let unit = WidgetUnit(id: "jid-1", name: "A", role: .cone)
        XCTAssertEqual(
            WidgetHost.follower.url(forUnit: unit)?.absoluteString, "slicc://unit?jid=jid-1")
        XCTAssertNil(
            WidgetHost.sliccstart.url(forUnit: unit),
            "Sliccstart has no unit route yet — a tap opens the app")
    }

    func testJidsThatNeedEscapingSurviveTheRoute() {
        let unit = WidgetUnit(id: "a b&c", name: "A", role: .scoop)
        let url = try? XCTUnwrap(WidgetHost.follower.url(forUnit: unit))
        XCTAssertEqual(
            URLComponents(url: url!, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "jid" })?.value,
            "a b&c")
    }
}

/// The provider's only real decision: what to draw when there is no snapshot.
final class UnitsTimelineProviderTests: XCTestCase {
    func testAnUnwritableGroupFallsBackRatherThanFailing() {
        let provider = UnitsTimelineProvider(
            host: WidgetHost(appName: "T", appGroup: "group.absent", urlScheme: nil),
            clock: { WidgetSnapshot.fixtureCaptureDate })
        let snapshot = provider.currentSnapshot()
        #if SLICC_WIDGET_DESIGN_FIXTURES
            XCTAssertFalse(snapshot.isUnavailable, "design builds draw the fixtures")
        #else
            XCTAssertTrue(
                snapshot.isUnavailable,
                "with no capture side wired, the honest answer is the empty state")
        #endif
    }

    /// A quarter-hour, not a minute: the refresh only ages the staleness line,
    /// and WidgetKit's daily budget is small enough that spending it here is
    /// how a widget ends up frozen at the moment it mattered.
    func testTheHeartbeatIsSlowOnPurpose() {
        XCTAssertEqual(UnitsTimelineProvider.heartbeat, 15 * 60)
        XCTAssertEqual(UnitsTimelineProvider.heartbeat, WidgetSnapshot.stalenessHorizon)
    }

    func testTheLockScreenFamiliesAreIOSOnly() {
        XCTAssertEqual(UnitsWidget.macFamilies.count, 3)
        #if os(iOS)
            XCTAssertEqual(UnitsWidget.iOSFamilies.count, 6)
        #else
            XCTAssertEqual(UnitsWidget.iOSFamilies, UnitsWidget.macFamilies)
        #endif
    }
}
