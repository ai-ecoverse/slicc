import Foundation

public struct SliccstartAppBundleDescriptor: Sendable, Equatable {
  public var bundleName: String
  public var displayName: String
  public var executableName: String
  public var bundleIdentifier: String
  public var shortVersion: String
  public var bundleVersion: String
  public var minimumSystemVersion: String

  public init(
    bundleName: String = "Sliccstart",
    displayName: String = "Sliccstart",
    executableName: String = "SliccstartApp",
    bundleIdentifier: String = "dev.intent.sliccstart",
    shortVersion: String = "0.1.0",
    bundleVersion: String = "1",
    minimumSystemVersion: String = "13.0"
  ) {
    self.bundleName = bundleName
    self.displayName = displayName
    self.executableName = executableName
    self.bundleIdentifier = bundleIdentifier
    self.shortVersion = shortVersion
    self.bundleVersion = bundleVersion
    self.minimumSystemVersion = minimumSystemVersion
  }

  public var bundleDirectoryName: String {
    "\(bundleName).app"
  }

  public var infoDictionary: [String: Any] {
    [
      "CFBundleDevelopmentRegion": "en",
      "CFBundleDisplayName": displayName,
      "CFBundleExecutable": executableName,
      "CFBundleIdentifier": bundleIdentifier,
      "CFBundleInfoDictionaryVersion": "6.0",
      "CFBundleName": bundleName,
      "CFBundlePackageType": "APPL",
      "CFBundleShortVersionString": shortVersion,
      "CFBundleVersion": bundleVersion,
      "LSMinimumSystemVersion": minimumSystemVersion,
      "NSHighResolutionCapable": true,
      "NSPrincipalClass": "NSApplication",
    ]
  }
}

public enum SliccstartAppBundleBuilderError: LocalizedError {
  case missingExecutable(URL)

  public var errorDescription: String? {
    switch self {
    case .missingExecutable(let executableURL):
      return "Sliccstart executable not found at \(executableURL.path). Build SliccstartApp first."
    }
  }
}

public struct SliccstartAppBundleBuilder {
  public let descriptor: SliccstartAppBundleDescriptor
  private let fileManager: FileManager

  public init(
    descriptor: SliccstartAppBundleDescriptor = SliccstartAppBundleDescriptor(),
    fileManager: FileManager = .default
  ) {
    self.descriptor = descriptor
    self.fileManager = fileManager
  }

  @discardableResult
  public func createBundle(executableURL: URL, outputDirectoryURL: URL) throws -> URL {
    guard fileManager.fileExists(atPath: executableURL.path) else {
      throw SliccstartAppBundleBuilderError.missingExecutable(executableURL)
    }

    let bundleURL = outputDirectoryURL.appendingPathComponent(descriptor.bundleDirectoryName, isDirectory: true)
    let contentsURL = bundleURL.appendingPathComponent("Contents", isDirectory: true)
    let macOSURL = contentsURL.appendingPathComponent("MacOS", isDirectory: true)
    let plistURL = contentsURL.appendingPathComponent("Info.plist")
    let bundledExecutableURL = macOSURL.appendingPathComponent(descriptor.executableName)

    if fileManager.fileExists(atPath: bundleURL.path) {
      try fileManager.removeItem(at: bundleURL)
    }

    try fileManager.createDirectory(at: macOSURL, withIntermediateDirectories: true)
    try fileManager.copyItem(at: executableURL, to: bundledExecutableURL)
    try fileManager.setAttributes([.posixPermissions: 0o755], ofItemAtPath: bundledExecutableURL.path)

    let plistData = try PropertyListSerialization.data(
      fromPropertyList: descriptor.infoDictionary,
      format: .xml,
      options: 0
    )
    try plistData.write(to: plistURL, options: .atomic)

    return bundleURL
  }
}