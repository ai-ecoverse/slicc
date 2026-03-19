import Combine
import Foundation
import SliccstartCore

enum SliccstartDesktopError: LocalizedError {
  case unsupportedBundle(String)

  var errorDescription: String? {
    switch self {
    case .unsupportedBundle(let path):
      return "\(URL(fileURLWithPath: path).lastPathComponent) is not a supported Chromium-family browser or Electron app bundle."
    }
  }
}

@MainActor
public final class SliccstartAppViewModel: ObservableObject {
  @Published public private(set) var apps: [SliccDiscoveredApp] = []
  @Published public private(set) var autoLaunchPreferredBrowser = false
  @Published public private(set) var errorMessage: String?

  private let discovery: SliccAppDiscovery
  private let preferencesStore: SliccAppPreferencesStore
  private let launchService: any SliccAppLaunching
  private let runtimeConfiguration: SliccstartDesktopRuntimeConfiguration
  private let fileManager: FileManager

  private var preferences = SliccAppPreferences()
  private var hasLoaded = false

  public init(
    discovery: SliccAppDiscovery = SliccAppDiscovery(),
    preferencesStore: SliccAppPreferencesStore = SliccAppPreferencesStore(),
    launchService: any SliccAppLaunching = SliccLaunchService(),
    runtimeConfiguration: SliccstartDesktopRuntimeConfiguration = .current(),
    fileManager: FileManager = .default
  ) {
    self.discovery = discovery
    self.preferencesStore = preferencesStore
    self.launchService = launchService
    self.runtimeConfiguration = runtimeConfiguration
    self.fileManager = fileManager
  }

  public func performInitialLoadIfNeeded() {
    guard !hasLoaded else { return }
    hasLoaded = true
    reloadCatalog(performAutoLaunch: true)
  }

  public func reloadCatalog(performAutoLaunch: Bool = false) {
    do {
      var loadedPreferences = try preferencesStore.load()
      let discoveredApps = try discovery.discoverApps(additionalBundlePaths: loadedPreferences.manuallyAddedBundlePaths)
      loadedPreferences = preferencesStore.normalizedPreferences(for: discoveredApps, preferences: loadedPreferences)

      let orderedApps = preferencesStore.orderedApps(discoveredApps, preferences: loadedPreferences)
      loadedPreferences.preferredBundlePath = orderedApps.first(where: \.isLaunchable)?.bundlePath

      try preferencesStore.save(loadedPreferences)

      preferences = loadedPreferences
      apps = orderedApps
      autoLaunchPreferredBrowser = loadedPreferences.autoLaunchPreferredBrowser
      clearError()

      if performAutoLaunch && loadedPreferences.autoLaunchPreferredBrowser {
        launchPreferredApp()
      }
    } catch {
      present(error)
    }
  }

  public func addApp(bundlePath: String) {
    do {
      guard let app = discovery.classifyApp(at: bundlePath) else {
        throw SliccstartDesktopError.unsupportedBundle(bundlePath)
      }

      preferences.manuallyAddedBundlePaths = uniqueBundlePaths(preferences.manuallyAddedBundlePaths + [app.bundlePath])
      preferences.orderedBundlePaths = uniqueBundlePaths(apps.map(\.bundlePath) + [app.bundlePath])
      try preferencesStore.save(preferences)

      reloadCatalog()
    } catch {
      present(error)
    }
  }

  public func move(bundlePath: String, before destinationBundlePath: String?) {
    guard let sourceIndex = apps.firstIndex(where: { $0.bundlePath == bundlePath }) else { return }

    var reorderedApps = apps
    let movedApp = reorderedApps.remove(at: sourceIndex)
    let destinationIndex = destinationBundlePath.flatMap { targetPath in
      reorderedApps.firstIndex(where: { $0.bundlePath == targetPath })
    } ?? reorderedApps.endIndex

    reorderedApps.insert(movedApp, at: destinationIndex)
    guard reorderedApps.map(\.bundlePath) != apps.map(\.bundlePath) else { return }

    apps = reorderedApps
    preferences.orderedBundlePaths = reorderedApps.map(\.bundlePath)
    preferences.preferredBundlePath = reorderedApps.first(where: \.isLaunchable)?.bundlePath
    persistPreferences()
  }

  public func setAutoLaunchPreferredBrowser(_ isEnabled: Bool) {
    autoLaunchPreferredBrowser = isEnabled
    preferences.autoLaunchPreferredBrowser = isEnabled
    persistPreferences()
  }

  public func launch(_ app: SliccDiscoveredApp) {
    guard app.isLaunchable else { return }

    do {
      if app.type == .browser {
        let userDataDirectory = URL(fileURLWithPath: runtimeConfiguration.browserUserDataDirectory, isDirectory: true)
        try fileManager.createDirectory(at: userDataDirectory, withIntermediateDirectories: true)
      }

      try launchService.launch(app, configuration: runtimeConfiguration.launchConfiguration(for: app))
      clearError()
    } catch {
      present(error)
    }
  }

  public func launchPreferredApp() {
    guard let preferredApp = preferencesStore.preferredLaunchableApp(apps, preferences: preferences) else { return }
    launch(preferredApp)
  }

  public func clearError() {
    errorMessage = nil
  }

  private func persistPreferences() {
    do {
      try preferencesStore.save(preferences)
      clearError()
    } catch {
      present(error)
    }
  }

  private func present(_ error: any Error) {
    errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
  }

  private func uniqueBundlePaths(_ bundlePaths: [String]) -> [String] {
    var seen = Set<String>()
    return bundlePaths.filter { seen.insert($0).inserted }
  }
}