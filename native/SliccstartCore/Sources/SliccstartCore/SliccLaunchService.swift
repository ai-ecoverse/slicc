import Foundation

public protocol SliccCommandRunning {
  func run(executablePath: String, arguments: [String]) throws
}

public protocol SliccAppLaunching {
  func launch(_ app: SliccDiscoveredApp, configuration: SliccLaunchConfiguration) throws
}

public struct FoundationCommandRunner: SliccCommandRunning {
  public init() {}

  public func run(executablePath: String, arguments: [String]) throws {
    let process = Process()
    process.executableURL = URL(fileURLWithPath: executablePath)
    process.arguments = arguments
    try process.run()
  }
}

public final class SliccLaunchService: SliccAppLaunching {
  private let runner: any SliccCommandRunning

  public init(runner: any SliccCommandRunning = FoundationCommandRunner()) {
    self.runner = runner
  }

  public func makeLaunchSpec(for app: SliccDiscoveredApp, configuration: SliccLaunchConfiguration) throws -> SliccLaunchSpec {
    guard app.compatibility.isSupported else {
      throw SliccLaunchError.unsupportedApp(app.displayName)
    }
    guard let executablePath = app.executablePath else {
      throw SliccLaunchError.missingExecutable(app.displayName)
    }

    switch app.type {
    case .browser:
      guard let launchURL = configuration.launchURL, !launchURL.isEmpty,
            let userDataDirectory = configuration.userDataDirectory, !userDataDirectory.isEmpty else {
        throw SliccLaunchError.incompleteBrowserConfiguration
      }

      var arguments = [
        "--remote-debugging-port=\(configuration.cdpPort)",
        "--no-first-run",
        "--no-default-browser-check",
        "--user-data-dir=\(userDataDirectory)",
      ]
      if let extensionPath = configuration.extensionPath, !extensionPath.isEmpty {
        arguments.append("--disable-extensions-except=\(extensionPath)")
        arguments.append("--load-extension=\(extensionPath)")
      }
      arguments.append(launchURL)

      return SliccLaunchSpec(
        displayName: app.displayName,
        executablePath: executablePath,
        arguments: arguments,
        method: .directExecutable
      )

    case .electron:
      return SliccLaunchSpec(
        displayName: app.displayName,
        executablePath: "/usr/bin/open",
        arguments: [
          "-n",
          "-a",
          app.bundlePath,
          "-W",
          "--args",
          "--remote-debugging-port=\(configuration.cdpPort)",
        ],
        method: .openApplication
      )
    }
  }

  public func launch(_ app: SliccDiscoveredApp, configuration: SliccLaunchConfiguration) throws {
    let spec = try makeLaunchSpec(for: app, configuration: configuration)
    try runner.run(executablePath: spec.executablePath, arguments: spec.arguments)
  }
}