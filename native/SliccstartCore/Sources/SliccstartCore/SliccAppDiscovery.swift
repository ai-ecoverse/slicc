import Foundation

public struct SliccAppDiscovery {
  public let searchDirectories: [String]
  private let fileManager: FileManager

  private struct BrowserDefinition {
    let bundleName: String
    let bundleIdentifier: String
  }

  private let supportedBrowsers = [
    BrowserDefinition(bundleName: "Google Chrome.app", bundleIdentifier: "com.google.Chrome"),
    BrowserDefinition(bundleName: "Google Chrome Canary.app", bundleIdentifier: "com.google.Chrome.canary"),
    BrowserDefinition(bundleName: "Microsoft Edge.app", bundleIdentifier: "com.microsoft.edgemac"),
    BrowserDefinition(bundleName: "Chromium.app", bundleIdentifier: "org.chromium.Chromium"),
  ]

  private let chromiumHints = ["chrome", "chromium", "brave", "edge", "vivaldi", "opera", "arc"]

  public init(
    searchDirectories: [String] = ["/Applications", NSString(string: NSHomeDirectory()).appendingPathComponent("Applications")],
    fileManager: FileManager = .default
  ) {
    self.searchDirectories = searchDirectories
    self.fileManager = fileManager
  }

  public func discoverApps(additionalBundlePaths: [String] = []) throws -> [SliccDiscoveredApp] {
    let bundleURLs = searchDirectories.flatMap { appBundleURLs(in: URL(fileURLWithPath: $0, isDirectory: true)) }
    var apps: [SliccDiscoveredApp] = []
    var seenBundlePaths = Set<String>()

    for bundleURL in bundleURLs {
      appendClassifiedApp(classifyApp(at: bundleURL), to: &apps, seenBundlePaths: &seenBundlePaths)
    }
    for bundlePath in additionalBundlePaths {
      appendClassifiedApp(classifyApp(at: bundlePath), to: &apps, seenBundlePaths: &seenBundlePaths)
    }

    return apps.sorted { $0.displayName.localizedCaseInsensitiveCompare($1.displayName) == .orderedAscending }
  }

  public func classifyApp(at bundlePath: String) -> SliccDiscoveredApp? {
    classifyApp(at: URL(fileURLWithPath: bundlePath, isDirectory: true))
  }

  private func appendClassifiedApp(
    _ app: SliccDiscoveredApp?,
    to apps: inout [SliccDiscoveredApp],
    seenBundlePaths: inout Set<String>
  ) {
    guard let app, seenBundlePaths.insert(app.bundlePath).inserted else { return }
    apps.append(app)
  }

  private func appBundleURLs(in directory: URL) -> [URL] {
    guard fileManager.fileExists(atPath: directory.path) else { return [] }
    var results: [URL] = []

    guard let entries = try? fileManager.contentsOfDirectory(
      at: directory,
      includingPropertiesForKeys: [.isDirectoryKey],
      options: [.skipsHiddenFiles]
    ) else {
      return []
    }

    for url in entries {
      var isDirectory: ObjCBool = false
      guard fileManager.fileExists(atPath: url.path, isDirectory: &isDirectory), isDirectory.boolValue else {
        continue
      }

      if url.pathExtension.caseInsensitiveCompare("app") == .orderedSame {
        results.append(url)
        continue
      }

      results.append(contentsOf: appBundleURLs(in: url))
    }

    return results
  }

  private func classifyApp(at bundleURL: URL) -> SliccDiscoveredApp? {
    let bundleName = bundleURL.lastPathComponent
    let info = readInfoDictionary(bundleURL)
    let displayName = resolveDisplayName(bundleURL: bundleURL, info: info)
    let bundleIdentifier = info?["CFBundleIdentifier"] as? String
    let executablePath = resolveExecutablePath(bundleURL: bundleURL, info: info)
    let iconPath = resolveIconPath(bundleURL: bundleURL, info: info, displayName: displayName)

    if isSupportedBrowser(bundleName: bundleName, bundleIdentifier: bundleIdentifier) {
      return makeApp(
        displayName: displayName,
        bundleIdentifier: bundleIdentifier,
        bundleURL: bundleURL,
        executablePath: executablePath,
        iconPath: iconPath,
        type: .browser,
        compatibility: compatibilityForKnownApp(executablePath: executablePath, displayName: displayName, info: info)
      )
    }

    if looksLikeChromiumBrowser(bundleName: bundleName, bundleIdentifier: bundleIdentifier, displayName: displayName) {
      return makeApp(
        displayName: displayName,
        bundleIdentifier: bundleIdentifier,
        bundleURL: bundleURL,
        executablePath: executablePath,
        iconPath: iconPath,
        type: .browser,
        compatibility: SliccCompatibility(
          isSupported: false,
          code: .unsupportedChromiumBrowser,
          reason: "Visible for future UI, but unsupported until TypeScript launcher semantics cover this browser."
        )
      )
    }

    if looksLikeElectronBundle(bundleURL: bundleURL, info: info, displayName: displayName) {
      return makeApp(
        displayName: displayName,
        bundleIdentifier: bundleIdentifier,
        bundleURL: bundleURL,
        executablePath: executablePath,
        iconPath: iconPath,
        type: .electron,
        compatibility: compatibilityForKnownApp(executablePath: executablePath, displayName: displayName, info: info)
      )
    }

    return nil
  }

  private func makeApp(
    displayName: String,
    bundleIdentifier: String?,
    bundleURL: URL,
    executablePath: String?,
    iconPath: String?,
    type: SliccAppType,
    compatibility: SliccCompatibility
  ) -> SliccDiscoveredApp {
    SliccDiscoveredApp(
      displayName: displayName,
      bundleIdentifier: bundleIdentifier,
      bundlePath: bundleURL.resolvingSymlinksInPath().path,
      executablePath: executablePath,
      iconPath: iconPath,
      type: type,
      compatibility: compatibility
    )
  }

  private func compatibilityForKnownApp(executablePath: String?, displayName: String, info: [String: Any]?) -> SliccCompatibility {
    if info == nil {
      return SliccCompatibility(isSupported: false, code: .missingBundleMetadata, reason: "Missing or unreadable Info.plist.")
    }
    guard executablePath != nil else {
      return SliccCompatibility(isSupported: false, code: .missingExecutable, reason: "\(displayName) has no launchable bundle executable.")
    }
    return .supported
  }

  private func readInfoDictionary(_ bundleURL: URL) -> [String: Any]? {
    let plistURL = bundleURL.appendingPathComponent("Contents/Info.plist")
    guard let data = try? Data(contentsOf: plistURL) else { return nil }
    guard let value = try? PropertyListSerialization.propertyList(from: data, format: nil) else { return nil }
    return value as? [String: Any]
  }

  private func resolveDisplayName(bundleURL: URL, info: [String: Any]?) -> String {
    if let name = info?["CFBundleDisplayName"] as? String, !name.isEmpty { return name }
    if let name = info?["CFBundleName"] as? String, !name.isEmpty { return name }
    return bundleURL.deletingPathExtension().lastPathComponent
  }

  private func resolveExecutablePath(bundleURL: URL, info: [String: Any]?) -> String? {
    let executableName = (info?["CFBundleExecutable"] as? String) ?? bundleURL.deletingPathExtension().lastPathComponent
    let executableURL = bundleURL.appendingPathComponent("Contents/MacOS/\(executableName)")
    return fileManager.fileExists(atPath: executableURL.path) ? executableURL.resolvingSymlinksInPath().path : nil
  }

  private func resolveIconPath(bundleURL: URL, info: [String: Any]?, displayName: String) -> String? {
    let resourcesURL = bundleURL.appendingPathComponent("Contents/Resources", isDirectory: true)
    var candidates: [String] = []

    if let iconFile = info?["CFBundleIconFile"] as? String { candidates.append(iconFile) }
    if let iconName = info?["CFBundleIconName"] as? String { candidates.append(iconName) }
    if let iconFiles = info?["CFBundleIconFiles"] as? [String] { candidates.append(contentsOf: iconFiles) }
    if let icons = info?["CFBundleIcons"] as? [String: Any],
       let primary = icons["CFBundlePrimaryIcon"] as? [String: Any],
       let iconFiles = primary["CFBundleIconFiles"] as? [String] {
      candidates.append(contentsOf: iconFiles)
    }
    candidates.append(contentsOf: ["AppIcon", displayName, bundleURL.deletingPathExtension().lastPathComponent])

    let normalized = Array(NSOrderedSet(array: candidates.compactMap { candidate in
      let trimmed = candidate.trimmingCharacters(in: .whitespacesAndNewlines)
      return trimmed.isEmpty ? nil : trimmed
    })) as? [String] ?? []

    for candidate in normalized {
      for fileName in [candidate, "\(candidate).icns", "\(candidate).png"] {
        let iconURL = resourcesURL.appendingPathComponent(fileName)
        if fileManager.fileExists(atPath: iconURL.path) {
          return iconURL.resolvingSymlinksInPath().path
        }
      }
    }
    return nil
  }

  private func isSupportedBrowser(bundleName: String, bundleIdentifier: String?) -> Bool {
    supportedBrowsers.contains { definition in
      definition.bundleName.caseInsensitiveCompare(bundleName) == .orderedSame
        || definition.bundleIdentifier.caseInsensitiveCompare(bundleIdentifier ?? "") == .orderedSame
    }
  }

  private func looksLikeChromiumBrowser(bundleName: String, bundleIdentifier: String?, displayName: String) -> Bool {
    let haystack = [bundleName, bundleIdentifier ?? "", displayName].joined(separator: " ").lowercased()
    return chromiumHints.contains { haystack.contains($0) }
  }

  private func looksLikeElectronBundle(bundleURL: URL, info: [String: Any]?, displayName: String) -> Bool {
    if info?["ElectronAsarIntegrity"] != nil { return true }

    let resourcesURL = bundleURL.appendingPathComponent("Contents/Resources")
    if fileManager.fileExists(atPath: resourcesURL.appendingPathComponent("app.asar").path) { return true }
    if fileManager.fileExists(atPath: resourcesURL.appendingPathComponent("default_app.asar").path) { return true }

    let frameworksURL = bundleURL.appendingPathComponent("Contents/Frameworks")
    guard let entries = try? fileManager.contentsOfDirectory(atPath: frameworksURL.path) else { return false }
    return entries.contains { entry in
      entry.localizedCaseInsensitiveContains("Electron Framework")
        || entry.localizedCaseInsensitiveContains("\(displayName) Helper")
    }
  }
}