import Foundation
import XCTest

@testable import Sliccstart

final class StartupLocationTests: XCTestCase {

    private func defaults(enabled: Bool?) -> UserDefaults {
        let suite = UserDefaults(suiteName: "sliccstart.tests.startup.\(UUID().uuidString)")!
        if let enabled { suite.set(enabled, forKey: StartupPreference.enabledKey) }
        return suite
    }

    private func removeSuite(_ defaults: UserDefaults) {
        for key in defaults.dictionaryRepresentation().keys where key.hasPrefix("launchBrowser") {
            defaults.removeObject(forKey: key)
        }
    }

    func testAnAppInApplicationsCountsAsInstalled() {
        XCTAssertTrue(
            StartupPreference.isInstalledLocation(bundlePath: "/Applications/Sliccstart.app")
        )
        XCTAssertTrue(
            StartupPreference.isInstalledLocation(
                bundlePath: "/Applications/Utilities/Sliccstart.app"
            )
        )
    }

    func testAnAppInTheUsersOwnApplicationsFolderCountsAsInstalled() {
        let path = (NSHomeDirectory() as NSString)
            .appendingPathComponent("Applications/Sliccstart.app")
        XCTAssertTrue(StartupPreference.isInstalledLocation(bundlePath: path))
    }

    func testADeveloperOrCiBuildDoesNotCountAsInstalled() {

        XCTAssertFalse(
            StartupPreference.isInstalledLocation(
                bundlePath: "/Users/dev/slicc/packages/swift-launcher/build/Sliccstart.app"
            )
        )
        XCTAssertFalse(
            StartupPreference.isInstalledLocation(
                bundlePath: "/Users/dev/Library/Developer/Xcode/DerivedData/x/Sliccstart.app"
            )
        )
    }

    func testADownloadedOrTranslocatedCopyDoesNotCountAsInstalled() {
        XCTAssertFalse(
            StartupPreference.isInstalledLocation(bundlePath: "/Users/dev/Downloads/Sliccstart.app")
        )

        XCTAssertFalse(
            StartupPreference.isInstalledLocation(
                bundlePath:
                    "/private/var/folders/ab/T/AppTranslocation/1234-5678/d/Sliccstart.app"
            )
        )
    }

    func testAPathThatMerelyStartsWithApplicationsIsNotInstalled() {

        XCTAssertFalse(
            StartupPreference.isInstalledLocation(bundlePath: "/ApplicationsOld/Sliccstart.app")
        )
        XCTAssertFalse(
            StartupPreference.isInstalledLocation(bundlePath: "/Applications.bak/Sliccstart.app")
        )
    }

    func testRelativeAndTrailingPathsAreStandardizedFirst() {
        XCTAssertTrue(
            StartupPreference.isInstalledLocation(
                bundlePath: "/Applications/./Sliccstart.app"
            )
        )
        XCTAssertTrue(
            StartupPreference.isInstalledLocation(
                bundlePath: "/Applications/Utilities/../Sliccstart.app"
            )
        )
    }

    func testBothHalvesAreRequiredToAutoLaunch() {
        let on = defaults(enabled: true)
        let off = defaults(enabled: false)
        defer {
            removeSuite(on)
            removeSuite(off)
        }

        XCTAssertTrue(
            StartupPreference.shouldAutoLaunch(
                defaults: on,
                bundlePath: "/Applications/Sliccstart.app"
            )
        )
        XCTAssertFalse(
            StartupPreference.shouldAutoLaunch(
                defaults: on,
                bundlePath: "/Users/dev/slicc/packages/swift-launcher/build/Sliccstart.app"
            ),
            "an uninstalled copy must not auto-launch even with the preference on"
        )
        XCTAssertFalse(
            StartupPreference.shouldAutoLaunch(
                defaults: off,
                bundlePath: "/Applications/Sliccstart.app"
            )
        )
    }

    func testTheLocationGateDoesNotClearTheUsersPreference() {
        let suite = defaults(enabled: true)
        defer { removeSuite(suite) }

        _ = StartupPreference.shouldAutoLaunch(
            defaults: suite,
            bundlePath: "/Users/dev/Downloads/Sliccstart.app"
        )

        XCTAssertTrue(
            StartupPreference.resolveEnabled(defaults: suite),
            "the checkbox must keep its value and take effect once the app is moved"
        )
    }

    func testTheLegacyMigrationStillRunsForAnUninstalledCopy() {

        let suite = UserDefaults(suiteName: "sliccstart.tests.startup.\(UUID().uuidString)")!
        suite.set("/Applications/Google Chrome.app", forKey: autoLaunchAppIdKey)
        defer {
            suite.removeObject(forKey: autoLaunchAppIdKey)
            suite.removeObject(forKey: StartupPreference.enabledKey)
        }

        XCTAssertFalse(
            StartupPreference.shouldAutoLaunch(
                defaults: suite,
                bundlePath: "/Users/dev/Downloads/Sliccstart.app"
            )
        )
        XCTAssertEqual(
            suite.object(forKey: StartupPreference.enabledKey) as? Bool,
            true,
            "the legacy picker still migrates to the new key"
        )
    }

    func testTheStartupCaptionExplainsWhyAnUninstalledBuildWillNotAutoLaunch() {
        let installed = StartupSettingsView.launchCaption(isInstalled: true)
        let notInstalled = StartupSettingsView.launchCaption(isInstalled: false)

        XCTAssertFalse(installed.contains("Applications folder"))
        XCTAssertTrue(notInstalled.contains("will not auto-launch"))
        XCTAssertTrue(
            notInstalled.hasPrefix(installed),
            "the explanation is added to the normal caption, not swapped for it"
        )
    }
}
