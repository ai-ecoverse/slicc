import Foundation

public final class SliccAppPreferencesStore {
  public let fileURL: URL
  private let fileManager: FileManager
  private let encoder = JSONEncoder()
  private let decoder = JSONDecoder()

  public init(fileManager: FileManager = .default) {
    self.fileURL = Self.defaultFileURL(fileManager: fileManager)
    self.fileManager = fileManager
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  }

  public init(fileURL: URL, fileManager: FileManager = .default) {
    self.fileURL = fileURL
    self.fileManager = fileManager
    encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
  }

  public static func defaultFileURL(fileManager: FileManager = .default) -> URL {
    let baseURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Library/Application Support", directoryHint: .isDirectory)
    return baseURL.appending(path: "Sliccstart/AppCatalogPreferences.json")
  }

  public func load() throws -> SliccAppPreferences {
    guard fileManager.fileExists(atPath: fileURL.path) else { return SliccAppPreferences() }
    let data = try Data(contentsOf: fileURL)
    guard !data.isEmpty else { return SliccAppPreferences() }
    return try decoder.decode(SliccAppPreferences.self, from: data)
  }

  public func save(_ preferences: SliccAppPreferences) throws {
    try fileManager.createDirectory(at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true)
    let data = try encoder.encode(preferences)
    try data.write(to: fileURL, options: .atomic)
  }

  public func normalizedPreferences(for apps: [SliccDiscoveredApp], preferences: SliccAppPreferences) -> SliccAppPreferences {
    let livePaths = Set(apps.map(\.bundlePath))
    var ordered = preferences.orderedBundlePaths.filter { livePaths.contains($0) }

    for app in apps where !ordered.contains(app.bundlePath) {
      ordered.append(app.bundlePath)
    }

    let preferred = preferences.preferredBundlePath.flatMap { livePaths.contains($0) ? $0 : nil }
    return SliccAppPreferences(preferredBundlePath: preferred, orderedBundlePaths: ordered)
  }

  public func orderedApps(_ apps: [SliccDiscoveredApp], preferences: SliccAppPreferences) -> [SliccDiscoveredApp] {
    let normalized = normalizedPreferences(for: apps, preferences: preferences)
    let order = Dictionary(uniqueKeysWithValues: normalized.orderedBundlePaths.enumerated().map { ($1, $0) })

    return apps.sorted { left, right in
      switch (order[left.bundlePath], order[right.bundlePath]) {
      case let (lhs?, rhs?):
        return lhs < rhs
      case (_?, nil):
        return true
      case (nil, _?):
        return false
      default:
        return left.displayName.localizedCaseInsensitiveCompare(right.displayName) == .orderedAscending
      }
    }
  }
}