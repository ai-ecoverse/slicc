import XCTest
@testable import SliccstartCore

final class SliccPreferencesStoreTests: XCTestCase {
  private var rootURL: URL!

  override func setUpWithError() throws {
    rootURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: rootURL)
  }

  func testPersistsPreferredBundleAndOrder() throws {
    let fileURL = rootURL.appendingPathComponent("prefs.json")
    let store = SliccAppPreferencesStore(fileURL: fileURL)
    let preferences = SliccAppPreferences(
      preferredBundlePath: "/Applications/Slack.app",
      orderedBundlePaths: ["/Applications/Slack.app", "/Applications/Google Chrome.app"],
      manuallyAddedBundlePaths: ["/Applications/Slack.app"],
      autoLaunchPreferredBrowser: true
    )

    try store.save(preferences)

    XCTAssertEqual(try store.load(), preferences)
  }

  func testOrderingUsesPersistedPathsAndAppendsNewEntries() {
    let store = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    let apps = [
      SliccDiscoveredApp(
        displayName: "Google Chrome",
        bundleIdentifier: nil,
        bundlePath: "/Applications/Google Chrome.app",
        executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        iconPath: nil,
        type: .browser,
        compatibility: .supported
      ),
      SliccDiscoveredApp(
        displayName: "Slack",
        bundleIdentifier: nil,
        bundlePath: "/Applications/Slack.app",
        executablePath: "/Applications/Slack.app/Contents/MacOS/Slack",
        iconPath: nil,
        type: .electron,
        compatibility: .supported
      ),
      SliccDiscoveredApp(
        displayName: "Chromium",
        bundleIdentifier: nil,
        bundlePath: "/Applications/Chromium.app",
        executablePath: "/Applications/Chromium.app/Contents/MacOS/Chromium",
        iconPath: nil,
        type: .browser,
        compatibility: .supported
      ),
    ]

    let normalized = store.normalizedPreferences(
      for: apps,
      preferences: SliccAppPreferences(
        preferredBundlePath: "/Applications/Slack.app",
        orderedBundlePaths: ["/Applications/Slack.app"]
      )
    )

    XCTAssertEqual(normalized.orderedBundlePaths, [
      "/Applications/Slack.app",
      "/Applications/Google Chrome.app",
      "/Applications/Chromium.app",
    ])
    XCTAssertEqual(store.orderedApps(apps, preferences: normalized).map(\.bundlePath), normalized.orderedBundlePaths)
  }

  func testPreferredLaunchableAppUsesFirstCompatibleOrderedEntry() {
    let store = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    let apps = [
      SliccDiscoveredApp(
        displayName: "Brave Browser",
        bundleIdentifier: nil,
        bundlePath: "/Applications/Brave Browser.app",
        executablePath: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
        iconPath: nil,
        type: .browser,
        compatibility: SliccCompatibility(isSupported: false, code: .unsupportedChromiumBrowser)
      ),
      SliccDiscoveredApp(
        displayName: "Slack",
        bundleIdentifier: nil,
        bundlePath: "/Applications/Slack.app",
        executablePath: "/Applications/Slack.app/Contents/MacOS/Slack",
        iconPath: nil,
        type: .electron,
        compatibility: .supported
      ),
    ]

    let preferred = store.preferredLaunchableApp(
      apps,
      preferences: SliccAppPreferences(
        preferredBundlePath: "/Applications/Slack.app",
        orderedBundlePaths: ["/Applications/Brave Browser.app", "/Applications/Slack.app"]
      )
    )

    XCTAssertEqual(preferred?.bundlePath, "/Applications/Slack.app")
  }
}