import XCTest
@testable import SliccstartCore
@testable import SliccstartDesktop

private final class RecordingLauncher: SliccAppLaunching {
  private(set) var launchedApps: [SliccDiscoveredApp] = []
  private(set) var launchConfigurations: [SliccLaunchConfiguration] = []

  func launch(_ app: SliccDiscoveredApp, configuration: SliccLaunchConfiguration) throws {
    launchedApps.append(app)
    launchConfigurations.append(configuration)
  }
}

final class SliccstartAppViewModelTests: XCTestCase {
  private var rootURL: URL!

  override func setUpWithError() throws {
    rootURL = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
      .appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: rootURL, withIntermediateDirectories: true)
  }

  override func tearDownWithError() throws {
    try? FileManager.default.removeItem(at: rootURL)
  }

  @MainActor
  func testInitialLoadAutoLaunchesFirstCompatibleAppInSavedOrder() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    let profileURL = rootURL.appendingPathComponent("BrowserProfile", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    let brave = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Brave Browser",
      bundleIdentifier: "com.brave.Browser"
    )
    let slack = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Slack",
      bundleIdentifier: "com.tinyspeck.slackmacgap",
      electronMarkers: [.appAsar, .helperApp, .electronAsarIntegrity]
    )
    let chrome = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )

    let preferencesStore = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    try preferencesStore.save(
      SliccAppPreferences(
        orderedBundlePaths: [
          brave.resolvingSymlinksInPath().path,
          slack.resolvingSymlinksInPath().path,
          chrome.resolvingSymlinksInPath().path,
        ],
        autoLaunchPreferredBrowser: true
      )
    )

    let launcher = RecordingLauncher()
    let viewModel = SliccstartAppViewModel(
      discovery: SliccAppDiscovery(searchDirectories: [appsURL.path]),
      preferencesStore: preferencesStore,
      launchService: launcher,
      runtimeConfiguration: SliccstartDesktopRuntimeConfiguration(
        serveURL: "http://localhost:5710",
        browserUserDataDirectory: profileURL.path,
        extensionPath: rootURL.appendingPathComponent("dist/extension", isDirectory: true).path
      )
    )

    viewModel.performInitialLoadIfNeeded()

    XCTAssertEqual(viewModel.apps.map(\.bundlePath), [
      brave.resolvingSymlinksInPath().path,
      slack.resolvingSymlinksInPath().path,
      chrome.resolvingSymlinksInPath().path,
    ])
    XCTAssertTrue(viewModel.autoLaunchPreferredBrowser)
    XCTAssertEqual(launcher.launchedApps.first?.bundlePath, slack.resolvingSymlinksInPath().path)
    XCTAssertEqual(launcher.launchConfigurations.first?.cdpPort, 9223)
  }

  @MainActor
  func testAddAppPersistsManualBundlePathAndVisibleDisabledState() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    let extraURL = rootURL.appendingPathComponent("ExtraApps", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)
    try FileManager.default.createDirectory(at: extraURL, withIntermediateDirectories: true)

    _ = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )
    let brave = try DesktopTestSupport.createAppBundle(
      in: extraURL,
      name: "Brave Browser",
      bundleIdentifier: "com.brave.Browser"
    )

    let preferencesStore = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    let viewModel = SliccstartAppViewModel(
      discovery: SliccAppDiscovery(searchDirectories: [appsURL.path]),
      preferencesStore: preferencesStore,
      launchService: RecordingLauncher(),
      runtimeConfiguration: SliccstartDesktopRuntimeConfiguration(
        serveURL: "http://localhost:5710",
        browserUserDataDirectory: rootURL.appendingPathComponent("BrowserProfile", isDirectory: true).path,
        extensionPath: nil
      )
    )

    viewModel.reloadCatalog()
    viewModel.addApp(bundlePath: brave.path)

    let storedPreferences = try preferencesStore.load()
    let bravePath = brave.resolvingSymlinksInPath().path
    let braveApp = try XCTUnwrap(viewModel.apps.first { $0.bundlePath == bravePath })

    XCTAssertEqual(storedPreferences.manuallyAddedBundlePaths, [bravePath])
    XCTAssertFalse(braveApp.isLaunchable)
    XCTAssertEqual(braveApp.compatibility.code, .unsupportedChromiumBrowser)
  }

  @MainActor
  func testMovePersistsUpdatedOrdering() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    let chrome = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )
    let slack = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Slack",
      bundleIdentifier: "com.tinyspeck.slackmacgap",
      electronMarkers: [.appAsar, .helperApp, .electronAsarIntegrity]
    )

    let preferencesStore = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    let viewModel = SliccstartAppViewModel(
      discovery: SliccAppDiscovery(searchDirectories: [appsURL.path]),
      preferencesStore: preferencesStore,
      launchService: RecordingLauncher(),
      runtimeConfiguration: SliccstartDesktopRuntimeConfiguration(
        serveURL: "http://localhost:5710",
        browserUserDataDirectory: rootURL.appendingPathComponent("BrowserProfile", isDirectory: true).path,
        extensionPath: nil
      )
    )

    viewModel.reloadCatalog()
    viewModel.move(bundlePath: slack.resolvingSymlinksInPath().path, before: chrome.resolvingSymlinksInPath().path)

    let storedPreferences = try preferencesStore.load()
    XCTAssertEqual(viewModel.apps.map(\.bundlePath), [
      slack.resolvingSymlinksInPath().path,
      chrome.resolvingSymlinksInPath().path,
    ])
    XCTAssertEqual(storedPreferences.orderedBundlePaths, viewModel.apps.map(\.bundlePath))
    XCTAssertEqual(storedPreferences.preferredBundlePath, slack.resolvingSymlinksInPath().path)
  }

  @MainActor
  func testSettingAutoLaunchPreferredBrowserPersistsToggle() throws {
    let appsURL = rootURL.appendingPathComponent("Applications", isDirectory: true)
    try FileManager.default.createDirectory(at: appsURL, withIntermediateDirectories: true)

    _ = try DesktopTestSupport.createAppBundle(
      in: appsURL,
      name: "Google Chrome",
      bundleIdentifier: "com.google.Chrome",
      executableName: "Google Chrome"
    )

    let preferencesStore = SliccAppPreferencesStore(fileURL: rootURL.appendingPathComponent("prefs.json"))
    let viewModel = SliccstartAppViewModel(
      discovery: SliccAppDiscovery(searchDirectories: [appsURL.path]),
      preferencesStore: preferencesStore,
      launchService: RecordingLauncher(),
      runtimeConfiguration: SliccstartDesktopRuntimeConfiguration(
        serveURL: "http://localhost:5710",
        browserUserDataDirectory: rootURL.appendingPathComponent("BrowserProfile", isDirectory: true).path,
        extensionPath: nil
      )
    )

    viewModel.reloadCatalog()
    viewModel.setAutoLaunchPreferredBrowser(true)

    XCTAssertTrue(viewModel.autoLaunchPreferredBrowser)
    XCTAssertTrue(try preferencesStore.load().autoLaunchPreferredBrowser)
  }
}