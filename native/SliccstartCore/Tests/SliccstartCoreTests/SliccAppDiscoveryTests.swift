import XCTest
@testable import SliccstartCore

final class SliccAppDiscoveryTests: XCTestCase {
  private var rootURL: URL!

  override func setUpWithError() throws {
    rootURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: rootURL)
  }

  func testDiscoversSupportedBrowserAndElectronBundlesAcrossSearchDirectories() throws {
    let systemApps = rootURL.appendingPathComponent("Applications", isDirectory: true)
    let userApps = rootURL.appendingPathComponent("UserApplications", isDirectory: true)
    try FileManager.default.createDirectory(at: systemApps, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: userApps, withIntermediateDirectories: true)

    let chrome = try TestSupport.createAppBundle(
      in: systemApps,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )
    let slack = try TestSupport.createAppBundle(
      in: userApps,
      name: "Slack",
      bundleIdentifier: "com.tinyspeck.slackmacgap",
      electronMarkers: [.appAsar, .helperApp, .electronAsarIntegrity]
    )

    let discovery = SliccAppDiscovery(searchDirectories: [systemApps.path, userApps.path])
    let apps = try discovery.discoverApps()

    let chromeApp = try XCTUnwrap(apps.first { $0.bundlePath == chrome.resolvingSymlinksInPath().path })
    XCTAssertEqual(chromeApp.type, .browser)
    XCTAssertEqual(
      chromeApp.executablePath,
      chrome.resolvingSymlinksInPath().appendingPathComponent("Contents/MacOS/Google Chrome").path
    )
    XCTAssertEqual(chromeApp.compatibility, .supported)
    XCTAssertTrue(chromeApp.iconPath?.hasSuffix("AppIcon.icns") == true)

    let slackApp = try XCTUnwrap(apps.first { $0.bundlePath == slack.resolvingSymlinksInPath().path })
    XCTAssertEqual(slackApp.type, .electron)
    XCTAssertEqual(slackApp.compatibility, .supported)
    XCTAssertEqual(slackApp.displayName, "Slack")
  }

  func testIncludesUnsupportedChromiumBrowsersAsDisabledEntries() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    let brave = try TestSupport.createAppBundle(
      in: appsURL,
      name: "Brave Browser",
      bundleIdentifier: "com.brave.Browser"
    )

    let discovery = SliccAppDiscovery(searchDirectories: [appsURL.path])
    let apps = try discovery.discoverApps()

    let braveApp = try XCTUnwrap(apps.first { $0.bundlePath == brave.resolvingSymlinksInPath().path })
    XCTAssertEqual(braveApp.type, .browser)
    XCTAssertFalse(braveApp.compatibility.isSupported)
    XCTAssertEqual(braveApp.compatibility.code, .unsupportedChromiumBrowser)
    XCTAssertNotNil(braveApp.executablePath)
  }

  func testTreatsMicrosoftEdgeAsSupportedBrowser() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    let edge = try TestSupport.createAppBundle(
      in: appsURL,
      name: "Microsoft Edge",
      bundleIdentifier: "com.microsoft.edgemac",
      executableName: "Microsoft Edge"
    )

    let discovery = SliccAppDiscovery(searchDirectories: [appsURL.path])
    let app = try XCTUnwrap(discovery.classifyApp(at: edge.path))

    XCTAssertEqual(app.type, .browser)
    XCTAssertEqual(app.compatibility, .supported)
    XCTAssertEqual(app.executablePath, edge.resolvingSymlinksInPath().appendingPathComponent("Contents/MacOS/Microsoft Edge").path)
  }

  func testMarksKnownAppsWithoutExecutablesAsDisabled() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    let chromium = try TestSupport.createAppBundle(
      in: appsURL,
      name: "Chromium",
      bundleIdentifier: "org.chromium.Chromium",
      createExecutable: false
    )

    let discovery = SliccAppDiscovery(searchDirectories: [appsURL.path])
    let app = try XCTUnwrap(discovery.classifyApp(at: chromium.path))

    XCTAssertEqual(app.compatibility.code, .missingExecutable)
    XCTAssertFalse(app.isLaunchable)
  }

  func testDiscoverAppsIncludesAdditionalBundlePathsWithoutDuplicates() throws {
    let systemApps = rootURL.appendingPathComponent("Applications", isDirectory: true)
    let extraApps = rootURL.appendingPathComponent("ExtraApps", isDirectory: true)
    try FileManager.default.createDirectory(at: systemApps, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: extraApps, withIntermediateDirectories: true)

    let chrome = try TestSupport.createAppBundle(
      in: systemApps,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )
    let brave = try TestSupport.createAppBundle(
      in: extraApps,
      name: "Brave Browser",
      bundleIdentifier: "com.brave.Browser"
    )

    let discovery = SliccAppDiscovery(searchDirectories: [systemApps.path])
    let apps = try discovery.discoverApps(additionalBundlePaths: [brave.path, chrome.path])

    XCTAssertEqual(apps.filter { $0.bundlePath == chrome.resolvingSymlinksInPath().path }.count, 1)
    XCTAssertNotNil(apps.first { $0.bundlePath == brave.resolvingSymlinksInPath().path })
  }
}