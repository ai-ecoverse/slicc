import XCTest
@testable import SliccstartCore

private final class RecordingRunner: SliccCommandRunning {
  private(set) var executablePath: String?
  private(set) var arguments: [String] = []

  func run(executablePath: String, arguments: [String]) throws {
    self.executablePath = executablePath
    self.arguments = arguments
  }
}

final class SliccLaunchServiceTests: XCTestCase {
  func testBuildsMicrosoftEdgeLaunchSpecWithTypeScriptParityFlags() throws {
    let service = SliccLaunchService(runner: RecordingRunner())
    let app = SliccDiscoveredApp(
      displayName: "Microsoft Edge",
      bundleIdentifier: "com.microsoft.edgemac",
      bundlePath: "/Applications/Microsoft Edge.app",
      executablePath: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      iconPath: nil,
      type: .browser,
      compatibility: .supported
    )

    let spec = try service.makeLaunchSpec(
      for: app,
      configuration: SliccLaunchConfiguration(
        cdpPort: 9222,
        launchURL: "http://localhost:5710",
        userDataDirectory: "/tmp/browser-coding-agent-chrome",
        extensionPath: "/repo/dist/extension"
      )
    )

    XCTAssertEqual(spec.method, .directExecutable)
    XCTAssertEqual(spec.executablePath, "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
    XCTAssertEqual(spec.arguments, [
      "--remote-debugging-port=9222",
      "--no-first-run",
      "--no-default-browser-check",
      "--user-data-dir=/tmp/browser-coding-agent-chrome",
      "--disable-extensions-except=/repo/dist/extension",
      "--load-extension=/repo/dist/extension",
      "http://localhost:5710",
    ])
  }

  func testBuildsElectronLaunchSpecUsingMacOpenSemantics() throws {
    let service = SliccLaunchService(runner: RecordingRunner())
    let app = SliccDiscoveredApp(
      displayName: "Slack",
      bundleIdentifier: "com.tinyspeck.slackmacgap",
      bundlePath: "/Applications/Slack.app",
      executablePath: "/Applications/Slack.app/Contents/MacOS/Slack",
      iconPath: nil,
      type: .electron,
      compatibility: .supported
    )

    let spec = try service.makeLaunchSpec(
      for: app,
      configuration: SliccLaunchConfiguration(cdpPort: 9223)
    )

    XCTAssertEqual(spec.method, .openApplication)
    XCTAssertEqual(spec.executablePath, "/usr/bin/open")
    XCTAssertEqual(spec.arguments, [
      "-n",
      "-a",
      "/Applications/Slack.app",
      "-W",
      "--args",
      "--remote-debugging-port=9223",
    ])
  }

  func testLaunchPassesModeledCommandToRunner() throws {
    let runner = RecordingRunner()
    let service = SliccLaunchService(runner: runner)
    let app = SliccDiscoveredApp(
      displayName: "Slack",
      bundleIdentifier: "com.tinyspeck.slackmacgap",
      bundlePath: "/Applications/Slack.app",
      executablePath: "/Applications/Slack.app/Contents/MacOS/Slack",
      iconPath: nil,
      type: .electron,
      compatibility: .supported
    )

    try service.launch(app, configuration: SliccLaunchConfiguration(cdpPort: 9333))

    XCTAssertEqual(runner.executablePath, "/usr/bin/open")
    XCTAssertEqual(runner.arguments.last, "--remote-debugging-port=9333")
  }
}