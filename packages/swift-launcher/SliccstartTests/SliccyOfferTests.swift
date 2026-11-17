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
        major: Int = 26,
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
        for major in [14, 25, 26, 27, 28] {
            for silicon in [false, true] {
                let subject = offer(major: major, silicon: silicon)
                XCTAssertEqual(subject.isSupported, major >= 26 && silicon)
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
        XCTAssertFalse(offer(major: 25).shouldShowBanner)
        XCTAssertEqual(defaults.string(forKey: autoLaunchAppIdKey), "/Applications/Existing Browser.app")
    }

    func testExplicitActionOpensOnlySelectedReleaseNotes() {
        var opened: [URL] = []
        let subject = offer {
            opened.append($0)
            return true
        }
        XCTAssertTrue(opened.isEmpty)
        subject.openReleases()
        XCTAssertEqual(opened.map(\.absoluteString), ["https://github.com/ai-ecoverse/sliccy-app/releases/tag/v7.3.0"])
        XCTAssertFalse(subject.openFailed)
        XCTAssertFalse(subject.isDismissed)
        subject.setDismissed(true)
        subject.openReleases()  // The Settings action still works after dismissal.
        XCTAssertEqual(opened.count, 2)
    }

    func testUnsupportedMachinesCannotOpenDownloadAction() {
        offer(major: 25).openReleases()
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
            ViewHosting.digest(of: SliccyOfferBanner(offer: offer(major: 25)), width: 340, height: 140)
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
    func testExplicitInstallationDoesNotOpenAppAndDismissesOnlyAfterSuccess() async {
        var opened: [URL] = []
        let destination = URL(fileURLWithPath: "/tmp/test-only/Sliccy.app")
        var routeServices = SliccyAppRoute.Services()
        routeServices.validate = { SliccyApplication(url: $0, version: "7.0.0") }
        routeServices.launch = {
            opened.append($0)
            return true
        }
        routeServices.isRunning = { _ in true }
        let subject = SliccyOffer(
            defaults: defaults, osVersion: .init(majorVersion: 27, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: true,
            openURL: {
                opened.append($0)
                return true
            },
            appRoute: SliccyAppRoute(services: routeServices),
            install: { progress in
                await progress("Installing…")
                return destination
            }
        )
        XCTAssertNil(subject.installedURL)
        let task = subject.startInstallation()
        XCTAssertNotNil(task)
        XCTAssertTrue(subject.isInstalling)
        XCTAssertNil(subject.startInstallation(), "double click must not start another download")
        await task?.value
        XCTAssertFalse(subject.isInstalling)
        XCTAssertEqual(subject.installedURL, destination)
        XCTAssertTrue(subject.isDismissed)
        XCTAssertTrue(opened.isEmpty, "installation must not launch or switch apps")
        XCTAssertNil(subject.startInstallation())
        await subject.openInstalledApp()?.value
        XCTAssertEqual(opened, [destination])
        XCTAssertTrue(subject.launchSucceeded)
    }

    func testInstallFailurePreservesOfferAndCanRetry() async {
        var attempts = 0
        let subject = SliccyOffer(
            defaults: defaults, osVersion: .init(majorVersion: 27, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: true,
            openURL: { _ in
                XCTFail("must not launch")
                return false
            },
            install: { _ in
                attempts += 1
                if attempts == 1 { throw SliccyInstallError.invalidDownload }
                return URL(fileURLWithPath: "/tmp/test-only/Sliccy.app")
            }
        )
        await subject.startInstallation()?.value
        XCTAssertNotNil(subject.installError)
        XCTAssertFalse(subject.isDismissed)
        XCTAssertNil(subject.installedURL)
        await subject.startInstallation()?.value
        XCTAssertNil(subject.installError)
        XCTAssertNotNil(subject.installedURL)
    }

    func testUnsupportedMacNeverStartsInstallation() {
        XCTAssertNil(offer(major: 25).startInstallation())
        XCTAssertNil(offer(silicon: false).startInstallation())
    }

    func testCancelClearsProgressWithoutDismissingOffer() async {
        let began = expectation(description: "install started")
        let subject = SliccyOffer(
            defaults: defaults, osVersion: .init(majorVersion: 27, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: true,
            install: { _ in
                began.fulfill()
                try await Task.sleep(nanoseconds: 30_000_000_000)
                return URL(fileURLWithPath: "/tmp/test-only/Sliccy.app")
            }
        )
        let idle = ViewHosting.digest(of: SliccyOfferView(offer: subject), width: 420, height: 560)
        let task = subject.startInstallation()
        await fulfillment(of: [began], timeout: 2)
        XCTAssertNotEqual(idle, ViewHosting.digest(of: SliccyOfferView(offer: subject), width: 420, height: 560))
        subject.cancelInstallation()
        await task?.value
        XCTAssertNil(subject.installError)
        XCTAssertNil(subject.installedURL)
        XCTAssertFalse(subject.isInstalling)
        XCTAssertFalse(subject.isDismissed)
    }

}
