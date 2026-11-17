import SwiftUI
import XCTest

@testable import Sliccstart

@MainActor
final class SliccyInstalledOfferTests: XCTestCase {
    private var suite: String!
    private var defaults: UserDefaults!
    private let sliccy = URL(fileURLWithPath: "/Applications/Sliccy.app")
    private let old = URL(fileURLWithPath: "/Applications/Sliccstart.app")
    private var installed = true
    private var valid = true
    private var running = true
    private var launchWorks = true
    private var opened: [URL] = []
    private var revealed: [URL] = []
    private var notes: [URL] = []

    override func setUp() async throws {
        suite = "sliccy-installed-offer.\(UUID().uuidString)"
        defaults = UserDefaults(suiteName: suite)!
        installed = true
        valid = true
        running = true
        launchWorks = true
        opened = []
        revealed = []
    }

    override func tearDown() async throws { defaults.removePersistentDomain(forName: suite) }

    private func offer(supported: Bool = true) -> SliccyOffer {
        var service = SliccyAppRoute.Services()
        service.discover = { [self] in installed ? [sliccy] : [] }
        service.exists = { [self] _ in installed }
        service.validate = { [self] url in
            guard valid else { throw SliccyRouteError.unsuitableApp }
            return SliccyApplication(url: url, version: "7.4.0")
        }
        service.launch = { [self] url in
            opened.append(url)
            return launchWorks
        }
        service.isRunning = { [self] _ in running }
        service.removalContext = { [self] in
            .init(url: old, bundleIdentifier: "com.slicc.sliccstart", isDirectory: true, isReadOnly: false, isWritable: true, isDevelopment: false)
        }
        service.validateOldApp = { _ in }
        service.reveal = { [self] url in
            revealed.append(url)
            return true
        }
        return SliccyOffer(
            defaults: defaults, osVersion: .init(majorVersion: supported ? 26 : 25, minorVersion: 0, patchVersion: 0),
            isAppleSilicon: true,
            openURL: { [self] url in
                notes.append(url)
                return true
            }, appRoute: SliccyAppRoute(services: service),
            install: { _ in
                XCTFail("must not install over a discovered app")
                throw SliccyInstallError.invalidDownload
            }
        )
    }

    func testDiscoveryReplacesDownloadWithInstalledAppWithoutLaunching() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        XCTAssertEqual(subject.installedURL, sliccy)
        XCTAssertEqual(subject.installedVersion, "7.4.0")
        XCTAssertNil(subject.startInstallation())
        XCTAssertFalse(subject.launchSucceeded)
        XCTAssertTrue(opened.isEmpty)
        XCTAssertTrue(revealed.isEmpty)
        XCTAssertTrue(subject.shouldShowBanner)
    }

    func testMissingTargetRetainsDownloadAndInvalidTargetBlocksActions() async {
        installed = false
        let missing = offer()
        await missing.refreshInstalledApp()
        XCTAssertNil(missing.installedURL)
        XCTAssertNil(missing.discoveryError)
        installed = true
        valid = false
        let invalid = offer()
        await invalid.refreshInstalledApp()
        XCTAssertNotNil(invalid.discoveryError)
        XCTAssertNil(invalid.installedURL)
        XCTAssertNil(invalid.openInstalledApp())
        XCTAssertNil(invalid.startInstallation())
        XCTAssertTrue(opened.isEmpty)
    }

    func testRemovedTargetRestoresMissingAppOfferOnFirstRefresh() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        installed = false
        await subject.refreshInstalledApp()
        XCTAssertNil(subject.installedURL)
        XCTAssertNil(subject.discoveryError)
        XCTAssertFalse(subject.launchSucceeded)
        XCTAssertTrue(opened.isEmpty)
    }

    func testReleaseNotesFollowTheValidatedInstalledVersion() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        subject.openReleases()
        XCTAssertEqual(notes.map(\.absoluteString), ["https://github.com/ai-ecoverse/sliccy-app/releases/tag/v7.4.0"])
        XCTAssertTrue(opened.isEmpty)
    }

    func testKeepUsingAndSettingsPreserveDismissalAfterDiscovery() async {
        let subject = offer()
        subject.setDismissed(true)
        await subject.refreshInstalledApp()
        XCTAssertFalse(subject.shouldShowBanner)
        XCTAssertEqual(subject.installedURL, sliccy)
        XCTAssertTrue(opened.isEmpty)
        XCTAssertTrue(offer().isDismissed)
    }

    func testRemovalBeforeLaunchAndFailedLaunchNeverReveal() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        await subject.revealSliccstartForRemoval()
        XCTAssertNotNil(subject.routeError)
        XCTAssertTrue(revealed.isEmpty)
        launchWorks = false
        await subject.openInstalledApp()?.value
        XCTAssertFalse(subject.launchSucceeded)
        XCTAssertNotNil(subject.routeError)
        await subject.revealSliccstartForRemoval()
        XCTAssertTrue(revealed.isEmpty)
    }

    func testExplicitOpenThenConfirmedRemovalOnlySelectsRunningOldApp() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        await subject.openInstalledApp()?.value
        XCTAssertTrue(subject.launchSucceeded)
        XCTAssertEqual(opened, [sliccy])
        XCTAssertTrue(revealed.isEmpty, "cancelling/not confirming removal must have no side effect")
        await subject.revealSliccstartForRemoval()
        XCTAssertEqual(revealed, [old])
        XCTAssertTrue(subject.removalInstruction?.contains("Quit Sliccstart yourself") == true)
        XCTAssertTrue(subject.removalInstruction?.contains("Default-browser settings are unchanged") == true)
    }

    func testMissingOrExitedTargetCannotCompleteRemoval() async {
        let subject = offer()
        await subject.refreshInstalledApp()
        await subject.openInstalledApp()?.value
        running = false
        await subject.revealSliccstartForRemoval()
        XCTAssertNotNil(subject.routeError)
        XCTAssertNil(subject.removalInstruction)
        XCTAssertTrue(revealed.isEmpty)
        valid = false
        await subject.refreshInstalledApp()
        XCTAssertFalse(subject.launchSucceeded)
        XCTAssertNil(subject.installedURL)
    }

    func testUnsupportedHostNeverDiscoversLaunchesOrReveals() async {
        let subject = offer(supported: false)
        await subject.refreshInstalledApp()
        XCTAssertNil(subject.installedURL)
        XCTAssertNil(subject.openInstalledApp())
        await subject.revealSliccstartForRemoval()
        XCTAssertTrue(opened.isEmpty)
        XCTAssertTrue(revealed.isEmpty)
    }

    func testInstalledBannerAndRemovalOptionRenderDifferently() async {
        let subject = offer()
        let missing = ViewHosting.digest(of: SliccyOfferBanner(offer: subject), width: 340, height: 180)
        await subject.refreshInstalledApp()
        XCTAssertNotEqual(missing, ViewHosting.digest(of: SliccyOfferBanner(offer: subject), width: 340, height: 180))
        let unlaunched = ViewHosting.digest(of: SliccyOfferView(offer: subject), width: 420, height: 640)
        await subject.openInstalledApp()?.value
        XCTAssertNotEqual(unlaunched, ViewHosting.digest(of: SliccyOfferView(offer: subject), width: 420, height: 640))
    }
}
