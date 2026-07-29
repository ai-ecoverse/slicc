import XCTest

@testable import Sliccstart

/// Migration of the legacy per-browser `autoLaunchAppId` picker into the new
/// `launchBrowserAtStartup` boolean checkbox.
final class StartupPreferenceTests: XCTestCase {

    private func makeDefaults() -> UserDefaults {
        let suite = "StartupPreferenceTests-\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: suite)!
        defaults.removePersistentDomain(forName: suite)
        return defaults
    }

    func testDefaultsToDisabledWithNoLegacyValue() {
        let defaults = makeDefaults()
        XCTAssertFalse(StartupPreference.resolveEnabled(defaults: defaults))
        XCTAssertFalse(defaults.bool(forKey: StartupPreference.enabledKey))
    }

    func testMigratesNonEmptyLegacyIdToEnabled() {
        let defaults = makeDefaults()
        defaults.set("/Applications/Google Chrome.app", forKey: autoLaunchAppIdKey)
        XCTAssertTrue(StartupPreference.resolveEnabled(defaults: defaults))
        XCTAssertTrue(defaults.bool(forKey: StartupPreference.enabledKey))
    }

    func testMigratesEmptyLegacyIdToDisabled() {
        let defaults = makeDefaults()
        defaults.set("", forKey: autoLaunchAppIdKey)
        XCTAssertFalse(StartupPreference.resolveEnabled(defaults: defaults))
    }

    func testExistingBooleanWinsOverLegacy() {
        let defaults = makeDefaults()
        defaults.set("/Applications/Google Chrome.app", forKey: autoLaunchAppIdKey)
        defaults.set(false, forKey: StartupPreference.enabledKey)
        XCTAssertFalse(StartupPreference.resolveEnabled(defaults: defaults))
    }
}
