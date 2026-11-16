import AppKit
import SwiftUI
import XCTest

@testable import Sliccstart

@MainActor
final class SliccyOfferTests: XCTestCase {
    private var defaults: UserDefaults!
    private var suiteName: String!

    override func setUp() async throws {
        suiteName = "sliccstart.tests.sliccy-offer.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suiteName)!
    }

    override func tearDown() async throws {
        defaults.removePersistentDomain(forName: suiteName)
    }

    private func offer(
        major: Int = 27,
        silicon: Bool = true,
        open: @escaping (URL) -> Bool = { _ in
            XCTFail("must not open a page implicitly")
            return false
        }
    ) -> SliccyOffer {
        SliccyOffer(
            defaults: defaults,
            osVersion: OperatingSystemVersion(majorVersion: major, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: silicon,
            openURL: open
        )
    }

    func testEligibilityRequiresBothSupportedOSAndHardware() {
        for major in [14, 26, 27, 28] {
            for silicon in [false, true] {
                let subject = offer(major: major, silicon: silicon)
                XCTAssertEqual(subject.isSupported, major >= 27 && silicon)
                XCTAssertEqual(subject.shouldShowBanner, subject.isSupported)
            }
        }
    }

    func testDismissalSurvivesRelaunchAndOnlyExplicitOptInRestoresOffer() {
        defaults.set("/Applications/Existing Browser.app", forKey: autoLaunchAppIdKey)
        let subject = offer()
        subject.setDismissed(true)
        XCTAssertFalse(subject.shouldShowBanner)
        let relaunched = offer()
        XCTAssertTrue(relaunched.isDismissed)
        XCTAssertFalse(relaunched.shouldShowBanner)
        relaunched.setDismissed(false)
        XCTAssertTrue(offer().shouldShowBanner)
        XCTAssertFalse(offer(major: 26).shouldShowBanner)
        XCTAssertEqual(defaults.string(forKey: autoLaunchAppIdKey), "/Applications/Existing Browser.app")
    }

    func testExplicitActionOpensOnlyTrustedLatestReleasePage() {
        var opened: [URL] = []
        let subject = offer {
            opened.append($0)
            return true
        }
        XCTAssertTrue(opened.isEmpty)
        subject.openReleases()
        XCTAssertEqual(opened.map(\.absoluteString), ["https://github.com/ai-ecoverse/sliccy-app/releases/latest"])
        XCTAssertFalse(subject.openFailed)
        XCTAssertFalse(subject.isDismissed)
        subject.setDismissed(true)
        subject.openReleases()  // The Settings action still works after dismissal.
        XCTAssertEqual(opened.count, 2)
    }

    func testUnsupportedMachinesCannotOpenDownloadAction() {
        offer(major: 26).openReleases()
        offer(silicon: false).openReleases()
    }

    func testFailedOpenCanBeRetriedWithoutChangingDismissal() {
        var succeeds = false
        let subject = offer { _ in succeeds }
        subject.openReleases()
        XCTAssertTrue(subject.openFailed)
        succeeds = true
        subject.openReleases()
        XCTAssertFalse(subject.openFailed)
        XCTAssertFalse(subject.isDismissed)
    }

    func testBannerDisappearsWhenDismissedOrUnsupported() {
        let visible = offer()
        let dismissed = offer()
        dismissed.setDismissed(true)
        ViewHosting.assertRendersDifferently(
            SliccyOfferBanner(offer: visible), SliccyOfferBanner(offer: dismissed),
            width: 340, height: 140
        )
        XCTAssertEqual(
            ViewHosting.digest(of: SliccyOfferBanner(offer: dismissed), width: 340, height: 140),
            ViewHosting.digest(of: SliccyOfferBanner(offer: offer(major: 26)), width: 340, height: 140)
        )
    }

    func testDetailsExplainUnsupportedMacAndBrowserOpenFailure() {
        ViewHosting.assertRendersDifferently(
            SliccyOfferView(offer: offer()), SliccyOfferView(offer: offer(silicon: false)),
            width: 420, height: 520
        )
        let failed = offer(open: { _ in false })
        failed.openReleases()
        ViewHosting.assertRendersDifferently(
            SliccyOfferView(offer: offer()), SliccyOfferView(offer: failed),
            width: 420, height: 520
        )
    }
}
