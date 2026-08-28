import Foundation
import XCTest

@testable import Sliccstart

/// Auto-launch is gated on the app living in an Applications folder.
///
/// A startup behavior belongs to the copy the user installed, not to every
/// copy that happens to run: a build out of `packages/swift-launcher/build/`,
/// a `.zip` opened from `~/Downloads`, or Gatekeeper's translocated read-only
/// copy would each otherwise start a browser session and take over the screen.
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

    // MARK: - Location

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
        // The case that found this: a test run of the launcher would have
        // opened a real browser session on the developer's machine.
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
        // Gatekeeper's randomized read-only copy of a quarantined app.
        XCTAssertFalse(
            StartupPreference.isInstalledLocation(
                bundlePath:
                    "/private/var/folders/ab/T/AppTranslocation/1234-5678/d/Sliccstart.app"
            )
        )
    }

    func testAPathThatMerelyStartsWithApplicationsIsNotInstalled() {
        // Prefix matching has to respect the component boundary, or
        // `/ApplicationsOld` would smuggle a copy past the gate.
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

    // MARK: - The gate

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
        // `resolveEnabled` persists the migrated value; short-circuiting the
        // gate on location first would leave a legacy user unmigrated.
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

    // MARK: - What Settings says about it

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
