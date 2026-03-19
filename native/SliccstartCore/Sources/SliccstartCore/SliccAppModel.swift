import Foundation

public enum SliccAppType: String, Codable, CaseIterable, Sendable {
  case browser
  case electron
}

public enum SliccCompatibilityCode: String, Codable, Sendable {
  case supported
  case missingBundleMetadata
  case missingExecutable
  case unsupportedChromiumBrowser
  case unreadableBundle
}

public struct SliccCompatibility: Codable, Equatable, Sendable {
  public static let supported = SliccCompatibility(isSupported: true, code: .supported)

  public let isSupported: Bool
  public let code: SliccCompatibilityCode
  public let reason: String?

  public init(isSupported: Bool, code: SliccCompatibilityCode, reason: String? = nil) {
    self.isSupported = isSupported
    self.code = code
    self.reason = reason
  }
}

public struct SliccDiscoveredApp: Codable, Equatable, Sendable {
  public let displayName: String
  public let bundleIdentifier: String?
  public let bundlePath: String
  public let executablePath: String?
  public let iconPath: String?
  public let type: SliccAppType
  public let compatibility: SliccCompatibility

  public var isLaunchable: Bool {
    compatibility.isSupported && executablePath != nil
  }

  public init(
    displayName: String,
    bundleIdentifier: String?,
    bundlePath: String,
    executablePath: String?,
    iconPath: String?,
    type: SliccAppType,
    compatibility: SliccCompatibility
  ) {
    self.displayName = displayName
    self.bundleIdentifier = bundleIdentifier
    self.bundlePath = bundlePath
    self.executablePath = executablePath
    self.iconPath = iconPath
    self.type = type
    self.compatibility = compatibility
  }
}

public struct SliccAppPreferences: Codable, Equatable, Sendable {
  public var preferredBundlePath: String?
  public var orderedBundlePaths: [String]
  public var manuallyAddedBundlePaths: [String]
  public var autoLaunchPreferredBrowser: Bool

  enum CodingKeys: String, CodingKey {
    case preferredBundlePath
    case orderedBundlePaths
    case manuallyAddedBundlePaths
    case autoLaunchPreferredBrowser
  }

  public init(
    preferredBundlePath: String? = nil,
    orderedBundlePaths: [String] = [],
    manuallyAddedBundlePaths: [String] = [],
    autoLaunchPreferredBrowser: Bool = false
  ) {
    self.preferredBundlePath = preferredBundlePath
    self.orderedBundlePaths = orderedBundlePaths
    self.manuallyAddedBundlePaths = manuallyAddedBundlePaths
    self.autoLaunchPreferredBrowser = autoLaunchPreferredBrowser
  }

  public init(from decoder: any Decoder) throws {
    let container = try decoder.container(keyedBy: CodingKeys.self)
    preferredBundlePath = try container.decodeIfPresent(String.self, forKey: .preferredBundlePath)
    orderedBundlePaths = try container.decodeIfPresent([String].self, forKey: .orderedBundlePaths) ?? []
    manuallyAddedBundlePaths = try container.decodeIfPresent([String].self, forKey: .manuallyAddedBundlePaths) ?? []
    autoLaunchPreferredBrowser = try container.decodeIfPresent(Bool.self, forKey: .autoLaunchPreferredBrowser) ?? false
  }

  public func encode(to encoder: any Encoder) throws {
    var container = encoder.container(keyedBy: CodingKeys.self)
    try container.encodeIfPresent(preferredBundlePath, forKey: .preferredBundlePath)
    try container.encode(orderedBundlePaths, forKey: .orderedBundlePaths)
    try container.encode(manuallyAddedBundlePaths, forKey: .manuallyAddedBundlePaths)
    try container.encode(autoLaunchPreferredBrowser, forKey: .autoLaunchPreferredBrowser)
  }
}

public enum SliccLaunchMethod: String, Equatable, Sendable {
  case directExecutable
  case openApplication
}

public struct SliccLaunchConfiguration: Equatable, Sendable {
  public let cdpPort: Int
  public let launchURL: String?
  public let userDataDirectory: String?
  public let extensionPath: String?

  public init(
    cdpPort: Int,
    launchURL: String? = nil,
    userDataDirectory: String? = nil,
    extensionPath: String? = nil
  ) {
    self.cdpPort = cdpPort
    self.launchURL = launchURL
    self.userDataDirectory = userDataDirectory
    self.extensionPath = extensionPath
  }
}

public struct SliccLaunchSpec: Equatable, Sendable {
  public let displayName: String
  public let executablePath: String
  public let arguments: [String]
  public let method: SliccLaunchMethod

  public init(displayName: String, executablePath: String, arguments: [String], method: SliccLaunchMethod) {
    self.displayName = displayName
    self.executablePath = executablePath
    self.arguments = arguments
    self.method = method
  }
}

public enum SliccLaunchError: Error, Equatable {
  case unsupportedApp(String)
  case missingExecutable(String)
  case incompleteBrowserConfiguration
}

extension SliccLaunchError: LocalizedError {
  public var errorDescription: String? {
    switch self {
    case .unsupportedApp(let name):
      return "\(name) is not compatible with SLICC launch semantics."
    case .missingExecutable(let name):
      return "\(name) is missing its app executable."
    case .incompleteBrowserConfiguration:
      return "Chromium browser launches require both a launch URL and user-data directory."
    }
  }
}