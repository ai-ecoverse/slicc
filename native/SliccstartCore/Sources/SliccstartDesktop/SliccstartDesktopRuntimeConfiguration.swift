import Foundation
import SliccstartCore

public struct SliccstartDesktopRuntimeConfiguration: Equatable, Sendable {
  public let serveURL: String
  public let browserCDPPort: Int
  public let electronCDPPort: Int
  public let browserUserDataDirectory: String
  public let extensionPath: String?

  public init(
    serveURL: String,
    browserCDPPort: Int = 9222,
    electronCDPPort: Int = 9223,
    browserUserDataDirectory: String,
    extensionPath: String?
  ) {
    self.serveURL = serveURL
    self.browserCDPPort = browserCDPPort
    self.electronCDPPort = electronCDPPort
    self.browserUserDataDirectory = browserUserDataDirectory
    self.extensionPath = extensionPath
  }

  public static func current(
    environment: [String: String] = ProcessInfo.processInfo.environment,
    fileManager: FileManager = .default,
    workingDirectory: String = FileManager.default.currentDirectoryPath
  ) -> Self {
    let applicationSupportURL = fileManager.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
      ?? URL(fileURLWithPath: NSHomeDirectory()).appending(path: "Library/Application Support", directoryHint: .isDirectory)
    let browserUserDataDirectory = applicationSupportURL
      .appendingPathComponent("Sliccstart", isDirectory: true)
      .appendingPathComponent("BrowserProfile", isDirectory: true)
      .path(percentEncoded: false)
    let servePort = Int(environment["PORT"] ?? "") ?? 5710

    return Self(
      serveURL: "http://localhost:\(servePort)",
      browserUserDataDirectory: browserUserDataDirectory,
      extensionPath: resolveExtensionPath(environment: environment, fileManager: fileManager, workingDirectory: workingDirectory)
    )
  }

  public func launchConfiguration(for app: SliccDiscoveredApp) -> SliccLaunchConfiguration {
    switch app.type {
    case .browser:
      return SliccLaunchConfiguration(
        cdpPort: browserCDPPort,
        launchURL: serveURL,
        userDataDirectory: browserUserDataDirectory,
        extensionPath: extensionPath
      )
    case .electron:
      return SliccLaunchConfiguration(cdpPort: electronCDPPort)
    }
  }

  private static func resolveExtensionPath(
    environment: [String: String],
    fileManager: FileManager,
    workingDirectory: String
  ) -> String? {
    let candidates = [
      environment["SLICC_EXTENSION_PATH"],
      URL(fileURLWithPath: workingDirectory, isDirectory: true)
        .appendingPathComponent("dist", isDirectory: true)
        .appendingPathComponent("extension", isDirectory: true)
        .path(percentEncoded: false),
      URL(fileURLWithPath: workingDirectory, isDirectory: true)
        .appendingPathComponent("..", isDirectory: true)
        .appendingPathComponent("dist", isDirectory: true)
        .appendingPathComponent("extension", isDirectory: true)
        .standardizedFileURL.path(percentEncoded: false),
      URL(fileURLWithPath: workingDirectory, isDirectory: true)
        .appendingPathComponent("..", isDirectory: true)
        .appendingPathComponent("..", isDirectory: true)
        .appendingPathComponent("dist", isDirectory: true)
        .appendingPathComponent("extension", isDirectory: true)
        .standardizedFileURL.path(percentEncoded: false),
    ].compactMap { $0 }

    for candidate in candidates {
      var isDirectory: ObjCBool = false
      if fileManager.fileExists(atPath: candidate, isDirectory: &isDirectory), isDirectory.boolValue {
        return URL(fileURLWithPath: candidate).resolvingSymlinksInPath().path
      }
    }

    return nil
  }
}